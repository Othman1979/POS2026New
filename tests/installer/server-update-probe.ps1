[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script = Join-Path $repo 'deployment\windows\Update-PosServer.ps1'
if (-not (Test-Path -LiteralPath $script)) { throw 'Update-PosServer.ps1 is missing.' }
$source = Get-Content -Raw -LiteralPath $script
$helperSource = Get-Content -Raw -LiteralPath (Join-Path $repo 'deployment\windows\InstallerUpdateState.ps1')
foreach ($required in @('preflight', 'database-backup', 'rollback-copy', 'stop POSApp', 'target migrations', 'managed swap', 'start POSApp', 'health/schema verify', 'metadata write', 'cleanup')) {
    if ($source -notmatch [regex]::Escape($required)) { throw "Server updater is missing transaction phase: $required" }
}
foreach ($required in @('Get-RegisteredExecutablePath', 'Test-SamePath', 'Get-ServiceImagePath')) {
    if ($source -notmatch [regex]::Escape($required)) { throw "Server updater is missing exact service ownership validation: $required" }
}
if ($helperSource -notmatch 'Normalize-Path') { throw 'Shared updater helper is missing normalized path comparison.' }
if ($source -notmatch [regex]::Escape('tmp\nssm\nssm-2.24\win64\nssm.exe')) { throw 'Server updater is missing exact installer-owned NSSM path.' }
if ($source -match '-match \[regex\]::Escape\(\$nssm') { throw 'Server updater uses substring NSSM ownership matching.' }
if ($source -notmatch 'Test-SamePath \$registeredExecutable \$expectedNssm\)[\s\S]{0,250}Test-Path -LiteralPath \$expectedNssm -PathType Leaf') { throw 'Server updater does not require the owned NSSM executable to exist as a leaf.' }
foreach ($forbidden in @('bootstrap-database.js', 'mariadb-install-db', 'generate-secrets', 'POSAppMariaDB', 'POSAppPhpMyAdmin', 'New-NetFirewallRule')) {
    if ($source -match [regex]::Escape($forbidden)) { throw "Server updater contains forbidden mutation token: $forbidden" }
}
if ($source -notmatch 'Get-FileHash[\s\S]+backupFile') { throw 'Server updater does not verify the database backup archive hash.' }
$work = Join-Path ([IO.Path]::GetTempPath()) "pos-server-update-probe-$PID"
if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
$programFiles = Join-Path $work 'program-files'
$programData = Join-Path $work 'program-data'
$payload = Join-Path $work 'payload'
New-Item -ItemType Directory -Force -Path $programFiles, (Join-Path $programData 'config'), $payload | Out-Null
$metadata = [ordered]@{ appId='{E99DB275-DDA0-43A0-95CD-7AE07185122C}'; restaurant='Probe'; posPort=3100; databasePort=3307; phpMyAdminPort=8082; release=[ordered]@{ version='1.0.0'; commit=('a' * 40); schemaVersion='baseline'; spoolerVersion='1.2.0' } }
Set-Content -LiteralPath (Join-Path $programData 'install.json') -Value ($metadata | ConvertTo-Json -Depth 5) -NoNewline
Set-Content -LiteralPath (Join-Path $programFiles 'release.json') -Value ($metadata.release | ConvertTo-Json) -NoNewline
New-Item -ItemType Directory -Force -Path (Join-Path $programFiles 'node_modules') | Out-Null
Set-Content -LiteralPath (Join-Path $programData 'config\pos.env') -Value 'DB_PASSWORD=secret' -NoNewline
Set-Content -LiteralPath (Join-Path $programData 'config\backup.env') -Value 'DB_PASSWORD=maintenance' -NoNewline
Set-Content -LiteralPath (Join-Path $payload 'release.json') -Value (@{ version='1.0.1'; commit=('b' * 40); schemaVersion='baseline'; spoolerVersion='1.2.1'; payloadKind='server-update-core' } | ConvertTo-Json) -NoNewline
$emptyInventoryId = ([BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash([Text.Encoding]::UTF8.GetBytes('[]')))).Replace('-', '').ToLowerInvariant()
Set-Content -LiteralPath (Join-Path $payload 'server-dependency-manifest.json') -Value (@{ format=1; kind='server-dependencies'; nodeVersion='22.23.0'; platform='win32'; arch='x64'; dependencies=@{ id=$emptyInventoryId; files=@() } } | ConvertTo-Json -Depth 5) -NoNewline
$releaseHash = (Get-FileHash -LiteralPath (Join-Path $payload 'release.json') -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath (Join-Path $payload 'update-payload-manifest.json') -Value (@{ format=1; kind='server-update-core'; version='1.0.1'; commit=('b' * 40); managedRoots=@('release.json','server-dependency-manifest.json'); files=@(
    @{ path='release.json'; bytes=(Get-Item -LiteralPath (Join-Path $payload 'release.json')).Length; sha256=$releaseHash },
    @{ path='server-dependency-manifest.json'; bytes=(Get-Item -LiteralPath (Join-Path $payload 'server-dependency-manifest.json')).Length; sha256=(Get-FileHash -LiteralPath (Join-Path $payload 'server-dependency-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant() }
) } | ConvertTo-Json -Depth 5) -NoNewline
$output = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $script -PayloadRoot $payload -ProgramFilesRoot $programFiles -ProgramDataRoot $programData -WhatIf)
$result = @($output | Where-Object { [string]$_ -and [string]$_ -notlike 'POSAPP_PROGRESS|*' }) -join "`n" | ConvertFrom-Json
if ($result.state -ne 'update' -or $result.mutates -ne $false -or $result.posPort -ne 3100 -or $result.databasePort -ne 3307 -or $result.phpMyAdminPort -ne 8082) { throw 'Server updater WhatIf state contract failed.' }
Remove-Item -LiteralPath $work -Recurse -Force
Write-Output 'server-update-probe: PASS'
