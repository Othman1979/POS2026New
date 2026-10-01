[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PayloadRoot,
    [ValidateSet('Core', 'RuntimeTransition')][string]$Mode = 'Core',
    [string]$ProgramFilesRoot = 'C:\Program Files\POS-Spooler',
    [string]$ProgramDataRoot = 'C:\ProgramData\POS-Spooler',
    [string]$ResultFile,
    [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'
$serviceName = 'POS Print Spooler'
$envPath = Join-Path $ProgramDataRoot 'config\spooler.env'
$updateLog = Join-Path $ProgramDataRoot 'logs\update-error.txt'
# Order matters since the journal was removed: Copy-OwnedApplication deletes each
# destination before copying it, with nothing staged and no rollback. The three
# identity files go LAST so a copy that dies partway leaves the OLD release.json on
# disk - Get-ReleaseState then still reports 'update' and re-running the updater
# retries. With them copied early, a half-replaced station claims the new version,
# the updater reports 'current', exits 0, and the retry is a silent no-op.
$applicationRoots = @('beep-tester.js', 'http-client.js', 'print-width-calibration.js', 'printer-alerts.js', 'raw-print.js', 'recover-printer.js', 'receipt-display.cjs', 'renderDocument.js', 'businessTime.js', 'report-html.js', 'server.js', 'thermal-raster.js', 'vendor', 'v2', 'windows-helper', 'bin', 'maintenance', 'package.json', 'package-lock.json', 'release.json')
$phase = 'preflight'
$script:resultWritten = $false
$serviceWasStopped = $false

function Write-Utf8NoBom([string]$Path, [string]$Contents) {
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    [IO.File]::WriteAllText($Path, $Contents, [Text.UTF8Encoding]::new($false))
}
function Write-Result([object]$Value) {
    $json = $Value | ConvertTo-Json -Depth 12
    if ($ResultFile) { Write-Utf8NoBom $ResultFile $json }
    Write-Output $json
    $script:resultWritten = $true
}
function Write-UpdateProgress([int]$Step, [int]$StepTotal, [string]$Label) {
    $safe = ($Label -replace '[\r\n|]', ' ').Trim()
    [Console]::Out.WriteLine(('POSAPP_PROGRESS|{0}|{1}|0|0|{2}|' -f $Step, $StepTotal, $safe))
    [Console]::Out.Flush()
}
function Fail([string]$Message, [string]$State = 'blocked_incomplete') {
    Write-Result ([ordered]@{ state = $State; updated = $false; mutates = $serviceWasStopped; mode = $Mode; phase = $phase; error = $Message; logPath = $updateLog })
    throw $Message
}
function Read-Json([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required file is missing: $Path" }
    try { return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json }
    catch { throw "Invalid JSON: $Path" }
}
function Read-Env([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'Spooler configuration is missing; use the fresh spooler installer.' }
    $values = @{}
    $raw = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($Path)).TrimStart([char]0xFEFF)
    foreach ($line in ($raw -split "`r?`n")) { if ($line -match '^([A-Z0-9_]+)=(.*)$') { $values[$Matches[1]] = $Matches[2] } }
    return $values
}
function Get-SpoolerServerOrigin([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -ne $Value.Trim()) { throw 'Stored POS server URL is invalid.' }
    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -notin @('http', 'https') -or [string]::IsNullOrWhiteSpace($uri.Host) -or
        ($uri.Scheme -eq 'http' -and -not $uri.IsLoopback) -or
        -not [string]::IsNullOrEmpty($uri.UserInfo) -or -not [string]::IsNullOrEmpty($uri.Query) -or
        -not [string]::IsNullOrEmpty($uri.Fragment) -or $uri.AbsolutePath -notin @('', '/') -or
        $uri.Port -eq 0 -or $uri.Port -gt 65535) { throw 'Stored POS server URL is invalid.' }
    return $uri.GetLeftPart([UriPartial]::Authority).TrimEnd('/')
}
function Get-FileSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path); $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
}
function Get-SpoolerPayloadHash([string]$Root) {
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $items = @(Get-ChildItem -LiteralPath $rootPath -Recurse -Force)
    if ($items | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }) { throw 'Spooler payload contains a reparse point.' }
    $files = @($items | Where-Object { -not $_.PSIsContainer } | ForEach-Object {
        $relative = $_.FullName.Substring($rootPath.Length).TrimStart('\').Replace('\', '/')
        if ($relative -ne 'release.json' -and -not $relative.StartsWith('deployment/') -and -not $relative.StartsWith('spooler-service/')) { [pscustomobject]@{ Relative = $relative; File = $_ } }
    })
    [Array]::Sort($files, [Collections.Generic.Comparer[object]]::Create({ param($left, $right) [StringComparer]::Ordinal.Compare($left.Relative, $right.Relative) }))
    $inventory = foreach ($entry in $files) { "$($entry.Relative)`t$($entry.File.Length)`t$(Get-FileSha256 $entry.File.FullName)`n" }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($inventory -join ''))
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Assert-SpoolerPayloadHash([string]$Root, $Release) {
    $expected = [string]$Release.payloadSha256
    if ($expected -notmatch '^[0-9a-fA-F]{64}$' -or (Get-SpoolerPayloadHash $Root) -ne $expected.ToLowerInvariant()) { throw 'Spooler payload hash mismatch.' }
}
function Get-EnvSnapshot([string]$Path) { return [pscustomobject]@{ hash = Get-FileSha256 $Path } }
function Assert-EnvUnchanged($Snapshot) {
    if (-not (Test-Path -LiteralPath $envPath -PathType Leaf) -or (Get-FileSha256 $envPath) -ne [string]$Snapshot.hash) { throw 'Spooler configuration changed during update.' }
}
function Normalize-Path([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    try { return [IO.Path]::GetFullPath($Path).TrimEnd('\') } catch { return $null }
}
function Test-SamePath([string]$Left, [string]$Right) {
    $leftPath = Normalize-Path $Left; $rightPath = Normalize-Path $Right
    return $null -ne $leftPath -and $null -ne $rightPath -and $leftPath.Equals($rightPath, [StringComparison]::OrdinalIgnoreCase)
}
function Get-RegisteredExecutablePath([string]$ImagePath) {
    if ([string]::IsNullOrWhiteSpace($ImagePath)) { return $null }
    $value = $ImagePath.Trim()
    if ($value.StartsWith('"')) { $closing = $value.IndexOf('"', 1); if ($closing -lt 1) { return $null }; return $value.Substring(1, $closing - 1) }
    if ($value -match '^(?<path>.*?\.exe)(?:\s+.*)?$') { return $Matches.path.Trim() }
    return ($value -split '\s+', 2)[0]
}
function Get-SpoolerEntryPointPath([string]$AppParameters) {
    $value = [string]$AppParameters
    if ([string]::IsNullOrWhiteSpace($value)) { return $null }
    $value = $value.Trim()
    if ($value.StartsWith('"')) { $closing = $value.IndexOf('"', 1); if ($closing -lt 1 -or -not [string]::IsNullOrWhiteSpace($value.Substring($closing + 1))) { return $null }; return $value.Substring(1, $closing - 1).Trim() }
    if ($value -match '^(?<path>.*?\.js)$') { return $Matches.path.Trim() }
    return $null
}
function Assert-OwnedService {
    $known = @('POS Print Spooler', 'POSPrintSpooler', 'POSAPPSpooler')
    $present = @($known | Where-Object { Get-Service -Name $_ -ErrorAction SilentlyContinue })
    if ($present.Count -ne 1 -or $present[0] -ne $serviceName) { throw 'Exactly one current POS Print Spooler service is required.' }
    $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'" -ErrorAction Stop
    $parameters = Get-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$serviceName\Parameters" -ErrorAction Stop
    $entry = Get-SpoolerEntryPointPath ([string]$parameters.AppParameters)
    $allowedEntries = @((Join-Path $ProgramFilesRoot 'server.js'), (Join-Path $ProgramFilesRoot 'v2-server.js'))
    if (-not (Test-SamePath (Get-RegisteredExecutablePath ([string]$service.PathName)) (Join-Path $ProgramFilesRoot 'runtime\nssm\nssm.exe')) -or
        -not (Test-SamePath ([string]$parameters.Application) (Join-Path $ProgramFilesRoot 'runtime\node\node.exe')) -or
        -not (Test-SamePath ([string]$parameters.AppDirectory) $ProgramFilesRoot) -or
        @($allowedEntries | Where-Object { Test-SamePath $entry $_ }).Count -eq 0) { throw 'Spooler service ownership is not exact; refusing to update an unknown service.' }
}
function Enter-SpoolerInstallerMutex {
    $mutex = [Threading.Mutex]::new($false, 'Global\POSAPP-Spooler-Service-Mutation')
    try { try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }; if (-not $acquired) { throw 'Another POS Print Spooler installer or updater is already running.' }; return $mutex }
    catch { $mutex.Dispose(); throw }
}
function Exit-SpoolerInstallerMutex($Mutex) { if ($null -eq $Mutex) { return }; try { $Mutex.ReleaseMutex() } catch {}; $Mutex.Dispose() }
function Read-Release([string]$Path, [string]$ExpectedKind) {
    $release = Read-Json $Path
    $runtimeProfile = ([string]$release.runtimeProfile).ToLowerInvariant()
    if ([string]$release.payloadKind -ne $ExpectedKind -or [string]$release.version -notmatch '^\d+\.\d+\.\d+$' -or [string]$release.commit -notmatch '^[0-9a-fA-F]{40}$' -or [string]$release.runtimeSha256 -notmatch '^[0-9a-fA-F]{64}$' -or $runtimeProfile -ne 'typst-only') { throw "Release identity does not match $ExpectedKind." }
    return [pscustomobject]@{ version = [string]$release.version; commit = ([string]$release.commit).ToLowerInvariant(); payloadKind = [string]$release.payloadKind; spoolerVersion = [string]$release.spoolerVersion; payloadSha256 = [string]$release.payloadSha256; runtimeSha256 = ([string]$release.runtimeSha256).ToLowerInvariant(); runtimeProfile = $runtimeProfile }
}
function Read-InstalledRelease {
    $release = Read-Json (Join-Path $ProgramFilesRoot 'release.json'); $package = Read-Json (Join-Path $ProgramFilesRoot 'package.json')
    if ([string]$release.spoolerVersion -notmatch '^\d+\.\d+\.\d+$' -or [string]$release.commit -notmatch '^[0-9a-fA-F]{40}$' -or [string]$package.version -ne [string]$release.spoolerVersion) { throw 'Installed spooler release/package metadata is incomplete.' }
    $runtimeSha256 = if ([string]$release.runtimeSha256 -match '^[0-9a-fA-F]{64}$') { ([string]$release.runtimeSha256).ToLowerInvariant() } else { $null }
    $runtimeProfile = if ([string]::IsNullOrWhiteSpace([string]$release.runtimeProfile)) { 'full' } else { ([string]$release.runtimeProfile).ToLowerInvariant() }
    if ($runtimeProfile -notin @('full', 'typst-only')) { throw 'Installed spooler runtime profile is invalid.' }
    return [pscustomobject]@{ version = [string]$release.spoolerVersion; commit = ([string]$release.commit).ToLowerInvariant(); payloadKind = 'spooler'; runtimeSha256 = $runtimeSha256; runtimeProfile = $runtimeProfile }
}

function Assert-RuntimeProfilePayload([string]$Root) {
    foreach ($relative in @('.puppeteerrc.cjs', '.cache\puppeteer', 'node_modules\puppeteer', 'node_modules\puppeteer-core', 'node_modules\@puppeteer', 'node_modules\chromium-bidi')) {
        if (Test-Path -LiteralPath (Join-Path $Root $relative)) { throw "Typst-only payload contains forbidden Chromium content: $relative" }
    }
    foreach ($required in @('.cache\typst\0.15.1\typst.exe', 'node_modules\dotenv')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $required))) { throw "Typst-only payload is missing required runtime content: $required" }
    }
}
function Assert-DrainedLegacyQueue([string]$StateRoot) {
    $active = Join-Path $StateRoot 'jobs\active'
    if (-not (Test-Path -LiteralPath $active -PathType Container)) { return }
    foreach ($file in @(Get-ChildItem -LiteralPath $active -File -Filter '*.json')) {
        try { $record = Read-Json $file.FullName }
        catch { throw "Legacy queue record cannot be inspected: $($file.Name). Resolve it before the Typst transition." }
        if ([string]$record.state -notin @('completed', 'permanent_failure', 'uncertain', 'canceled')) {
            throw "Legacy queue still has pending work ($($file.Name)). Drain it before the Typst transition."
        }
    }
}
function Get-ReleaseState($Installed, $Target) {
    $installedVersion = [version][string]$Installed.version; $targetVersion = [version][string]$Target.version
    if ($targetVersion -lt $installedVersion) { return 'blocked_downgrade' }
    if ($Mode -eq 'RuntimeTransition' -and $targetVersion -eq $installedVersion -and $Target.commit -eq $Installed.commit -and $Target.runtimeProfile -ne $Installed.runtimeProfile) { return 'update' }
    if ($targetVersion -eq $installedVersion -and $Target.commit -eq $Installed.commit) { return 'current' }
    if ($targetVersion -eq $installedVersion) { return 'blocked_version_collision' }
    return 'update'
}
function Copy-OwnedApplication([string]$SourceRoot, [string]$DestinationRoot) {
    foreach ($relative in $applicationRoots) {
        $source = Join-Path $SourceRoot $relative
        if (-not (Test-Path -LiteralPath $source)) { throw "Spooler update payload is missing application root: $relative" }
        $destination = Join-Path $DestinationRoot $relative
        if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
        Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
    }
}
function Stop-Spooler { $service = Get-Service -Name $serviceName -ErrorAction Stop; if ($service.Status -ne 'Stopped') { Stop-Service -Name $serviceName -Force; $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) } }
function Start-Spooler { Start-Service -Name $serviceName -ErrorAction Stop; (Get-Service -Name $serviceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30)) }
function Set-SpoolerApplicationScript {
    $nssm = Join-Path $ProgramFilesRoot 'runtime\nssm\nssm.exe'; $scriptPath = Join-Path $ProgramFilesRoot 'server.js'
    # Triple quotes, matching Configure-NssmService in Install-Spooler.ps1. PowerShell
    # strips one layer when it builds the native command line, so '"' + path + '"'
    # reaches nssm unquoted; nssm stores AppParameters verbatim and launches
    # "<Application>" <AppParameters>, so node would receive argv[1] = C:\Program and
    # die on every start. nssm reports the service Running the moment CreateProcess
    # succeeds and restarts it by default, so the updater would report success while
    # the till never printed again - and the ownership check, which expects the quoted
    # form, would then call the station unrecognised.
    & $nssm set $serviceName AppParameters ('"""' + $scriptPath + '"""')
    if ($LASTEXITCODE -ne 0) { throw "NSSM exited with code $LASTEXITCODE while setting AppParameters." }
}

