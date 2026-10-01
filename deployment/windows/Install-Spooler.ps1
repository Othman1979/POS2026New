[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$ServerUrl, [string]$SpoolerKey, [string]$SpoolerId, [string]$SpoolerName,
    [Parameter(Mandatory)] [string]$PayloadRoot, [string]$ConfigFile, [string]$ResultFile,
    [string]$ProgramFilesRoot = 'C:\Program Files\POS-Spooler', [string]$ProgramDataRoot = 'C:\ProgramData\POS-Spooler'
)
$ErrorActionPreference = 'Stop'
function Write-EarlyProvisioningFailure([string]$Message) {
    $contents = "POS spooler provisioning failed.`r`n$Message"
    foreach ($target in @($ResultFile, (Join-Path $ProgramDataRoot 'logs\install-error.txt'))) {
        if ([string]::IsNullOrWhiteSpace($target)) { continue }
        try {
            $parent = Split-Path -Parent $target
            if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
            [IO.File]::WriteAllText($target, $contents, [Text.UTF8Encoding]::new($false))
        } catch {}
    }
}
trap {
    Write-EarlyProvisioningFailure $_.Exception.Message
    Write-Error $_.Exception.Message
    exit 1
}
function Get-SpoolerServerOrigin([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -ne $Value.Trim()) { throw 'Stored POS server URL is invalid.' }
    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -notin @('http', 'https') -or [string]::IsNullOrWhiteSpace($uri.Host) -or
        ($uri.Scheme -eq 'http' -and -not $uri.IsLoopback) -or
        -not [string]::IsNullOrEmpty($uri.UserInfo) -or -not [string]::IsNullOrEmpty($uri.Query) -or
        -not [string]::IsNullOrEmpty($uri.Fragment) -or $uri.AbsolutePath -notin @('', '/') -or
        $uri.Port -eq 0 -or $uri.Port -gt 65535) {
        throw 'Stored POS server URL is invalid.'
    }
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
function Enter-SpoolerInstallerMutex {
    $mutex = [Threading.Mutex]::new($false, 'Global\POSAPP-Spooler-Service-Mutation')
    try {
        try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw 'Another POS Print Spooler installer or updater is already running.' }
        return $mutex
    } catch { $mutex.Dispose(); throw }
}
function Exit-SpoolerInstallerMutex($Mutex) {
    if ($null -eq $Mutex) { return }
    try { $Mutex.ReleaseMutex() } catch {}
    $Mutex.Dispose()
}

