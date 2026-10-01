[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$ProgramFilesRoot = 'C:\Program Files\POSApp',
    [string]$ProgramDataRoot = 'C:\ProgramData\POSApp',
    [ValidateRange(0, 300)] [int]$StartupDelaySeconds = 60
)
$ErrorActionPreference = 'Stop'

function Write-Utf8NoBom([string]$Path, [string]$Contents) {
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    [IO.File]::WriteAllText($Path, $Contents, [Text.UTF8Encoding]::new($false))
}
function Write-RepairLog([string]$Message) {
    $line = "[$([DateTime]::UtcNow.ToString('o'))] $Message`r`n"
    [IO.File]::AppendAllText($script:repairLog, $line, [Text.UTF8Encoding]::new($false))
}
function Test-TcpPort([int]$Port, [int]$TimeoutMilliseconds = 500) {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $connect = $client.ConnectAsync([Net.IPAddress]::Loopback, $Port)
        if ($connect.Wait($TimeoutMilliseconds)) { return $client.Connected }
    } catch {}
    finally { $client.Dispose() }
    return $false
}
function Wait-TcpPort([int]$Port, [int]$TimeoutSeconds = 30) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (Test-TcpPort $Port) { return }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Port $Port did not become available within $TimeoutSeconds seconds."
}
function Wait-Http([string]$Url, [switch]$RequirePosHealth, [int]$TimeoutSeconds = 45) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastError = ''
    do {
        try {
            if ($RequirePosHealth) {
                $response = Invoke-RestMethod -Uri $Url -TimeoutSec 3
                if ($response.status -eq 'ok' -and $response.db -eq 'connected') { return }
                $lastError = 'Health response did not report status=ok and db=connected.'
            } else {
                $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
                if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) { return }
                $lastError = "HTTP status $($response.StatusCode)."
            }
        } catch { $lastError = $_.Exception.Message }
        Start-Sleep -Milliseconds 750
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Endpoint did not become healthy: $Url. Last error: $lastError"
}
function Ensure-ServiceHealthy([string]$Name, [scriptblock]$Probe) {
    $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $service) { throw "Windows service $Name is missing. Rerun POSAPP-Server-Setup.exe in repair mode." }
    if ($service.Status -ne 'Running') {
        Start-Service -Name $Name -ErrorAction Stop
        $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    }
    try { & $Probe }
    catch {
        Write-RepairLog "$Name failed its first health probe; restarting it once. $($_.Exception.Message)"
        Restart-Service -Name $Name -Force -ErrorAction Stop
        (Get-Service -Name $Name).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
        & $Probe
    }
}

$logDir = Join-Path $ProgramDataRoot 'logs'
$metadataPath = Join-Path $ProgramDataRoot 'install.json'
$statusPath = Join-Path $logDir 'startup-health.json'
$repairLog = Join-Path $logDir 'startup-repair.log'

$status = [ordered]@{
    startedAt = [DateTime]::UtcNow.ToString('o')
    healthy = $false
    components = [ordered]@{}
    errors = @()
}
$failure = $null
try {
    if (-not (Test-Path -LiteralPath $metadataPath)) { throw "Installation metadata is missing: $metadataPath. Rerun POSAPP-Server-Setup.exe in repair mode." }
    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    $databasePort = [int]$metadata.databasePort
    $phpMyAdminPort = [int]$metadata.phpMyAdminPort
    $posPort = [int]$metadata.posPort
    foreach ($port in @($databasePort, $phpMyAdminPort, $posPort)) {
        if ($port -lt 1 -or $port -gt 65535) { throw "Installation metadata contains an invalid service port: $port." }
    }
    if ($WhatIfPreference) {
        [ordered]@{ mutates=$false; startupDelaySeconds=$StartupDelaySeconds; services=@('POSAppMariaDB','POSAppPhpMyAdmin','POSApp'); databasePort=$databasePort; phpMyAdminPort=$phpMyAdminPort; posPort=$posPort } | ConvertTo-Json -Compress
        return
    }
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    if ($StartupDelaySeconds -gt 0) { Start-Sleep -Seconds $StartupDelaySeconds }
    Write-RepairLog 'Starting POSAPP startup health repair.'

    $databaseHealthy = $true
    try {
        Ensure-ServiceHealthy 'POSAppMariaDB' { Wait-TcpPort $databasePort }
        $status.components.database = 'healthy'
    } catch {
        $databaseHealthy = $false
        $status.components.database = 'failed'
        $status.errors += $_.Exception.Message
    }
    try {
        Ensure-ServiceHealthy 'POSAppPhpMyAdmin' { Wait-Http "http://127.0.0.1:$phpMyAdminPort/" }
        $status.components.phpMyAdmin = 'healthy'
    } catch {
        $status.components.phpMyAdmin = 'failed'
        $status.errors += $_.Exception.Message
    }
    if ($databaseHealthy) {
        try {
            Ensure-ServiceHealthy 'POSApp' { Wait-Http "http://127.0.0.1:$posPort/health" -RequirePosHealth }
            $status.components.pos = 'healthy'
        } catch {
            $status.components.pos = 'failed'
            $status.errors += $_.Exception.Message
        }
    } else {
        $status.components.pos = 'blocked-by-database'
        $status.errors += 'POS health was not attempted because MariaDB is unhealthy.'
    }
    $status.healthy = $status.errors.Count -eq 0
    if (-not $status.healthy) { throw ($status.errors -join ' | ') }
} catch {
    $failure = $_
    if ($status.errors.Count -eq 0) { $status.errors += $_.Exception.Message }
} finally {
    if (-not $WhatIfPreference) {
        $status.completedAt = [DateTime]::UtcNow.ToString('o')
        Write-Utf8NoBom $statusPath ($status | ConvertTo-Json -Depth 6)
        if ($status.healthy) { Write-RepairLog 'POSAPP startup health repair completed successfully.' }
        else { Write-RepairLog "POSAPP startup health repair failed. $($status.errors -join ' | ')" }
    }
}
if ($failure) { throw $failure }
