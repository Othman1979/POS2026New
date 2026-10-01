[CmdletBinding(SupportsShouldProcess)]
param([string]$ProgramFilesRoot = 'C:\Program Files\POSApp')
$ErrorActionPreference = 'Stop'
if ($WhatIfPreference) { Write-Output 'WhatIf: would remove POS/Apache services, firewall, backup task, and any server-owned local spooler while preserving MariaDB and ProgramData.'; return }
# POSAppMariaDB, its private runtime, and its ProgramData database are intentionally retained for recovery.
foreach ($service in @('POSApp', 'POSAppPhpMyAdmin')) {
    & sc.exe stop $service 2>$null | Out-Null
    & sc.exe delete $service 2>$null | Out-Null
}
$metadataPath = 'C:\ProgramData\POSApp\install.json'
if (Test-Path $metadataPath) {
    $metadata = Get-Content $metadataPath -Raw | ConvertFrom-Json
    $removeSpooler = Join-Path $ProgramFilesRoot 'deployment\windows\Remove-SpoolerRuntime.ps1'
    if ($metadata.installLocalSpooler -and (Test-Path $removeSpooler)) {
        & $removeSpooler
        Remove-Item 'C:\Program Files\POS-Spooler' -Recurse -Force -ErrorAction SilentlyContinue
    }
}
Remove-NetFirewallRule -DisplayName 'POSApp POS Server' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'POSAPP Database Backup' -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'POSAPP Startup Health Repair' -Confirm:$false -ErrorAction SilentlyContinue
Write-Output 'Preserved: POSAppMariaDB, C:\Program Files\POSApp-MariaDB, and C:\ProgramData\POSApp durable data.'