function Write-Utf8NoBom([string]$Path, [string]$Contents) {
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    [IO.File]::WriteAllText($Path, $Contents, [Text.UTF8Encoding]::new($false))
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
        if ($relative -ne 'release.json' -and -not $relative.StartsWith('deployment/') -and -not $relative.StartsWith('spooler-service/')) {
            [pscustomobject]@{ Relative = $relative; File = $_ }
        }
    })
    [Array]::Sort($files, [Collections.Generic.Comparer[object]]::Create({ param($left, $right) [StringComparer]::Ordinal.Compare($left.Relative, $right.Relative) }))
    $inventory = foreach ($entry in $files) {
        $digest = Get-FileSha256 $entry.File.FullName
        "$($entry.Relative)`t$($entry.File.Length)`t$digest`n"
    }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($inventory -join ''))
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Assert-SpoolerPayloadHash([string]$Root, $Release) {
    $expected = [string]$Release.payloadSha256
    if ($expected -notmatch '^[0-9a-fA-F]{64}$' -or (Get-SpoolerPayloadHash $Root) -ne $expected.ToLowerInvariant()) { throw 'Spooler payload hash mismatch.' }
}
function Invoke-Native([string]$File, [string[]]$Arguments) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $File" }
}
function Read-EnvFile([string]$Path) {
    $values = @{}
    if (Test-Path $Path) { Get-Content $Path | Where-Object { $_ -match '^[A-Z0-9_]+=' } | ForEach-Object { $key, $value = $_ -split '=', 2; $values[$key] = $value } }
    return $values
}
function Get-ServiceImagePath([string]$Name) {
    $serviceKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$Name"
    if (-not (Test-Path -LiteralPath $serviceKey)) { return $null }
    try { return [string](Get-ItemProperty -LiteralPath $serviceKey -Name ImagePath -ErrorAction Stop).ImagePath }
    catch { return $null }
}
function Get-RegisteredExecutablePath([string]$ImagePath) {
    if ([string]::IsNullOrWhiteSpace($ImagePath)) { return $null }
    $trimmed = $ImagePath.Trim()
    if ($trimmed.StartsWith('"')) {
        $closingQuote = $trimmed.IndexOf('"', 1)
        if ($closingQuote -lt 1) { return $null }
        return $trimmed.Substring(1, $closingQuote - 1)
    }
    if ($trimmed -match '^(?<path>.*?\.exe)(?:\s+.*)?$') { return $Matches.path.Trim() }
    return ($trimmed -split '\s+', 2)[0]
}
function Normalize-Path([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    try { return ([IO.Path]::GetFullPath($Path)).TrimEnd('\') }
    catch { return $null }
}
function Test-SamePath([string]$Left, [string]$Right) {
    $leftNormalized = Normalize-Path $Left
    $rightNormalized = Normalize-Path $Right
    return $null -ne $leftNormalized -and $null -ne $rightNormalized -and $leftNormalized.Equals($rightNormalized, [StringComparison]::OrdinalIgnoreCase)
}
function Wait-ServiceRemoved([string]$Name) {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        if (-not (Get-Service $Name -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Service $Name was not removed."
}
function Assert-ExclusiveInstallService {
    $known = @('POS Print Spooler', 'POSPrintSpooler', 'POSAPPSpooler')
    $present = @($known | Where-Object { Get-Service -Name $_ -ErrorAction SilentlyContinue })
    if ($present.Count -gt 1 -or ($present.Count -eq 1 -and $present[0] -ne $serviceName)) {
        throw "Exactly one current POS Print Spooler service is allowed; found: $($present -join ', ')."
    }
}
function Install-NssmBinary([string]$Archive, [string]$DestinationRoot, [string]$Destination) {
    New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null
    $extractRoot = Join-Path ([IO.Path]::GetTempPath()) "pos-spooler-nssm-$PID"
    try {
        if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
        Expand-Archive -LiteralPath $Archive -DestinationPath $extractRoot -Force
        $source = Get-ChildItem -LiteralPath $extractRoot -Recurse -File -Filter 'nssm.exe' |
            Where-Object { $_.FullName -match '(?i)[\\/]win64[\\/]nssm\.exe$' } |
            Select-Object -First 1
        if (-not $source) { throw 'NSSM x64 executable is missing from the pinned archive.' }
        Copy-Item -LiteralPath $source.FullName -Destination $Destination -Force
    }
    finally {
        if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }
    if (-not (Test-Path -LiteralPath $Destination -PathType Leaf)) { throw 'Stable NSSM executable was not installed.' }
}
function Configure-NssmService([string]$Nssm, [string]$Name, [string]$Node, [string]$Script, [string]$WorkingDirectory, [string]$EnvFile, [string]$StateDirectory, [string]$LogDirectory) {
    if (-not (Get-Service $Name -ErrorAction SilentlyContinue)) { Invoke-Native $Nssm @('install', $Name, $Node) }
    $quotedScript = '"""' + $Script + '"""'
    Invoke-Native $Nssm @('set', $Name, 'AppDirectory', $WorkingDirectory)
    Invoke-Native $Nssm @('set', $Name, 'AppParameters', $quotedScript)
    Invoke-Native $Nssm @('set', $Name, 'AppEnvironmentExtra', 'NODE_ENV=production', "SPOOLER_ENV_FILE=$EnvFile", "SPOOLER_STATE_DIR=$StateDirectory", "SPOOLER_LOG_DIR=$LogDirectory")
    Invoke-Native $Nssm @('set', $Name, 'AppStdout', (Join-Path $LogDirectory 'spooler-service.out.log'))
    Invoke-Native $Nssm @('set', $Name, 'AppStderr', (Join-Path $LogDirectory 'spooler-service.err.log'))
    Invoke-Native $Nssm @('set', $Name, 'AppRotateFiles', '1')
    Invoke-Native $Nssm @('set', $Name, 'AppRotateOnline', '1')
    Invoke-Native $Nssm @('set', $Name, 'AppRotateSeconds', '86400')
    Invoke-Native $Nssm @('set', $Name, 'AppRotateBytes', '1048576')
}

$configDir = Join-Path $ProgramDataRoot 'config'
$stateDir = Join-Path $ProgramDataRoot 'state'
$logDir = Join-Path $ProgramDataRoot 'logs'
$envFile = Join-Path $configDir 'spooler.env'
$serviceName = 'POS Print Spooler'
$daemonRoot = Join-Path $ProgramFilesRoot 'daemon'
$legacyExecutable = Join-Path $daemonRoot 'posprintspooler.exe'
$nssmRoot = Join-Path $ProgramFilesRoot 'runtime\nssm'
$nssmExecutable = Join-Path $nssmRoot 'nssm.exe'
$nssmArchive = Join-Path $PayloadRoot 'install\vendor\nssm-2.24.zip'
$warnings = [Collections.Generic.List[string]]::new()
$existing = Read-EnvFile $envFile
$allowedAdditionalEnv = @(
    'KITCHEN_BEEP_ENABLED', 'KITCHEN_BEEP_COUNT', 'KITCHEN_BEEP_DURATION',
    'RECEIPT_BEEP_ENABLED', 'RECEIPT_BEEP_COUNT', 'RECEIPT_BEEP_DURATION',
    'SPOOLER_MAX_LOCAL_JOBS', 'SPOOLER_TYPST_TIMEOUT_MS', 'SPOOLER_TYPST_MAX_HEIGHT'
)
$additionalEnv = [ordered]@{}
foreach ($key in $allowedAdditionalEnv) {
    if ($existing.ContainsKey($key)) { $additionalEnv[$key] = [string]$existing[$key] }
}
if ($ConfigFile) {
    if (-not (Test-Path $ConfigFile)) { throw 'Spooler response file is missing.' }
    $config = Get-Content -Raw $ConfigFile | ConvertFrom-Json
    $ServerUrl = $config.ServerUrl; $SpoolerKey = $config.SpoolerKey; $SpoolerId = $config.SpoolerId; $SpoolerName = $config.SpoolerName
    $additionalEnvProperty = $config.PSObject.Properties['AdditionalEnv']
    if ($additionalEnvProperty -and $additionalEnvProperty.Value) {
        foreach ($property in $additionalEnvProperty.Value.PSObject.Properties) {
            if ($property.Name -notin $allowedAdditionalEnv) { throw "Unsupported additional spooler setting: $($property.Name)" }
            $value = [string]$property.Value
            if ($value -match "[`r`n]") { throw "Invalid additional spooler setting: $($property.Name)" }
            $additionalEnv[$property.Name] = $value
        }
    }
}
$ServerUrl = if ([string]::IsNullOrWhiteSpace($ServerUrl)) { $existing.CLOUD_SERVER_URL } else { $ServerUrl }
$SpoolerKey = if ([string]::IsNullOrWhiteSpace($SpoolerKey)) { $existing.SPOOLER_KEY } else { $SpoolerKey }
$SpoolerId = if ([string]::IsNullOrWhiteSpace($SpoolerId)) { $existing.SPOOLER_ID } else { $SpoolerId }
$SpoolerName = if ([string]::IsNullOrWhiteSpace($SpoolerName)) { $existing.SPOOLER_NAME } else { $SpoolerName }
$ServerUrl = Get-SpoolerServerOrigin $ServerUrl
if ($SpoolerId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$') { throw 'Spooler ID is invalid.' }
if ([string]::IsNullOrWhiteSpace($SpoolerKey) -or [string]::IsNullOrWhiteSpace($SpoolerName)) { throw 'Spooler key and name are required.' }
if ($SpoolerKey -match "[`r`n]" -or $SpoolerName -match "[`r`n]") { throw 'Spooler key and name cannot contain line breaks.' }
$SpoolerName = $SpoolerName.Trim()
if ($SpoolerName.Length -gt 120) { throw 'Spooler name must be 120 characters or fewer.' }
foreach ($required in @('server.js', 'runtime\node\node.exe', 'package.json', 'release.json', 'install\vendor\nssm-2.24.zip', '.cache\typst\0.15.1\typst.exe', '.cache\typst\0.15.1\POSAPP-PATCH.txt', '.cache\typst\0.15.1\fonts\NotoSans.ttf', '.cache\typst\0.15.1\fonts\NotoSansArabic.ttf', '.cache\typst\0.15.1\fonts\NotoEmoji.ttf')) {
    if (-not (Test-Path (Join-Path $PayloadRoot $required))) { throw "Missing spooler payload: $required" }
}
function Get-SpoolerRegistrationStatus([string]$Origin, [string]$Key, [string]$Id) {
    try {
        return Invoke-RestMethod -Method Post -Uri "$Origin/api/spooler/v2/status" -Headers @{ 'x-spooler-key' = $Key } -Body (@{ spooler_id = $Id } | ConvertTo-Json) -ContentType 'application/json' -TimeoutSec 5
    }
    catch { return $null }
}
if ($WhatIfPreference) {
    [ordered]@{ serverUrl = $ServerUrl; spooler_id = $SpoolerId; name = $SpoolerName; mutates = $false } | ConvertTo-Json -Compress
    return
}
foreach ($required in @('server.js', 'v2', 'bin\PosSpoolerPlatform.exe')) {
    if (-not (Test-Path (Join-Path $PayloadRoot $required))) { throw "Missing spooler payload: $required" }
}
$health = $null
try {
    $health = Invoke-RestMethod -Uri "$ServerUrl/health" -TimeoutSec 10
    if ($health.status -ne 'ok' -or -not $health.release.version) { [void]$warnings.Add('SPOOLER_SERVER_UNHEALTHY') }
} catch {
    # Connectivity is reported continuously by the Print queue page. It must not
    # prevent the installer from laying down a valid local service.
    [void]$warnings.Add('SPOOLER_SERVER_UNREACHABLE')
}
$payloadRelease = Get-Content (Join-Path $PayloadRoot 'release.json') -Raw | ConvertFrom-Json
Assert-SpoolerPayloadHash $PayloadRoot $payloadRelease
$spoolerVersion = (Get-Content (Join-Path $PayloadRoot 'package.json') -Raw | ConvertFrom-Json).version
if ([string]::IsNullOrWhiteSpace($spoolerVersion)) { throw 'Spooler release version is missing.' }
if ($payloadRelease.spoolerVersion -ne $spoolerVersion) { throw 'Spooler payload release identity mismatch.' }
$preflightStatus = Get-SpoolerRegistrationStatus $ServerUrl $SpoolerKey $SpoolerId
$oldEnvContents = if (Test-Path $envFile) { Get-Content $envFile -Raw } else { $null }
Assert-ExclusiveInstallService
$service = Get-Service $serviceName -ErrorAction SilentlyContinue
$serviceExisted = [bool]$service
$serviceImagePath = Get-ServiceImagePath $serviceName
$registeredExecutable = Get-RegisteredExecutablePath $serviceImagePath
$serviceOwnership = 'absent'
if ($service) {
    if (Test-SamePath $registeredExecutable $nssmExecutable) { $serviceOwnership = 'nssm' }
    elseif (Test-SamePath $registeredExecutable $legacyExecutable) {
        $serviceOwnership = if (Test-Path -LiteralPath $legacyExecutable -PathType Leaf) { 'legacy' } else { 'broken-owned' }
    }
    else { throw 'POS Print Spooler is registered to an unexpected executable.' }
}
if ($serviceOwnership -eq 'legacy') { throw 'Legacy daemon-based spooler service cannot be installed over; remove it before installing the current package.' }
$serviceScriptBefore = $null
if ($serviceOwnership -eq 'nssm') {
    # `nssm install` registers the service before AppParameters exists - nssm writes
    # them on the next call - so an install killed in that window leaves our own
    # service with an empty entry point and no Parameters key. Reading it with
    # -ErrorAction Stop threw, and an empty value failed the allowed-scripts check
    # and threw too. A retry must treat an absent entry point as our unfinished
    # NSSM configuration and complete it below; one naming a different real
    # script still belongs to something else and still stops us.
    $storedService = Get-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$serviceName\Parameters" -ErrorAction SilentlyContinue
    $storedScript = if ($storedService) { ([string]$storedService.AppParameters).Trim('"').Trim() } else { '' }
    $allowedScripts = @((Normalize-Path (Join-Path $ProgramFilesRoot 'server.js')), (Normalize-Path (Join-Path $ProgramFilesRoot 'v2-server.js')))
    if ($storedScript) {
        $serviceScriptBefore = Normalize-Path $storedScript
        if ($serviceScriptBefore -notin $allowedScripts) { throw 'POS Print Spooler has an unexpected NSSM entry point.' }
    }
}
$installerMutex = Enter-SpoolerInstallerMutex
try {
    # Remove the obsolete recovery task once during upgrade. NSSM owns runtime
    # restarts; installation itself is retryable and has no boot-time journal.
    Unregister-ScheduledTask -TaskName 'POSAPP Spooler Startup Health Repair' -Confirm:$false -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $ProgramFilesRoot, $ProgramDataRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $configDir, $stateDir, $logDir | Out-Null
    Invoke-Native 'icacls.exe' @($ProgramDataRoot, '/reset', '/T', '/C')
    Invoke-Native 'icacls.exe' @($ProgramDataRoot, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)(F)', '*S-1-5-32-544:(OI)(CI)(F)', '/T', '/C')
    $temporary = "$envFile.$PID.tmp"
    $envLines = @("CLOUD_SERVER_URL=$ServerUrl", "SPOOLER_KEY=$SpoolerKey", "SPOOLER_ID=$SpoolerId", "SPOOLER_NAME=$SpoolerName", "SPOOLER_STATE_DIR=$stateDir", "SPOOLER_LOG_DIR=$logDir")
    foreach ($key in $allowedAdditionalEnv) { if ($additionalEnv.Contains($key)) { $envLines += "$key=$($additionalEnv[$key])" } }
    Write-Utf8NoBom $temporary ($envLines -join "`r`n")
    Move-Item -Force $temporary $envFile

    if ($service -and $service.Status -ne 'Stopped') { Stop-Service $serviceName -Force; $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) }
    $syncBaseline = Get-SpoolerRegistrationStatus $ServerUrl $SpoolerKey $SpoolerId
    $previousLastSyncAt = [string]$syncBaseline.last_sync_at
    $payloadPath = [IO.Path]::GetFullPath($PayloadRoot).TrimEnd('\')
    $installedPath = [IO.Path]::GetFullPath($ProgramFilesRoot).TrimEnd('\')
    if (-not $payloadPath.Equals($installedPath, [StringComparison]::OrdinalIgnoreCase)) { Copy-Item (Join-Path $PayloadRoot '*') $ProgramFilesRoot -Recurse -Force }

    if ($serviceOwnership -ne 'legacy') {
        Install-NssmBinary $nssmArchive $nssmRoot $nssmExecutable
        if ($serviceOwnership -eq 'absent') {
            if (Test-Path -LiteralPath $daemonRoot) { Remove-Item -LiteralPath $daemonRoot -Recurse -Force }
        }
        elseif ($serviceOwnership -eq 'broken-owned') {
            Invoke-Native 'sc.exe' @('delete', $serviceName)
            Wait-ServiceRemoved $serviceName
            if (Test-Path -LiteralPath $daemonRoot) { Remove-Item -LiteralPath $daemonRoot -Recurse -Force }
            $service = $null
        }
        $node = Join-Path $ProgramFilesRoot 'runtime\node\node.exe'
        $serverScript = Join-Path $ProgramFilesRoot 'server.js'
        Configure-NssmService $nssmExecutable $serviceName $node $serverScript $ProgramFilesRoot $envFile $stateDir $logDir
    }
    Invoke-Native 'sc.exe' @('config', $serviceName, 'start=', 'auto')
    Invoke-Native 'sc.exe' @('failure', $serviceName, 'reset=', '86400', 'actions=', 'restart/5000/restart/15000/0')
    Invoke-Native 'sc.exe' @('failureflag', 'POS Print Spooler', '1')

    Start-Service $serviceName
    (Get-Service $serviceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))

    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    $identityPath = Join-Path $stateDir 'agent.json'
    $identity = $null
    $status = $null
    do {
        try {
            if (Test-Path -LiteralPath $identityPath -PathType Leaf) {
                $identity = Get-Content -LiteralPath $identityPath -Raw | ConvertFrom-Json
                $status = Get-SpoolerRegistrationStatus $ServerUrl $SpoolerKey $SpoolerId
                if (Test-FreshSpoolerSync -Status $status -ExpectedAgentId ([string]$identity.agent_id) -PreviousLastSyncAt $previousLastSyncAt) { break }
            }
        }
        catch {}
        Start-Sleep -Milliseconds 750
    } while ([DateTime]::UtcNow -lt $deadline)
    $freshSync = $null -ne $identity -and (Test-FreshSpoolerSync -Status $status -ExpectedAgentId ([string]$identity.agent_id) -PreviousLastSyncAt $previousLastSyncAt)
    if (-not $freshSync) {
        [void]$warnings.Add('SPOOLER_NOT_YET_REGISTERED')
    }
    if (-not [string]::IsNullOrWhiteSpace($ResultFile)) {
        Write-Utf8NoBom $ResultFile ([ordered]@{
            status = 'installed'
            spoolerId = $SpoolerId
            spoolerVersion = $spoolerVersion
            warnings = @($warnings)
        } | ConvertTo-Json -Compress)
    }
    $serverVersion = if ($health -and $health.release.version) { [string]$health.release.version } else { 'unconfirmed' }
    Write-Output "POS Print Spooler installed for station $SpoolerId ($spoolerVersion; server $serverVersion)."
}
catch {
    $installFailure = $_
    Write-Utf8NoBom (Join-Path $logDir 'install-error.txt') "POS spooler provisioning failed.`r`n$($installFailure.Exception.Message)"
    throw $installFailure
}
finally {
    Exit-SpoolerInstallerMutex $installerMutex
}
