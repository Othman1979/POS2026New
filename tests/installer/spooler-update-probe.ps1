[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script = Join-Path $repo 'deployment\windows\Update-Spooler.ps1'
if (-not (Test-Path -LiteralPath $script)) { throw 'Spooler updater script is missing.' }
$source = Get-Content -Raw -LiteralPath $script
foreach ($required in @('preflight', 'stop spooler', 'replace application', 'start spooler', 'runtime_transition_required', 'Assert-EnvUnchanged', 'Assert-SpoolerPayloadHash', 'runtimeSha256')) {
    if ($source -notmatch [regex]::Escape($required)) { throw "Spooler updater is missing direct update contract: $required" }
}
foreach ($required in @('Win32_Service', 'AppDirectory', 'AppParameters', 'SPOOLER_STATE_DIR', 'SPOOLER_LOG_DIR', 'Get-RegisteredExecutablePath', 'Test-SamePath')) {
    if ($source -notmatch [regex]::Escape($required)) { throw "Spooler updater is missing ownership/config validation: $required" }
}
foreach ($forbidden in @('update-transaction.json', 'SpoolerTransactionJournal', 'Repair-SpoolerStartup.ps1', 'SpoolerLayerState.ps1', 'InstallerUpdateState.ps1')) {
    if ($source -match [regex]::Escape($forbidden)) { throw "Spooler updater retained transaction machinery: $forbidden" }
}
if ($source -match '-match \[regex\]::Escape\(\$nssm') { throw 'Spooler updater uses substring NSSM ownership matching.' }
if ($source -notmatch 'Get-RegisteredExecutablePath[\s\S]{0,250}runtime\\nssm\\nssm\.exe') { throw 'Spooler updater does not pin service ownership to the packaged NSSM executable.' }
foreach ($forbidden in @('Install-NssmBinary', 'New-Service', 'sc.exe.*install', 'SPOOLER_KEY=')) {
    if ($source -match $forbidden) { throw "Spooler updater contains forbidden mutation token: $forbidden" }
}
function Convert-UpdaterOutputToResult([object[]]$Lines) {
    $jsonLines = @($Lines | ForEach-Object { [string]$_ } | Where-Object { $_ -and $_ -notlike 'POSAPP_PROGRESS|*' })
    if ($jsonLines.Count -eq 0) { throw 'Expected one updater JSON result after filtering progress records; found none.' }
    try { return (($jsonLines -join "`n") | ConvertFrom-Json) }
    catch { throw "Updater JSON result is invalid or contains multiple records: $($_.Exception.Message)" }
}
function Get-BytesHash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Invoke-SpoolerWhatIf([string]$Payload, [string]$ProgramFiles, [string]$ProgramData, [string]$Mode = 'Core') {
    $output = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $script -Mode $Mode -PayloadRoot $Payload -ProgramFilesRoot $ProgramFiles -ProgramDataRoot $ProgramData -WhatIf)
    return [pscustomobject]@{ output = $output; result = Convert-UpdaterOutputToResult $output }
}