$mutex = $null
try {
    $phase = 'lock'; try { $mutex = Enter-SpoolerInstallerMutex } catch { Fail $_.Exception.Message 'blocked_in_progress' }
    $phase = 'preflight'; Write-UpdateProgress 1 6 'Verifying update package'
    if (-not (Test-Path -LiteralPath $PayloadRoot -PathType Container)) { Fail 'Spooler update payload root is missing.' }
    $envValues = Read-Env $envPath
    foreach ($required in @('CLOUD_SERVER_URL', 'SPOOLER_KEY', 'SPOOLER_ID', 'SPOOLER_NAME', 'SPOOLER_STATE_DIR', 'SPOOLER_LOG_DIR')) { if ([string]::IsNullOrWhiteSpace([string]$envValues[$required])) { Fail "Spooler configuration is missing $required." } }
    $serverUrl = Get-SpoolerServerOrigin ([string]$envValues.CLOUD_SERVER_URL); $envSnapshot = Get-EnvSnapshot $envPath
    $targetKind = if ($Mode -eq 'RuntimeTransition') { 'spooler-update-runtime' } else { 'spooler-update-core' }
    $targetRelease = Read-Release (Join-Path $PayloadRoot 'release.json') $targetKind
    Assert-SpoolerPayloadHash $PayloadRoot $targetRelease
    $installedRelease = Read-InstalledRelease; $releaseState = Get-ReleaseState $installedRelease $targetRelease
    if ($releaseState -ne 'update') { Write-Result ([ordered]@{ state = $releaseState; updated = $false; mutates = $false; mode = $Mode; phase = $phase; installed = $installedRelease; target = $targetRelease; logPath = $updateLog }); if ($releaseState -ne 'current') { throw "Packaged spooler update refused: $releaseState." }; return }
    if ($Mode -eq 'Core' -and $installedRelease.runtimeSha256 -ne $targetRelease.runtimeSha256) { Fail 'Spooler runtime transition required.' 'runtime_transition_required' }
    if ($Mode -eq 'Core' -and $installedRelease.runtimeProfile -ne $targetRelease.runtimeProfile) { Fail 'Spooler runtime transition required.' 'runtime_transition_required' }
    if ($Mode -eq 'RuntimeTransition') { Assert-RuntimeProfilePayload $PayloadRoot }
    if ($Mode -eq 'RuntimeTransition' -and $installedRelease.runtimeProfile -eq 'full') { Assert-DrainedLegacyQueue ([string]$envValues.SPOOLER_STATE_DIR) }
    $nodePath = Join-Path $ProgramFilesRoot 'runtime\node\node.exe'
    if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { Fail 'Installed Node runtime is missing.' 'node_runtime_upgrade_required' }
    $nodeReported = (& $nodePath --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeReported -notmatch '^v\d+\.\d+\.\d+$' -or [version]$nodeReported.TrimStart('v') -lt [version]'22.12.0') { Fail 'Node 22.12 or newer is required. Upgrade the installed Node runtime before applying this update.' 'node_runtime_upgrade_required' }
    if ($WhatIf) { Write-Result ([ordered]@{ state = 'update'; updated = $false; mutates = $false; mode = $Mode; phase = 'preflight'; installed = $installedRelease; target = $targetRelease; logPath = $updateLog }); return }
    Assert-OwnedService; Assert-EnvUnchanged $envSnapshot
    Unregister-ScheduledTask -TaskName 'POSAPP Spooler Startup Health Repair' -Confirm:$false -ErrorAction SilentlyContinue

    $phase = 'stop spooler'; Write-UpdateProgress 2 6 'Stopping print spooler'; Stop-Spooler; $serviceWasStopped = $true; Assert-EnvUnchanged $envSnapshot
    if ($Mode -eq 'RuntimeTransition' -and $installedRelease.runtimeProfile -eq 'full') {
        $phase = 'inspect legacy queue'
        Assert-DrainedLegacyQueue ([string]$envValues.SPOOLER_STATE_DIR)
    }
    $phase = 'replace application'; Write-UpdateProgress 3 6 'Updating application files'
    Copy-OwnedApplication $PayloadRoot $ProgramFilesRoot
    if ($Mode -eq 'RuntimeTransition') {
        $phase = 'replace runtime'; Write-UpdateProgress 4 6 'Updating runtime files'
        foreach ($rootName in @('node_modules', '.cache')) {
            $source = Join-Path $PayloadRoot $rootName; $target = Join-Path $ProgramFilesRoot $rootName
            if (-not (Test-Path -LiteralPath $source -PathType Container)) { throw "Spooler runtime payload is missing $rootName." }
            if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
            Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
        }
        Remove-Item -LiteralPath (Join-Path $ProgramFilesRoot '.puppeteerrc.cjs') -Force -ErrorAction SilentlyContinue
        Assert-RuntimeProfilePayload $ProgramFilesRoot
    }
    Set-SpoolerApplicationScript; Assert-EnvUnchanged $envSnapshot

    $phase = 'start spooler'; Write-UpdateProgress 5 6 'Starting print spooler'; Start-Spooler; $serviceWasStopped = $false
    $warnings = @(); try { $status = Invoke-RestMethod -Method Post -Uri "$serverUrl/api/spooler/v2/status" -Headers @{ 'x-spooler-key' = [string]$envValues.SPOOLER_KEY } -Body (@{ spooler_id = [string]$envValues.SPOOLER_ID } | ConvertTo-Json) -ContentType 'application/json' -TimeoutSec 5 } catch { $status = $null; $warnings += 'SPOOLER_NOT_YET_REGISTERED' }
    Write-UpdateProgress 6 6 'Update complete'
    Write-Result ([ordered]@{ state = 'update'; updated = $true; mutates = $true; mode = $Mode; installed = $installedRelease; target = $targetRelease; status = $status; warnings = $warnings; logPath = $updateLog })
}
catch {
    $failure = $_
    if ($serviceWasStopped -and -not $WhatIf) { try { Start-Spooler; $serviceWasStopped = $false } catch {} }
    try { Write-Utf8NoBom $updateLog ("[$([DateTime]::UtcNow.ToString('o'))] mode=$Mode phase=$phase $($failure.Exception.Message)`r`n") } catch {}
    if (-not $script:resultWritten) { try { Write-Result ([ordered]@{ state = 'blocked_incomplete'; updated = $false; mutates = $true; mode = $Mode; phase = $phase; error = $failure.Exception.Message; logPath = $updateLog }) } catch {} }
    throw $failure
}
finally { Exit-SpoolerInstallerMutex $mutex }
