[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$RestaurantName,
    [int]$PosPort = 3000,
    [int]$DatabasePort = 3306,
    [int]$PhpMyAdminPort = 8081,
    [Parameter(Mandatory)] [string]$ServerStage,
    [Parameter(Mandatory)] [string]$VendorDir,
    [string]$ConfigFile,
    [string]$ResultFile,
    [string]$ProgramFilesRoot = 'C:\Program Files\POSApp',
    [string]$DatabaseRuntimeRoot = 'C:\Program Files\POSApp-MariaDB',
    [string]$ProgramDataRoot = 'C:\ProgramData\POSApp'
)
$ErrorActionPreference = 'Stop'

function Write-Utf8NoBom([string]$Path, [string]$Contents) {
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    [IO.File]::WriteAllText($Path, $Contents, [Text.UTF8Encoding]::new($false))
}
function Format-NativeArgument([string]$Value) {
    if ($Value -match '^(--password=|PASSWORD=|DB_PASSWORD=|SPOOLER_KEY=|[A-Z0-9_]*PASSWORD=)') {
        return ($Value -replace '=.*$', '=***')
    }
    if ($Value -match '[\s"]') { return '"' + ($Value -replace '"', '\"') + '"' }
    return $Value
}
function Format-NativeCommand([string]$File, [string[]]$Arguments) {
    $parts = @($File)
    foreach ($argument in $Arguments) { $parts += (Format-NativeArgument ([string]$argument)) }
    return ($parts -join ' ')
}
function Invoke-Native([string]$File, [string[]]$Arguments, [int[]]$AllowedExitCodes = @(0)) {
    & $File @Arguments
    if ($AllowedExitCodes -notcontains $LASTEXITCODE) { throw "Command failed ($LASTEXITCODE): $(Format-NativeCommand $File $Arguments)" }
}
function Stop-OwnedService([string]$Name) {
    $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $service -or $service.Status -eq 'Stopped') { return }
    Stop-Service -Name $Name -Force -ErrorAction Stop
    $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
}
function Remove-OwnedService([string]$Name) {
    if (-not (Get-Service -Name $Name -ErrorAction SilentlyContinue)) { return }
    Stop-OwnedService $Name
    Invoke-Native 'sc.exe' @('delete', $Name)
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 500
        if (-not (Get-Service -Name $Name -ErrorAction SilentlyContinue)) { return }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out deleting service $Name."
}
function Get-LogTail([string]$Path, [int]$Lines = 60) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) { return '' }
    $tail = @(Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction SilentlyContinue)
    if ($tail.Count -eq 0) { return '' }
    return ($tail -join "`r`n")
}
function Set-InstallPhase([string]$Phase) {
    $script:currentPhase = $Phase
    Write-Host "Install phase: $Phase"
}
function Start-OwnedService([string]$Name, [string]$FailureLog = '') {
    $service = Get-Service -Name $Name -ErrorAction Stop
    if ($service.Status -eq 'Running') { return }
    try {
        Start-Service -Name $Name -ErrorAction Stop
        $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    } catch {
        $message = $_.Exception.Message
        $tail = Get-LogTail $FailureLog
        if (-not [string]::IsNullOrWhiteSpace($tail)) { $message = "$message`r`n$Name stderr tail:`r`n$tail" }
        throw $message
    }
}
function Assert-PortAvailable([int]$Port) {
    if ($Port -lt 1 -or $Port -gt 65535) { throw "Invalid port: $Port" }
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    try { $listener.Start() }
    catch { throw "Port $Port is already occupied." }
    finally { $listener.Stop() }
}
function Test-TcpPort([int]$Port, [int]$TimeoutMilliseconds = 250) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $connect = $client.ConnectAsync([System.Net.IPAddress]::Loopback, $Port)
        if ($connect.Wait($TimeoutMilliseconds)) { return $client.Connected }
    } catch {}
    finally { $client.Dispose() }
    return $false
}
function Wait-TcpPort([int]$Port, [int]$TimeoutSeconds = 90, [string]$ServiceName = '') {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (Test-TcpPort $Port) { return }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    $details = @("Timed out waiting for port $Port.")
    if ($ServiceName) {
        $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        $state = if ($service) { [string]$service.Status } else { 'not installed' }
        $details += "$ServiceName service state: $state"
    }
    $logCandidates = @()
    if ($ServiceName) { $logCandidates += Join-Path $logDir "$ServiceName.err.log" }
    $logCandidates += Join-Path $logDir 'posapp-service.err.log'
    $logCandidates += Join-Path $logDir 'install.log'
    $tail = ''
    foreach ($candidate in $logCandidates) {
        $tail = Get-LogTail $candidate
        if (-not [string]::IsNullOrWhiteSpace($tail)) { break }
    }
    if (-not [string]::IsNullOrWhiteSpace($tail)) { $details += "Service stderr tail:`r`n$tail" }
    throw ($details -join "`r`n")
}
function Wait-Http([string]$Url, [int]$TimeoutSeconds = 90) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastError = ''
    do {
        try { $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2; if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return } }
        catch { $lastError = $_.Exception.Message }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    $message = "Timed out waiting for $Url."
    if (-not [string]::IsNullOrWhiteSpace($lastError)) { $message += "`r`nLast HTTP error: $lastError" }
    throw $message
}
function Set-PrivateAcl([string]$Target) {
    if (Test-Path -LiteralPath $Target -PathType Container) {
        Invoke-Native 'icacls.exe' @($Target, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)(F)', '*S-1-5-32-544:(OI)(CI)(F)')
        return
    }
    Invoke-Native 'icacls.exe' @($Target, '/inheritance:r', '/grant:r', '*S-1-5-18:F', '*S-1-5-32-544:F')
}
function Reset-IncompleteFreshMariaDb([string]$DataRoot, [string]$RuntimeRoot) {
    if (Test-Path -LiteralPath (Join-Path $DataRoot 'posapp')) {
        throw "Existing POS database found at $DataRoot without POSAPP install metadata; refusing to overwrite it."
    }
    Remove-OwnedService 'POSAppMariaDB'
    if (Test-Path -LiteralPath $DataRoot) { Remove-Item -LiteralPath $DataRoot -Recurse -Force }
    if (Test-Path -LiteralPath $RuntimeRoot) { Remove-Item -LiteralPath $RuntimeRoot -Recurse -Force }
}
function Format-InstallError($ErrorRecord) {
    $details = @('POSAPP server provisioning failed.', "Failed phase: $script:currentPhase", $ErrorRecord.Exception.Message)
    if ($ErrorRecord.InvocationInfo -and $ErrorRecord.InvocationInfo.PositionMessage) { $details += $ErrorRecord.InvocationInfo.PositionMessage }
    return ($details | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join "`r`n"
}
function Write-FailureReport($ErrorRecord) {
    $message = Format-InstallError $ErrorRecord
    foreach ($target in @($ResultFile, (Join-Path $logDir 'install-error.txt'))) {
        if ([string]::IsNullOrWhiteSpace($target)) { continue }
        try { Write-Utf8NoBom $target $message } catch {}
    }
}
function Resolve-ArchiveRoot([string]$Directory, [string]$Marker) {
    if (Test-Path -LiteralPath (Join-Path $Directory $Marker)) { return $Directory }
    $markerParts = @($Marker -split '[\\/]+')
    $matches = @(Get-ChildItem -LiteralPath $Directory -Recurse -File -Filter (Split-Path -Leaf $Marker) | ForEach-Object {
        $root = $_.FullName
        foreach ($part in $markerParts) { $root = Split-Path -Parent $root }
        if (Test-Path -LiteralPath (Join-Path $root $Marker)) { $root }
    } | Sort-Object -Unique)
    if ($matches.Count -eq 0) {
        $entries = @((Get-ChildItem -LiteralPath $Directory -Force -ErrorAction SilentlyContinue | Select-Object -First 10 -ExpandProperty Name) -join ', ')
        if ([string]::IsNullOrWhiteSpace($entries)) { $entries = 'none' }
        throw "Archive marker missing under $Directory ($Marker). Extracted entries: $entries."
    }
    if ($matches.Count -gt 1) {
        $matches = @($matches | Sort-Object @{ Expression = {
            $relative = [string]$_
            if ($relative.StartsWith($Directory, [StringComparison]::OrdinalIgnoreCase)) { $relative = $relative.Substring($Directory.Length).TrimStart([char[]]@('\', '/')) }
            (@($relative -split '[\\/]+')).Count
        }}, @{ Expression = { $_ }})
        Write-Host "Archive root has multiple matches for $Marker; using $($matches[0])."
    }
    return $matches[0]
}
function Render([string]$Template, [string]$Output, [hashtable]$Values) {
    $valuesPath = Join-Path $env:TEMP "pos-render-$PID.json"
    Write-Utf8NoBom $valuesPath ($Values | ConvertTo-Json -Depth 5)
    try { Invoke-Native $nodeExe @($configTool, 'write-server-config', '--template', $Template, '--output', $Output, '--values', $valuesPath) }
    finally { Remove-Item $valuesPath -Force -ErrorAction SilentlyContinue }
}

$created = [ordered]@{ firewall=$false; task=$false; startupRepairTask=$false; posService=$false; apacheService=$false; mariaService=$false }
$programDataExisted = $false
$secretPath = $null
$bootstrapConfig = $null
$logDir = Join-Path $ProgramDataRoot 'logs'
$metadataPath = Join-Path $ProgramDataRoot 'install.json'
$repair = $false
$transcriptStarted = $false
$currentPhase = 'preflight'

try {
if ($ConfigFile) {
    if (-not (Test-Path -LiteralPath $ConfigFile)) { throw 'Server response file is missing.' }
    $config = Get-Content -Raw -LiteralPath $ConfigFile | ConvertFrom-Json
    $RestaurantName = $config.RestaurantName
    $PosPort = [int]$config.PosPort
    $DatabasePort = [int]$config.DatabasePort
    $PhpMyAdminPort = [int]$config.PhpMyAdminPort
}
$repair = Test-Path -LiteralPath $metadataPath
if ($repair) {
    $metadata = Get-Content -Raw $metadataPath | ConvertFrom-Json
    if (-not $metadata.release -or $metadata.appId -ne '{E99DB275-DDA0-43A0-95CD-7AE07185122C}') { throw 'Existing POS installation ownership is inconsistent; manual inspection is required.' }
    if ([string]::IsNullOrWhiteSpace($RestaurantName)) { $RestaurantName = [string]$metadata.restaurant }
    $PosPort = [int]$metadata.posPort
    $DatabasePort = [int]$metadata.databasePort
    $PhpMyAdminPort = [int]$metadata.phpMyAdminPort
}
if ([string]::IsNullOrWhiteSpace($RestaurantName)) { throw 'RestaurantName is required.' }
foreach ($port in @($PosPort, $DatabasePort, $PhpMyAdminPort)) { if ($port -lt 1 -or $port -gt 65535) { throw "Invalid port: $port" } }
if ((@($PosPort, $DatabasePort, $PhpMyAdminPort) | Select-Object -Unique).Count -ne 3) { throw 'Service ports must be unique.' }
if ($WhatIfPreference) {
    [ordered]@{ mode=$(if($repair){'repair'}else{'fresh'}); restaurant=$RestaurantName; posPort=$PosPort; databasePort=$DatabasePort; phpMyAdminPort=$PhpMyAdminPort; mutates=$false } | ConvertTo-Json -Compress
    return
}

$programDataExisted = Test-Path $ProgramDataRoot
    New-Item -ItemType Directory -Force -Path $ProgramDataRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    Start-Transcript -Path (Join-Path $logDir 'install.log') -Append | Out-Null
    $transcriptStarted = $true
    Set-PrivateAcl $ProgramDataRoot
    # Ordered transaction: port checks → VC runtime → MariaDB → bind-address → bootstrap → migrations → Apache/PHP/phpMyAdmin → POS → backup → verification.
    Set-InstallPhase 'preflight'
    if (-not $repair) { Assert-PortAvailable $PosPort; Assert-PortAvailable $DatabasePort; Assert-PortAvailable $PhpMyAdminPort }
    else { Stop-OwnedService 'POSApp'; Stop-OwnedService 'POSAppPhpMyAdmin'; Stop-OwnedService 'POSAppMariaDB' }

    New-Item -ItemType Directory -Force -Path $ProgramFilesRoot | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $ProgramDataRoot 'uploads'), (Join-Path $ProgramDataRoot 'backups'), (Join-Path $ProgramDataRoot 'sessions') | Out-Null
    $nodeExe = Join-Path $ServerStage 'runtime\node\node.exe'
    $configTool = Join-Path $ServerStage 'deployment\tools\installer-config.js'
    $configDir = Join-Path $ProgramDataRoot 'config'
    $envFile = Join-Path $configDir 'pos.env'
    $backupEnvFile = Join-Path $configDir 'backup.env'
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null

    Set-InstallPhase 'secrets-and-vc-runtime'
    if ($repair) {
        if (-not (Test-Path $envFile)) { throw 'Existing installation has no protected environment file.' }
        $envValues = @{}
        Get-Content $envFile | Where-Object { $_ -match '^[A-Z0-9_]+=' } | ForEach-Object { $key, $value = $_ -split '=', 2; $envValues[$key] = $value }
        $backupValues = @{}
        if (Test-Path $backupEnvFile) { Get-Content $backupEnvFile | Where-Object { $_ -match '^[A-Z0-9_]+=' } | ForEach-Object { $key, $value = $_ -split '=', 2; $backupValues[$key] = $value } }
        if (-not $envValues.DB_PASSWORD -or -not $envValues.SPOOLER_KEY -or -not $backupValues.DB_PASSWORD) { throw 'Existing installation credentials are incomplete.' }
        $secrets = [pscustomobject]@{ appPassword=$envValues.DB_PASSWORD; spoolerKey=$envValues.SPOOLER_KEY; maintenancePassword=$backupValues.DB_PASSWORD }
    } else {
        $secretPath = Join-Path $configDir 'secrets.json'
        if (Test-Path -LiteralPath $secretPath) {
            Set-PrivateAcl $secretPath
            Remove-Item -LiteralPath $secretPath -Force
        }
        Invoke-Native $nodeExe @($configTool, 'generate-secrets', '--output', $secretPath)
        Set-PrivateAcl $secretPath
        $secrets = Get-Content -Raw $secretPath | ConvertFrom-Json
        $vc = Join-Path $VendorDir 'vc_redist.x64.exe'
        Invoke-Native -File $vc -Arguments @('/install', '/quiet', '/norestart') -AllowedExitCodes @(0, 3010)
        Set-InstallPhase 'mariadb-instance'
        $dbRuntime = $DatabaseRuntimeRoot
        $dbRoot = Join-Path $ProgramDataRoot 'database'
        Reset-IncompleteFreshMariaDb $dbRoot $dbRuntime
        $mariaRuntimeSource = Join-Path $ServerStage 'install\mariadb-runtime'
        if (-not (Test-Path -LiteralPath (Join-Path $mariaRuntimeSource 'bin\mariadbd.exe'))) { throw "Packaged MariaDB runtime is missing from $mariaRuntimeSource." }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dbRuntime) | Out-Null
        Move-Item -LiteralPath $mariaRuntimeSource -Destination $dbRuntime
        Set-PrivateAcl $dbRuntime
        $created.mariaService = $true
        $mariaInstallDb = Join-Path $dbRuntime 'bin\mariadb-install-db.exe'
        if (-not (Test-Path -LiteralPath $mariaInstallDb)) { $mariaInstallDb = Join-Path $dbRuntime 'bin\mysql_install_db.exe' }
        if (-not (Test-Path -LiteralPath $mariaInstallDb)) { throw "MariaDB instance creation tool is missing from $dbRuntime." }
        Invoke-Native -File $mariaInstallDb -Arguments @("--datadir=$dbRoot", '--service=POSAppMariaDB', "--port=$DatabasePort", '--verbose-bootstrap')
        if (-not (Get-Service -Name 'POSAppMariaDB' -ErrorAction SilentlyContinue)) { throw 'MariaDB instance creation did not register POSAppMariaDB. Check install.log.' }
    }

    Set-InstallPhase 'mariadb-instance'
    $dbRuntime = $DatabaseRuntimeRoot
    $dbRoot = Join-Path $ProgramDataRoot 'database'
    $mariaRuntimeSource = Join-Path $ServerStage 'install\mariadb-runtime'
    if ($repair -and -not (Test-Path -LiteralPath (Join-Path $dbRuntime 'bin\mariadbd.exe'))) {
        if (-not (Test-Path -LiteralPath (Join-Path $mariaRuntimeSource 'bin\mariadbd.exe'))) { throw 'Installed and packaged MariaDB runtime binaries are both missing.' }
        New-Item -ItemType Directory -Force -Path $dbRuntime | Out-Null
        Copy-Item (Join-Path $mariaRuntimeSource '*') $dbRuntime -Recurse -Force
        Set-PrivateAcl $dbRuntime
    }
    Stop-OwnedService 'POSAppMariaDB'
    $myCnf = Join-Path $dbRoot 'my.ini'
    $mariaServiceMissing = -not (Get-Service -Name 'POSAppMariaDB' -ErrorAction SilentlyContinue)
    if ($repair -and $mariaServiceMissing) {
        if (-not (Test-Path -LiteralPath $myCnf) -or -not (Test-Path -LiteralPath (Join-Path $dbRoot 'mysql') -PathType Container)) {
            throw 'Cannot restore POSAppMariaDB service registration without the existing initialized MariaDB data directory and my.ini. No database initialization was attempted.'
        }
    }
    Write-Utf8NoBom $myCnf (@('[mysqld]', 'bind-address=127.0.0.1', "port=$DatabasePort", "datadir=$($dbRoot.Replace('\','/'))", 'character-set-server=utf8mb4', 'collation-server=utf8mb4_unicode_ci') -join "`r`n")
    if ($repair -and $mariaServiceMissing) {
        $mariadbd = Join-Path $dbRuntime 'bin\mariadbd.exe'
        Invoke-Native $mariadbd @("--defaults-file=$myCnf", '--install', 'POSAppMariaDB')
        if (-not (Get-Service -Name 'POSAppMariaDB' -ErrorAction SilentlyContinue)) { throw 'MariaDB service registration repair did not create POSAppMariaDB.' }
    }
    Invoke-Native 'sc.exe' @('config', 'POSAppMariaDB', 'start=', 'auto')
    Invoke-Native 'sc.exe' @('failure', 'POSAppMariaDB', 'reset=', '86400', 'actions=', 'restart/5000/restart/15000/0')
    Invoke-Native 'sc.exe' @('failureflag', 'POSAppMariaDB', '1')
    Start-OwnedService 'POSAppMariaDB'
    Wait-TcpPort $DatabasePort 90 'POSAppMariaDB'

    Set-InstallPhase 'database-bootstrap-and-migrations'
    if (-not $repair) {
        Render (Join-Path $ServerStage 'deployment\templates\pos.env.template') $envFile @{
            POS_PORT=$PosPort; DB_PORT=$DatabasePort; DB_APP_PASSWORD=$secrets.appPassword; SPOOLER_KEY=$secrets.spoolerKey;
            DATA_DIR=$ProgramDataRoot; UPLOAD_DIR=(Join-Path $ProgramDataRoot 'uploads'); LOG_DIR=$logDir;
            BACKUP_DIR=(Join-Path $ProgramDataRoot 'backups'); MARIADB_DUMP_EXE=(Join-Path $dbRuntime 'bin\mariadb-dump.exe')
        }
        Set-PrivateAcl $envFile
        $backupEnvLines = @('NODE_ENV=production', 'LOG_LEVEL=info', "POSAPP_LOG_DIR=$logDir", 'DB_HOST=127.0.0.1', "DB_PORT=$DatabasePort", 'DB_NAME=posapp', 'DB_USER=posapp_maintenance', "DB_PASSWORD=$($secrets.maintenancePassword)", "POSAPP_BACKUP_DIR=$(Join-Path $ProgramDataRoot 'backups')", "MYSQLDUMP_PATH=$(Join-Path $dbRuntime 'bin\mariadb-dump.exe')")
        Write-Utf8NoBom $backupEnvFile ($backupEnvLines -join "`r`n")
        Set-PrivateAcl $backupEnvFile
        $bootstrapConfig = Join-Path $configDir 'bootstrap.json'
        $bootstrap = @{ host='127.0.0.1'; port=$DatabasePort; adminUser='root'; initialAdminPassword=''; adminPassword=$secrets.rootPassword; database='posapp'; appUser='posapp_runtime'; appPassword=$secrets.appPassword; maintenanceUser='posapp_maintenance'; maintenancePassword=$secrets.maintenancePassword; adminUserNumber='009384'; adminName='Administrator'; programmerUserNumber=$secrets.programmerUserNumber; programmerName='Programmer' }
        Write-Utf8NoBom $bootstrapConfig ($bootstrap | ConvertTo-Json)
        Set-PrivateAcl $bootstrapConfig
        Invoke-Native $nodeExe @((Join-Path $ServerStage 'deployment\tools\bootstrap-database.js'), '--config', $bootstrapConfig)
    }

    # Fresh baselines normally skip every entry. Repairs use the protected DDL account
    # before the restricted POS runtime account starts the server.
    Invoke-Native $nodeExe @((Join-Path $ServerStage 'deployment\tools\run-pending-migrations.js'), '--env', $backupEnvFile)

    Set-InstallPhase 'apache-phpmyadmin'
    $webRoot = Join-Path $ProgramFilesRoot 'web-tools'
    $existingPmaConfig = $null
    $durablePmaConfig = Join-Path $configDir 'phpmyadmin.inc.php'
    if ($repair -and (Test-Path $durablePmaConfig)) { $existingPmaConfig = Get-Content $durablePmaConfig -Raw }
    elseif ($repair -and (Test-Path $webRoot)) {
        $oldPmaConfig = Get-ChildItem $webRoot -Filter config.inc.php -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($oldPmaConfig) { $existingPmaConfig = Get-Content $oldPmaConfig.FullName -Raw }
    }
    if (Test-Path $webRoot) { Remove-Item -LiteralPath $webRoot -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $webRoot | Out-Null
    $apacheDir = Join-Path $webRoot 'apache'; $phpDir = Join-Path $webRoot 'php'; $pmaDir = Join-Path $webRoot 'phpmyadmin'
    Expand-Archive (Join-Path $VendorDir 'httpd-2.4.68-260617-Win64-VS18.zip') $apacheDir -Force
    Expand-Archive (Join-Path $VendorDir 'php-8.4.16-Win32-vs17-x64.zip') $phpDir -Force
    Expand-Archive (Join-Path $VendorDir 'phpMyAdmin-5.2.3-all-languages.zip') $pmaDir -Force
    $apacheRoot = Resolve-ArchiveRoot $apacheDir 'bin\httpd.exe'
    $phpRoot = Resolve-ArchiveRoot $phpDir 'php.exe'
    $pmaRoot = Resolve-ArchiveRoot $pmaDir 'index.php'
    $apacheConf = Join-Path $apacheRoot 'conf\httpd.conf'
    Render (Join-Path $ServerStage 'deployment\templates\httpd.conf.template') $apacheConf @{ APACHE_ROOT=$apacheRoot; PHPMYADMIN_ROOT=$pmaRoot; PHPMYADMIN_PORT=$PhpMyAdminPort; PHP_ROOT=$phpRoot; LOG_DIR=$logDir }
    Render (Join-Path $ServerStage 'deployment\templates\php.ini.template') (Join-Path $phpRoot 'php.ini') @{ PHP_ROOT=$phpRoot; LOG_DIR=$logDir; SESSION_DIR=(Join-Path $ProgramDataRoot 'sessions') }
    if (-not $repair) {
        Render (Join-Path $ServerStage 'deployment\templates\config.inc.php.template') $durablePmaConfig @{ BLOWFISH_SECRET=$secrets.blowfishSecret; DB_PORT=$DatabasePort }
        Set-PrivateAcl $durablePmaConfig
        Copy-Item $durablePmaConfig (Join-Path $pmaRoot 'config.inc.php') -Force
    }
    elseif ($existingPmaConfig) { Write-Utf8NoBom (Join-Path $pmaRoot 'config.inc.php') $existingPmaConfig }
    else { throw 'Existing phpMyAdmin configuration is missing.' }
    $httpdExe = Join-Path $apacheRoot 'bin\httpd.exe'
    Invoke-Native $httpdExe @('-t', '-f', $apacheConf)
    if (-not (Get-Service 'POSAppPhpMyAdmin' -ErrorAction SilentlyContinue)) { $created.apacheService = $true; Invoke-Native $httpdExe @('-k', 'install', '-n', 'POSAppPhpMyAdmin', '-f', $apacheConf) }
    Invoke-Native 'sc.exe' @('config', 'POSAppPhpMyAdmin', 'start=', 'auto')
    Invoke-Native 'sc.exe' @('failure', 'POSAppPhpMyAdmin', 'reset=', '86400', 'actions=', 'restart/5000/restart/15000/0')
    Invoke-Native 'sc.exe' @('failureflag', 'POSAppPhpMyAdmin', '1')
    Start-OwnedService 'POSAppPhpMyAdmin'
    Wait-Http "http://127.0.0.1:$PhpMyAdminPort/"

    Set-InstallPhase 'pos-service'
    $nssmExtract = Join-Path $ProgramDataRoot 'tmp\nssm'
    if (Test-Path $nssmExtract) { Remove-Item $nssmExtract -Recurse -Force }
    Expand-Archive (Join-Path $VendorDir 'nssm-2.24.zip') $nssmExtract -Force
    $nssm = (Get-ChildItem $nssmExtract -Filter nssm.exe -Recurse | Where-Object FullName -Match 'win64' | Select-Object -First 1).FullName
    if (-not $nssm) { throw 'NSSM x64 executable is missing.' }
    $posNodeExe = Join-Path $ProgramFilesRoot 'runtime\node\node.exe'
    $posScript = Join-Path $ProgramFilesRoot 'server.js'
    # Windows PowerShell 5 strips one quote layer before NSSM sees AppParameters.
    $nssmQuotedPosScript = '"""' + $posScript + '"""'
    if (-not (Get-Service 'POSApp' -ErrorAction SilentlyContinue)) { $created.posService = $true; Invoke-Native $nssm @('install', 'POSApp', $posNodeExe) }
    $posStdout = Join-Path $logDir 'posapp-service.out.log'
    $posStderr = Join-Path $logDir 'posapp-service.err.log'
    Invoke-Native $nssm @('set', 'POSApp', 'AppDirectory', $ProgramFilesRoot)
    Invoke-Native $nssm @('set', 'POSApp', 'AppParameters', $nssmQuotedPosScript)
    Invoke-Native $nssm @('set', 'POSApp', 'AppEnvironmentExtra', 'NODE_ENV=production', "POSAPP_ENV_FILE=$envFile")
    Invoke-Native $nssm @('set', 'POSApp', 'AppStdout', $posStdout)
    Invoke-Native $nssm @('set', 'POSApp', 'AppStderr', $posStderr)
    Invoke-Native $nssm @('set', 'POSApp', 'AppRotateFiles', '1')
    Invoke-Native $nssm @('set', 'POSApp', 'AppRotateOnline', '1')
    Invoke-Native $nssm @('set', 'POSApp', 'AppRotateSeconds', '86400')
    Invoke-Native $nssm @('set', 'POSApp', 'AppRotateBytes', '1048576')
    $nssmConfig = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Services\POSApp\Parameters'
    if ([string]$nssmConfig.Application -ne $posNodeExe) { throw 'NSSM stored an invalid POS application path.' }
    if ([string]$nssmConfig.AppDirectory -ne $ProgramFilesRoot) { throw 'NSSM stored an invalid POS working directory.' }
    if ([string]$nssmConfig.AppParameters -ne ('"' + $posScript + '"')) { throw 'NSSM stored invalid POS application parameters.' }
    $nssmEnvironment = @($nssmConfig.AppEnvironmentExtra)
    if ($nssmEnvironment -notcontains 'NODE_ENV=production' -or $nssmEnvironment -notcontains "POSAPP_ENV_FILE=$envFile") { throw 'NSSM stored an invalid POS environment.' }
    Invoke-Native 'sc.exe' @('config', 'POSApp', 'start=', 'auto', 'depend=', 'POSAppMariaDB')
    Invoke-Native 'sc.exe' @('failure', 'POSApp', 'reset=', '86400', 'actions=', 'restart/5000/restart/15000/0')
    Invoke-Native 'sc.exe' @('failureflag', 'POSApp', '1')
    Start-OwnedService 'POSApp' $posStderr
    Wait-Http "http://127.0.0.1:$PosPort/health"

    Set-InstallPhase 'backup-and-verification'
    $firewall = Get-NetFirewallRule -DisplayName 'POSAPP POS Server' -ErrorAction SilentlyContinue
    if ($firewall) { Remove-NetFirewallRule -DisplayName 'POSAPP POS Server' }
    New-NetFirewallRule -DisplayName 'POSAPP POS Server' -Direction Inbound -Protocol TCP -LocalPort $PosPort -Action Allow -Profile Private | Out-Null
    $created.firewall = -not $repair

    $backupDir = Join-Path $ProgramDataRoot 'backups'
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    $backupFile = Join-Path $backupDir "install-verify-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss')).sql.gz"
    $env:POSAPP_ENV_FILE = $backupEnvFile
    $env:MYSQLDUMP_PATH = Join-Path $dbRuntime 'bin\mariadb-dump.exe'
    Invoke-Native $nodeExe @((Join-Path $ProgramFilesRoot 'scripts\db-backup.js'), '--output', $backupFile)
    $expectedBackupSha256 = ((Get-Content "$backupFile.sha256" -Raw) -split '\s+')[0]

    $taskAction = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/d /c set POSAPP_ENV_FILE=$backupEnvFile&& set MYSQLDUMP_PATH=$env:MYSQLDUMP_PATH&& `"$nodeExe`" `"$(Join-Path $ProgramFilesRoot 'scripts\db-backup.js')`""
    $taskTrigger = New-ScheduledTaskTrigger -Daily -At '02:00'
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName 'POSAPP Database Backup' -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Force | Out-Null
    $created.task = -not $repair

    $startupRepairTaskName = 'POSAPP Startup Health Repair'
    $startupRepairScript = Join-Path $ProgramFilesRoot 'deployment\windows\Repair-PosStartup.ps1'
    if (-not (Test-Path -LiteralPath $startupRepairScript)) { throw "Startup repair script is missing: $startupRepairScript" }
    $startupRepairAction = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$startupRepairScript`" -StartupDelaySeconds 60"
    $startupRepairTrigger = New-ScheduledTaskTrigger -AtStartup
    $startupRepairPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $startupRepairSettings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 2) -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable
    Register-ScheduledTask -TaskName $startupRepairTaskName -Action $startupRepairAction -Trigger $startupRepairTrigger -Principal $startupRepairPrincipal -Settings $startupRepairSettings -Force | Out-Null
    $created.startupRepairTask = -not $repair

    Set-InstallPhase 'shortcuts-and-metadata'
    $release = Get-Content (Join-Path $ServerStage 'release.json') -Raw | ConvertFrom-Json
    $verifyConfig = Join-Path $configDir 'verify.json'
    $verify = @{ host='127.0.0.1'; dbPort=$DatabasePort; dbUser='posapp_runtime'; dbPassword=$secrets.appPassword; healthUrl="http://127.0.0.1:$PosPort/health"; phpMyAdminUrl="http://127.0.0.1:$PhpMyAdminPort/"; backupFile=$backupFile; expectedBackupSha256=$expectedBackupSha256; expectedVersion=$release.version; expectedCommit=$release.commit; expectedSchemaVersion=$release.schemaVersion; expectFresh=(-not $repair); durableDirs=@((Join-Path $ProgramDataRoot 'uploads'), $logDir, $backupDir) }
    Write-Utf8NoBom $verifyConfig ($verify | ConvertTo-Json -Depth 5)
    Set-PrivateAcl $verifyConfig
    Invoke-Native $nodeExe @((Join-Path $ProgramFilesRoot 'deployment\tools\verify-install.js'), '--config', $verifyConfig)

    $installMetadata = @{ appId='{E99DB275-DDA0-43A0-95CD-7AE07185122C}'; restaurant=$RestaurantName; posPort=$PosPort; databasePort=$DatabasePort; phpMyAdminPort=$PhpMyAdminPort; release=$release }
    Write-Utf8NoBom $metadataPath ($installMetadata | ConvertTo-Json -Depth 5)

    # Shortcuts are written here, not by the setup wizard: on repair the wizard shows default ports while the real ports come from install.json.
    $desktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
    Write-Utf8NoBom (Join-Path $desktop 'POS App.url') ("[InternetShortcut]`r`nURL=http://localhost:$PosPort/pos`r`n")
    Write-Utf8NoBom (Join-Path $desktop 'POS Database Admin.url') ("[InternetShortcut]`r`nURL=http://localhost:$PhpMyAdminPort/`r`n")
    if ($ResultFile) {
        $completionLines = @(
            'POS App installed successfully.',
            '',
            "POS URL: http://localhost:$PosPort/pos",
            "phpMyAdmin URL: http://localhost:$PhpMyAdminPort/",
            '',
            'phpMyAdmin user: posapp_maintenance',
            "phpMyAdmin password: $($secrets.maintenancePassword)",
            "Spooler key: $($secrets.spoolerKey)",
            ''
        )
        if (-not $repair) {
            $completionLines += "Programmer login number: $($secrets.programmerUserNumber)"
            $completionLines += ''
        }
        $completionLines += @(
            'Save these before closing this window. The programmer login is shown only once; infrastructure credentials remain in protected ProgramData config files.'
        )
        $completion = $completionLines -join "`r`n"
        Write-Utf8NoBom $ResultFile $completion
    }
} catch {
    $installError = $_
    Write-FailureReport $installError
    if (-not $repair) {
        if ($created.startupRepairTask) { Unregister-ScheduledTask -TaskName 'POSAPP Startup Health Repair' -Confirm:$false -ErrorAction SilentlyContinue }
        if ($created.task) { Unregister-ScheduledTask -TaskName 'POSAPP Database Backup' -Confirm:$false -ErrorAction SilentlyContinue }
        if ($created.posService) { try { Remove-OwnedService 'POSApp' } catch { Write-Warning "POS service rollback failed: $($_.Exception.Message)" } }
        if ($created.apacheService) { try { Remove-OwnedService 'POSAppPhpMyAdmin' } catch { Write-Warning "Apache service rollback failed: $($_.Exception.Message)" } }
        if ($created.mariaService) {
            try { Remove-OwnedService 'POSAppMariaDB' } catch { Write-Warning "MariaDB service rollback failed: $($_.Exception.Message)" }
            Remove-Item -LiteralPath $dbRoot -Recurse -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $dbRuntime -Recurse -Force -ErrorAction SilentlyContinue
        }
        if ($created.firewall) { Remove-NetFirewallRule -DisplayName 'POSAPP POS Server' -ErrorAction SilentlyContinue }
        if (-not $programDataExisted) {
            foreach ($child in @('config', 'database', 'uploads', 'backups', 'sessions', 'tmp')) {
                Remove-Item (Join-Path $ProgramDataRoot $child) -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    } else {
        try {
            if (-not (Get-NetFirewallRule -DisplayName 'POSAPP POS Server' -ErrorAction SilentlyContinue)) {
                New-NetFirewallRule -DisplayName 'POSAPP POS Server' -Direction Inbound -Protocol TCP -LocalPort $PosPort -Action Allow -Profile Private | Out-Null
            }
        } catch {}
        foreach ($service in @('POSAppMariaDB', 'POSAppPhpMyAdmin', 'POSApp')) { try { Start-OwnedService $service } catch {} }
    }
    throw $installError
} finally {
    if ($secretPath) { Remove-Item $secretPath -Force -ErrorAction SilentlyContinue }
    if ($bootstrapConfig) { Remove-Item $bootstrapConfig -Force -ErrorAction SilentlyContinue }
    if ($transcriptStarted) { Stop-Transcript | Out-Null }
}