$work = Join-Path ([IO.Path]::GetTempPath()) "pos-spooler-layer-probe-$PID"
if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
try {
    $programFiles = Join-Path $work 'program-files'
    $programData = Join-Path $work 'program-data'
    $payload = Join-Path $work 'payload'
    $coreStage = Join-Path $repo 'deployment\out\stage\spooler-update-core'
    $runtimeStage = Join-Path $repo 'deployment\out\stage\spooler-update-runtime'
    if (-not (Test-Path -LiteralPath (Join-Path $coreStage 'release.json')) -or -not (Test-Path -LiteralPath (Join-Path $runtimeStage 'release.json'))) {
        throw 'Run scripts/build-installers.ps1 -StageOnly before the spooler update probe.'
    }
    Copy-Item -LiteralPath $coreStage -Destination $payload -Recurse -Force
    New-Item -ItemType Directory -Force -Path $programFiles, (Join-Path $programData 'config'), (Join-Path $programData 'state'), (Join-Path $programData 'logs') | Out-Null
    $envPath = Join-Path $programData 'config\spooler.env'
    $envText = "# customer setting`r`nCUSTOM_FLAG=keep-me`r`nSPOOLER_NAME=Counter A`r`nSPOOLER_ID=station-a`r`nSPOOLER_KEY=secret-key`r`nCLOUD_SERVER_URL=https://hashemi.shawermajwana.com`r`nSPOOLER_LOG_DIR=$(Join-Path $programData 'logs')`r`nSPOOLER_STATE_DIR=$(Join-Path $programData 'state')"
    [IO.File]::WriteAllText($envPath, $envText, [Text.UTF8Encoding]::new($false))
    $beforeEnvHash = Get-BytesHash $envPath
    Set-Content -LiteralPath (Join-Path $programFiles 'package.json') -Value (@{ version='1.2.0' } | ConvertTo-Json) -NoNewline
    $coreRelease = Get-Content -Raw -LiteralPath (Join-Path $payload 'release.json') | ConvertFrom-Json
    Set-Content -LiteralPath (Join-Path $programFiles 'release.json') -Value (@{ version='1.0.0'; commit=('a' * 40); schemaVersion='baseline'; spoolerVersion='1.2.0'; runtimeSha256=[string]$coreRelease.runtimeSha256 } | ConvertTo-Json) -NoNewline

    # Portless production HTTPS is accepted, and the raw env file is byte-identical.
    $probe = Invoke-SpoolerWhatIf $payload $programFiles $programData
    if ($probe.result.state -ne 'update' -or $probe.result.mutates -ne $false -or $probe.result.mode -ne 'Core') { throw 'Portless HTTPS core WhatIf contract failed.' }
    if ((Get-BytesHash $envPath) -ne $beforeEnvHash) { throw 'Core WhatIf changed spooler.env.' }
    if (($probe.output -join "`n") -match 'secret-key|CUSTOM_FLAG|CLOUD_SERVER_URL') { throw 'Spooler probe output leaked configuration.' }

    $runtimePayload = Join-Path $work 'runtime-payload'
    Copy-Item -LiteralPath $runtimeStage -Destination $runtimePayload -Recurse -Force
    $runtimeProbe = Invoke-SpoolerWhatIf $runtimePayload $programFiles $programData 'RuntimeTransition'
    if ($runtimeProbe.result.state -ne 'update' -or $runtimeProbe.result.mode -ne 'RuntimeTransition' -or $runtimeProbe.result.mutates -ne $false) { throw 'Runtime transition WhatIf contract failed.' }
    if ((Get-BytesHash $envPath) -ne $beforeEnvHash) { throw 'Runtime transition WhatIf changed spooler.env.' }
    if (($runtimeProbe.output -join "`n") -match 'secret-key|CUSTOM_FLAG|CLOUD_SERVER_URL') { throw 'Runtime transition probe output leaked configuration.' }

    # Releases installed before the single-hash contract have no runtime marker.
    # Only the runtime updater may adopt them; a core update cannot prove that the
    # retained node_modules/browser runtime is compatible.
    Set-Content -LiteralPath (Join-Path $programFiles 'release.json') -Value (@{ version='1.0.0'; commit=('a' * 40); schemaVersion='baseline'; spoolerVersion='1.2.0' } | ConvertTo-Json) -NoNewline
    $legacyRuntimeProbe = Invoke-SpoolerWhatIf $runtimePayload $programFiles $programData 'RuntimeTransition'
    if ($legacyRuntimeProbe.result.state -ne 'update' -or $legacyRuntimeProbe.result.mode -ne 'RuntimeTransition') { throw 'Runtime transition did not adopt legacy release metadata.' }
    $oldErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $legacyCoreOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -Mode Core -PayloadRoot $payload -ProgramFilesRoot $programFiles -ProgramDataRoot $programData -WhatIf 2>&1
    $legacyCoreExit = $LASTEXITCODE
    $ErrorActionPreference = $oldErrorAction
    if ($legacyCoreExit -eq 0 -or (($legacyCoreOutput -join "`n") -notmatch 'runtime transition required')) { throw 'Core updater accepted a legacy install with unknown runtime compatibility.' }
    Set-Content -LiteralPath (Join-Path $programFiles 'release.json') -Value (@{ version='1.0.0'; commit=('a' * 40); schemaVersion='baseline'; spoolerVersion='1.2.0'; runtimeSha256=[string]$coreRelease.runtimeSha256 } | ConvertTo-Json) -NoNewline

    # A stale install.json must not override or reject the env authority.
    [ordered]@{ appId='{80657A48-9BCB-4455-8CA9-A18139FDFC58}'; stationId='stale'; stationName='Wrong'; serverUrl='http://127.0.0.1:1'; release=@{ version='1.2.0'; commit=('a' * 40) } } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $programData 'install.json') -NoNewline
    $stale = Invoke-SpoolerWhatIf $payload $programFiles $programData
    if ($stale.result.state -ne 'update') { throw 'Stale install.json incorrectly blocked the core update.' }
    if ((Get-BytesHash $envPath) -ne $beforeEnvHash) { throw 'Stale metadata path changed spooler.env.' }

    # A changed payload byte must refuse before any service or Program Files mutation.
    Add-Content -LiteralPath (Join-Path $payload 'server.js') -Value '// corrupt'
    $oldErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $missingOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $script -Mode Core -PayloadRoot $payload -ProgramFilesRoot $programFiles -ProgramDataRoot $programData -WhatIf 2>&1
    $missingExit = $LASTEXITCODE
    $ErrorActionPreference = $oldErrorAction
    if ($missingExit -eq 0 -or (($missingOutput -join "`n") -notmatch 'payload hash mismatch')) { throw 'Corrupt payload was not refused.' }
    if ((Get-BytesHash $envPath) -ne $beforeEnvHash) { throw 'Refusal changed spooler.env.' }

    Write-Output 'spooler-update-probe: PASS'
}
finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}
