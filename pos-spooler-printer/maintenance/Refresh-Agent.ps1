[CmdletBinding()]
param(
    [switch]$ResetIdentity,
    [string]$ProgramFilesRoot = 'C:\Program Files\POS-Spooler',
    [string]$ProgramDataRoot = 'C:\ProgramData\POS-Spooler'
)

$ErrorActionPreference = 'Stop'
$serviceName = 'POS Print Spooler'
$envPath = Join-Path $ProgramDataRoot 'config\spooler.env'
$stateRoot = Join-Path $ProgramDataRoot 'state'

function Read-SpoolerEnv([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'Spooler configuration is missing.' }
    $values = @{}
    $raw = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($Path)).TrimStart([char]0xFEFF)
    foreach ($line in ($raw -split "`r?`n")) {
        if ($line -match '^([A-Z0-9_]+)=(.*)$') { $values[$Matches[1]] = $Matches[2] }
    }
    return $values
}

function Normalize-Path([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    try { return ([IO.Path]::GetFullPath($Path)).TrimEnd('\') }
    catch { return $null }
}

function Test-SamePath([string]$Left, [string]$Right) {
    $leftPath = Normalize-Path $Left
    $rightPath = Normalize-Path $Right
    return $null -ne $leftPath -and $null -ne $rightPath -and $leftPath.Equals($rightPath, [StringComparison]::OrdinalIgnoreCase)
}

function Get-RegisteredExecutablePath([string]$ImagePath) {
    if ([string]::IsNullOrWhiteSpace($ImagePath)) { return $null }
    $value = $ImagePath.Trim()
    if ($value.StartsWith('"')) {
        $closing = $value.IndexOf('"', 1)
        if ($closing -lt 1) { return $null }
        return $value.Substring(1, $closing - 1)
    }
    if ($value -match '^(?<path>.*?\.exe)(?:\s+.*)?$') { return $Matches.path.Trim() }
    return ($value -split '\s+', 2)[0]
}

function Get-SpoolerEntryPointPath([string]$AppParameters) {
    $value = [string]$AppParameters
    if ([string]::IsNullOrWhiteSpace($value)) { return $null }
    $value = $value.Trim()
    if ($value.StartsWith('"')) {
        $closing = $value.IndexOf('"', 1)
        if ($closing -lt 1 -or -not [string]::IsNullOrWhiteSpace($value.Substring($closing + 1))) { return $null }
        $value = $value.Substring(1, $closing - 1).Trim()
        return $(if ([string]::IsNullOrWhiteSpace($value)) { $null } else { $value })
    }
    if ($value -match '^(?<path>.*?\.js)(?<rest>\s.*)?$') {
        if (-not [string]::IsNullOrWhiteSpace([string]$Matches.rest)) { return $null }
        return $Matches.path.Trim()
    }
    return $null
}

function Assert-ManagedService {
    $knownServices = @('POS Print Spooler', 'POSPrintSpooler', 'POSAPPSpooler')
    $present = @($knownServices | Where-Object { Get-Service -Name $_ -ErrorAction SilentlyContinue })
    if ($present.Count -ne 1 -or $present[0] -ne $serviceName) {
        throw "Exactly one owned spooler service is required; found $($present.Count)."
    }
    $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'" -ErrorAction Stop
    $parameters = Get-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$serviceName\Parameters" -ErrorAction Stop
    $expectedNssm = Join-Path $ProgramFilesRoot 'runtime\nssm\nssm.exe'
    $expectedNode = Join-Path $ProgramFilesRoot 'runtime\node\node.exe'
    $expectedScript = Join-Path $ProgramFilesRoot 'server.js'
    $registeredNssm = Get-RegisteredExecutablePath ([string]$service.PathName)
    $registeredScript = Get-SpoolerEntryPointPath ([string]$parameters.AppParameters)
    if (-not (Test-SamePath $registeredNssm $expectedNssm) -or
        -not (Test-SamePath ([string]$parameters.Application) $expectedNode) -or
        -not (Test-SamePath ([string]$parameters.AppDirectory) $ProgramFilesRoot) -or
        -not (Test-SamePath $registeredScript $expectedScript)) {
        throw 'Spooler service ownership is not exact; refusing maintenance.'
    }
}

function Get-SpoolerRegistrationStatus([string]$ServerUrl, [string]$Key, [string]$Id) {
    return Invoke-RestMethod -Method Post -Uri "$ServerUrl/api/spooler/v2/status" -Headers @{ 'x-spooler-key' = $Key } -Body (@{ spooler_id = $Id } | ConvertTo-Json) -ContentType 'application/json' -TimeoutSec 5
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

function Test-FreshSpoolerSync($Status, [string]$ExpectedAgentId, [AllowNull()][string]$PreviousLastSyncAt) {
    if ($null -eq $Status -or [string]$Status.station_protocol -ne 'v2' -or [string]$Status.agent_id -ne $ExpectedAgentId) { return $false }
    $current = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse([string]$Status.last_sync_at, [ref]$current)) { return $false }
    if ([string]::IsNullOrWhiteSpace($PreviousLastSyncAt)) { return $true }
    $previous = [DateTimeOffset]::MinValue
    return [DateTimeOffset]::TryParse($PreviousLastSyncAt, [ref]$previous) -and $current -gt $previous
}

function Enter-SpoolerMaintenanceMutex {
    $mutex = [Threading.Mutex]::new($false, 'Global\POSAPP-Spooler-Service-Mutation')
    try {
        try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw 'Another POS Print Spooler installer or updater is already running.' }
        return $mutex
    } catch { $mutex.Dispose(); throw }
}

function Exit-SpoolerMaintenanceMutex($Mutex) {
    if ($null -eq $Mutex) { return }
    try { $Mutex.ReleaseMutex() } catch {}
    $Mutex.Dispose()
}

function Get-AgentId([string]$IdentityPath) {
    if (-not (Test-Path -LiteralPath $IdentityPath -PathType Leaf)) { return $null }
    try {
        $agentId = [string](Get-Content -LiteralPath $IdentityPath -Raw | ConvertFrom-Json).agent_id
        if ($agentId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') { throw 'invalid' }
        return $agentId
    }
    catch { throw 'Local agent identity is invalid.' }
}

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"",
        '-ProgramFilesRoot', "`"$ProgramFilesRoot`"", '-ProgramDataRoot', "`"$ProgramDataRoot`""
    )
    if ($ResetIdentity) { $arguments += '-ResetIdentity' }
    $elevated = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs -Wait -PassThru
    exit $elevated.ExitCode
}

$config = Read-SpoolerEnv $envPath
foreach ($required in @('CLOUD_SERVER_URL', 'SPOOLER_KEY', 'SPOOLER_ID', 'SPOOLER_STATE_DIR')) {
    if ([string]::IsNullOrWhiteSpace([string]$config[$required])) { throw "Spooler configuration is missing $required." }
}
$serverUrl = Get-SpoolerServerOrigin ([string]$config.CLOUD_SERVER_URL)
$spoolerId = [string]$config.SPOOLER_ID
if ($spoolerId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$') { throw 'Stored spooler ID is invalid.' }
if (-not (Test-SamePath ([string]$config.SPOOLER_STATE_DIR) $stateRoot)) { throw 'Stored spooler state path is not installer-owned.' }
Assert-ManagedService

$maintenanceMutex = Enter-SpoolerMaintenanceMutex
$ensureServiceRunning = $false
try {
    $service = Get-Service -Name $serviceName -ErrorAction Stop
    $ensureServiceRunning = $true
    if ($service.Status -ne 'Stopped') {
        Stop-Service -Name $serviceName -Force -ErrorAction Stop
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }

    $baseline = Get-SpoolerRegistrationStatus $serverUrl ([string]$config.SPOOLER_KEY) $spoolerId
    $previousLastSyncAt = [string]$baseline.last_sync_at
    $identityPath = Join-Path $stateRoot 'agent.json'
    if ($ResetIdentity) {
        $activeJobs = Join-Path $stateRoot 'jobs\active'
        if (Test-Path -LiteralPath $activeJobs -PathType Container) {
            $pending = @(Get-ChildItem -LiteralPath $activeJobs -File -Filter '*.json' -ErrorAction Stop)
            if ($pending.Count -gt 0) { throw 'LOCAL_JOURNAL_NOT_EMPTY: finish or recover local print jobs before rebinding.' }
        }
        $oldAgentId = Get-AgentId $identityPath
        if ([string]$baseline.agent_status -in @('active', 'draining')) {
            throw 'station_occupied: drain or force-replace the current station in Admin before rebinding it.'
        }
        if ($oldAgentId) {
            $retired = Join-Path $stateRoot ("agent.json.retired-{0}-{1}" -f [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'), [Guid]::NewGuid().ToString('N').Substring(0, 8))
            Write-Warning 'Rebinding retires this machine identity. The previous station must already be drained or force-replaced.'
            Move-Item -LiteralPath $identityPath -Destination $retired
        }
    }

    Start-Service -Name $serviceName -ErrorAction Stop
    (Get-Service -Name $serviceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
        try {
            $agentId = Get-AgentId $identityPath
            if ($agentId) {
                $status = Get-SpoolerRegistrationStatus $serverUrl ([string]$config.SPOOLER_KEY) $spoolerId
                if (Test-FreshSpoolerSync -Status $status -ExpectedAgentId $agentId -PreviousLastSyncAt $previousLastSyncAt) {
                    [ordered]@{ status = 'connected'; station_id = $spoolerId; agent_id = $agentId; identity_reset = [bool]$ResetIdentity } | ConvertTo-Json -Compress
                    return
                }
            }
        } catch {}
        Start-Sleep -Milliseconds 750
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Spooler did not complete a fresh authenticated sync. If the server or station changed, use rebind only after draining or force-replacing the old station.'
}
finally {
    if ($ensureServiceRunning) {
        try {
            $currentService = Get-Service -Name $serviceName -ErrorAction Stop
            if ($currentService.Status -eq 'Stopped') { Start-Service -Name $serviceName -ErrorAction Stop }
        }
        catch { Write-Warning 'Maintenance failed and the spooler service could not be restarted; start it manually after correcting the reported error.' }
    }
    Exit-SpoolerMaintenanceMutex $maintenanceMutex
}
