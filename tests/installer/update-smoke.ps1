[CmdletBinding()]
param(
    [string]$ExpectedServerVersion,
    [string]$ExpectedServerCommit,
    [string]$ExpectedSpoolerVersion,
    [string]$ExpectedSpoolerCommit,
    [switch]$IncludeSpooler,
    [switch]$AfterReboot,
    [string]$ResultDirectory,
    [string]$BaselinePath,
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ResultDirectory)) { $ResultDirectory = Join-Path $PSScriptRoot 'results' }
if ([string]::IsNullOrWhiteSpace($BaselinePath)) { $BaselinePath = Join-Path $ResultDirectory 'update-baseline.json' }

$selectedTables = @('users', 'categories', 'products', 'customers', 'orders', 'held_orders')
$checks = @(
    'server services and automatic recovery',
    'server health and target release identity',
    'exact business-table fingerprints (users/categories/products/customers/orders/held_orders)',
    'server env and MariaDB configuration hashes',
    'automatic migration ledger and target release metadata',
    'stored ports and startup-repair task',
    'spooler env/config/state hashes and station identity (when included)',
    'fresh startup-health evidence after reboot (when requested)'
)
if ($WhatIf) {
    [ordered]@{ whatIf = $true; mutates = $false; phase = if ($AfterReboot) { 'post-reboot' } else { 'pre-update' }; baseline = $BaselinePath; resultDirectory = $ResultDirectory; checks = $checks } | ConvertTo-Json -Depth 5
    return
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$resultPath = Join-Path $ResultDirectory "update-smoke-$stamp.json"
$logPath = Join-Path $ResultDirectory "update-smoke-$stamp.log"
New-Item -ItemType Directory -Force -Path $ResultDirectory, (Split-Path -Parent $BaselinePath) | Out-Null
Start-Transcript -Path $logPath -Append | Out-Null
$result = [ordered]@{
    phase = if ($AfterReboot) { 'post-reboot' } else { 'pre-update-or-post-update' }
    startedAt = [DateTime]::UtcNow.ToString('o')
    mutates = $false
    environment = [ordered]@{}
    checks = [ordered]@{}
    pending = @('Windows 10 22H2 VM', 'physical printer output')
}

function Write-Utf8NoBom([string]$Path, [string]$Contents) {
    [IO.File]::WriteAllText($Path, $Contents, [Text.UTF8Encoding]::new($false))
}
function Add-Check([string]$Name, [scriptblock]$Action) {
    try { & $Action; $result.checks[$Name] = 'pass'; Write-Output "PASS $Name" }
    catch { $result.checks[$Name] = "fail: $($_.Exception.Message)"; throw }
}
function Read-Json([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing JSON: $Path" }
    try { return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json } catch { throw "Invalid JSON: $Path" }
}
function Read-EnvFile([string]$Path) {
    $values = @{}
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing environment file: $Path" }
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^([A-Z0-9_]+)=(.*)$') { $values[$matches[1]] = $matches[2] }
    }
    return $values
}
function File-HashOrNull([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Get-TreeHashes([string]$Root, [string[]]$ExcludedNames = @()) {
    $hashes = [ordered]@{}
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return $hashes }
    foreach ($file in Get-ChildItem -LiteralPath $Root -Recurse -File | Sort-Object FullName) {
        if ($ExcludedNames -contains $file.Name) { continue }
        $relative = $file.FullName.Substring($Root.Length).TrimStart('\').Replace('\', '/')
        $hashes[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    return $hashes
}
function Require-Service([string]$Name) {
    $service = Get-Service -Name $Name -ErrorAction Stop
    if ($service.Status -ne 'Running') { throw "$Name is not running." }
    $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$Name"
    $config = Get-ItemProperty -LiteralPath $key -ErrorAction Stop
    if ([int]$config.Start -ne 2) { throw "$Name is not automatic." }
}
function Require-StartupTask([string]$Name) {
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction Stop
    if ([string]$task.Principal.UserId -ne 'SYSTEM' -or $task.Principal.RunLevel -ne 'Highest') { throw "$Name is not an elevated SYSTEM task." }
}
function Wait-StartupRepairResult([string]$TaskName, [string]$StatusPath, [datetime]$BootTime) {
    $deadline = [DateTime]::UtcNow.AddMinutes(4)
    do {
        if (Test-Path -LiteralPath $StatusPath -PathType Leaf) {
            $file = Get-Item -LiteralPath $StatusPath
            $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
            $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
            if ($file.LastWriteTimeUtc -ge $BootTime.ToUniversalTime() -and $task.State -ne 'Running' -and $taskInfo.LastTaskResult -eq 0) {
                $health = Read-Json $StatusPath
                if ($health.healthy) { return }
            }
        }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$TaskName did not produce a fresh healthy startup result within four minutes."
}
function Assert-Identifier([string]$Value, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[A-Za-z_][A-Za-z0-9_$]*$') { throw "Invalid SQL identifier in $Label." }
    return "``$Value``"
}
function Sql-Literal([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
function Quote-Argument([string]$Value) {
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}
function Invoke-MariaDb([string]$Client, [hashtable]$EnvValues, [string]$Database, [string]$Sql) {
    $required = @('DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD')
    foreach ($name in $required) { if ([string]::IsNullOrWhiteSpace([string]$EnvValues[$name])) { throw "Database maintenance configuration is missing $name." } }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Client
    $psi.Arguments = @('-N', '-B', '-h', [string]$EnvValues.DB_HOST, '-P', [string]$EnvValues.DB_PORT, '-u', [string]$EnvValues.DB_USER, $Database, '-e', $Sql | ForEach-Object { Quote-Argument ([string]$_) }) -join ' '
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.EnvironmentVariables['MYSQL_PWD'] = [string]$EnvValues.DB_PASSWORD
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    try {
        if (-not $process.Start()) { throw 'Could not start the private MariaDB client.' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync(); $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(30000)) { try { $process.Kill() } catch {}; throw 'MariaDB query exceeded 30 seconds.' }
        $stdout = $stdoutTask.Result
        $stderr = $stderrTask.Result
        if ($process.ExitCode -ne 0) { throw "MariaDB query failed with exit code $($process.ExitCode)." }
        return $stdout
    }
    finally { $process.Dispose() }
}
function Get-MariaDbContext([string]$ProgramDataRoot, [string]$ProgramFilesRoot) {
    $envValues = Read-EnvFile (Join-Path $ProgramDataRoot 'config\backup.env')
    $posRoot = [IO.Path]::GetFullPath($ProgramFilesRoot).TrimEnd('\')
    if ((Split-Path -Leaf $posRoot) -ne 'POSApp') { throw 'POSAPP Program Files root is not the packaged POSApp directory.' }
    $client = Join-Path (Split-Path -Parent $posRoot) 'POSApp-MariaDB\bin\mariadb.exe'
    if (-not (Test-Path -LiteralPath $client -PathType Leaf)) { throw 'MariaDB client is missing.' }
    return [pscustomobject]@{ Env = $envValues; Client = $client; Database = [string]$envValues.DB_NAME }
}
function Get-TableMetadata([string]$Table, $Db) {
    $quotedTableLiteral = Sql-Literal $Table
    $columnSql = "SELECT COLUMN_NAME FROM information_schema.columns WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = $quotedTableLiteral ORDER BY ORDINAL_POSITION;"
    $pkSql = "SELECT COLUMN_NAME FROM information_schema.statistics WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = $quotedTableLiteral AND INDEX_NAME = 'PRIMARY' ORDER BY SEQ_IN_INDEX;"
    $columns = @(Invoke-MariaDb $Db.Client $Db.Env $Db.Database $columnSql | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | ForEach-Object { ([string]$_).Trim() })
    $primaryKey = @(Invoke-MariaDb $Db.Client $Db.Env $Db.Database $pkSql | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | ForEach-Object { ([string]$_).Trim() })
    if ($columns.Count -eq 0) { throw "Selected table has no columns: $Table." }
    if ($primaryKey.Count -eq 0) { throw "Selected table has no primary key: $Table." }
    foreach ($column in $columns) { Assert-Identifier $column "column $Table" | Out-Null }
    foreach ($column in $primaryKey) { if ($columns -notcontains $column) { throw "Primary key column is missing from table metadata: $Table.$column." } }
    return [pscustomobject]@{ Columns = $columns; PrimaryKey = $primaryKey }
}
function Get-TableFingerprint([string]$Table, $Db, [string[]]$Columns, [string[]]$PrimaryKey) {
    Assert-Identifier $Table 'table' | Out-Null
    foreach ($column in $Columns) { Assert-Identifier $column "column $Table" | Out-Null }
    foreach ($column in $PrimaryKey) { Assert-Identifier $column "primary key $Table" | Out-Null }
    $select = ($Columns | ForEach-Object { Assert-Identifier $_ "column $Table" }) -join ','
    $order = ($PrimaryKey | ForEach-Object { Assert-Identifier $_ "primary key $Table" }) -join ','
    $sql = "SELECT $select FROM $(Assert-Identifier $Table 'table') ORDER BY $order;"
    $output = [string](Invoke-MariaDb $Db.Client $Db.Env $Db.Database $sql)
    $rows = @($output -split "`r?`n" | Where-Object { $_ -ne '' })
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($output)
    $sha = ([Security.Cryptography.SHA256]::Create().ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join ''
    return [ordered]@{ columns = @($Columns); primaryKey = @($PrimaryKey); rowCount = [int64]$rows.Count; sha256 = $sha }
}
function Get-DatabaseFingerprints($Db, [string[]]$Tables, $BaselineTables = $null) {
    $fingerprints = [ordered]@{}
    foreach ($table in $Tables) {
        if ($null -eq $BaselineTables) {
            $metadata = Get-TableMetadata $table $Db
            $fingerprints[$table] = Get-TableFingerprint $table $Db $metadata.Columns $metadata.PrimaryKey
        }
        else {
            $baseline = $BaselineTables.PSObject.Properties[$table].Value
            if ($null -eq $baseline) { throw "Baseline fingerprint is missing table $table." }
            $currentMetadata = Get-TableMetadata $table $Db
            foreach ($column in @($baseline.columns)) { if ($currentMetadata.Columns -notcontains [string]$column) { throw "Baseline column was removed from $table`: $column." } }
            foreach ($column in @($baseline.primaryKey)) { if ($currentMetadata.Columns -notcontains [string]$column) { throw "Baseline primary-key column was removed from $table`: $column." } }
            $fingerprints[$table] = Get-TableFingerprint $table $Db @($baseline.columns) @($baseline.primaryKey)
        }
    }
    return $fingerprints
}
function Compare-DatabaseFingerprints($Before, $After) {
    foreach ($table in $selectedTables) {
        $beforeTable = $Before.PSObject.Properties[$table].Value
        $afterTable = $After.PSObject.Properties[$table].Value
        if ([int64]$afterTable.rowCount -ne [int64]$beforeTable.rowCount -or [string]$afterTable.sha256 -ne [string]$beforeTable.sha256) { throw "Exact database fingerprint changed for $table." }
    }
}
function Assert-ReleaseIdentity($Health, $Metadata, $Release) {
    foreach ($name in @('version', 'commit', 'schemaVersion')) {
        if ([string]$Health.release.$name -ne [string]$Release.$name) { throw "Health and installed release disagree for $name." }
    }
    foreach ($name in @('version', 'commit', 'schemaVersion')) {
        if ([string]$Metadata.release.$name -ne [string]$Release.$name) { throw "ProgramData and ProgramFiles release disagree for $name." }
    }
    if ($ExpectedServerVersion -and [string]$Release.version -ne $ExpectedServerVersion) { throw 'Server version mismatch.' }
    if ($ExpectedServerCommit -and [string]$Release.commit -ne $ExpectedServerCommit) { throw 'Server commit mismatch.' }
}
function Assert-MigrationLedger($Db, [string]$ManifestPath) {
    $manifest = Read-Json $ManifestPath
    if ($null -eq $manifest.migrations) { throw 'Automatic migration manifest is missing migrations.' }
    $ledger = @{}
    foreach ($migration in @($manifest.migrations)) {
        $name = [string]$migration.name; $checksum = [string]$migration.checksum
        if ($name -notmatch '^[A-Za-z0-9._-]+$' -or $checksum -notmatch '^[0-9a-fA-F]{64}$') { throw 'Automatic migration manifest contains invalid identity.' }
        $sql = "SELECT checksum FROM schema_migrations WHERE migration_name = $(Sql-Literal $name);"
        $actual = @((Invoke-MariaDb $Db.Client $Db.Env $Db.Database $sql) -split "`r?`n" | Where-Object { $_ -ne '' } | ForEach-Object { ([string]$_).Trim() })
        if ($actual.Count -ne 1 -or $actual[0] -ne $checksum) { throw "Automatic migration ledger entry is missing or conflicting: $name." }
        $ledger[$name] = $checksum
    }
    return $ledger
}
function Get-Snapshot {
    $serverData = 'C:\ProgramData\POSApp'; $serverFiles = 'C:\Program Files\POSApp'
    $metadata = Read-Json (Join-Path $serverData 'install.json')
    $release = Read-Json (Join-Path $serverFiles 'release.json')
    $db = Get-MariaDbContext $serverData $serverFiles
    $envPath = Join-Path $serverData 'config\pos.env'; $backupEnvPath = Join-Path $serverData 'config\backup.env'; $myIniPath = Join-Path $serverData 'database\my.ini'
    $snapshot = [ordered]@{
        release = [ordered]@{ version = [string]$release.version; commit = [string]$release.commit; schemaVersion = [string]$release.schemaVersion }
        ports = [ordered]@{ pos = [int]$metadata.posPort; database = [int]$metadata.databasePort; phpMyAdmin = [int]$metadata.phpMyAdminPort }
        databaseFingerprints = Get-DatabaseFingerprints $db $selectedTables
        hashes = [ordered]@{ posEnv = File-HashOrNull $envPath; backupEnv = File-HashOrNull $backupEnvPath; myIni = File-HashOrNull $myIniPath }
    }
    if ($IncludeSpooler) {
        $spoolerData = 'C:\ProgramData\POS-Spooler'; $spoolerEnv = Join-Path $spoolerData 'config\spooler.env'; $spoolerValues = Read-EnvFile $spoolerEnv
        $spoolerRelease = Read-Json 'C:\Program Files\POS-Spooler\release.json'
        $snapshot.spooler = [ordered]@{
            release = [ordered]@{ version = [string]$spoolerRelease.spoolerVersion; commit = [string]$spoolerRelease.commit; runtimeSha256 = [string]$spoolerRelease.runtimeSha256 }
            stationId = [string]$spoolerValues.SPOOLER_ID; stationName = [string]$spoolerValues.SPOOLER_NAME; serverUrl = [string]$spoolerValues.CLOUD_SERVER_URL
            envHash = File-HashOrNull $spoolerEnv
            configHashes = Get-TreeHashes (Join-Path $spoolerData 'config') @('spooler.env')
            stateHashes = Get-TreeHashes (Join-Path $spoolerData 'state')
        }
    }
    return $snapshot
}
function Compare-Snapshot($Before, $After) {
    Compare-DatabaseFingerprints $Before.databaseFingerprints $After.databaseFingerprints
    foreach ($name in @('posEnv', 'backupEnv', 'myIni')) { if ([string]$Before.hashes.$name -ne [string]$After.hashes.$name) { throw "Server configuration changed: $name." } }
    if (($Before.ports | ConvertTo-Json -Compress) -ne ($After.ports | ConvertTo-Json -Compress)) { throw 'Stored service ports changed.' }
    if ($IncludeSpooler) {
        foreach ($name in @('envHash', 'stationId', 'stationName', 'serverUrl')) { if ([string]$Before.spooler.$name -ne [string]$After.spooler.$name) { throw "Spooler identity/configuration changed: $name." } }
        if (($Before.spooler.configHashes | ConvertTo-Json -Compress) -ne ($After.spooler.configHashes | ConvertTo-Json -Compress)) { throw 'Spooler printer configuration changed.' }
        if (($Before.spooler.stateHashes | ConvertTo-Json -Compress) -ne ($After.spooler.stateHashes | ConvertTo-Json -Compress)) { throw 'Spooler queue/state changed.' }
        foreach ($snapshot in @($Before.spooler, $After.spooler)) { if ([string]$snapshot.release.runtimeSha256 -notmatch '^[0-9a-f]{64}$') { throw 'Spooler runtime compatibility hash is invalid.' } }
    }
}

try {
    $os = Get-CimInstance Win32_OperatingSystem
    $result.environment = [ordered]@{ caption = [string]$os.Caption; build = [int]$os.BuildNumber; architecture = [string]$os.OSArchitecture }
    Add-Check 'server services and automatic recovery' { Require-Service 'POSAppMariaDB'; Require-Service 'POSAppPhpMyAdmin'; Require-Service 'POSApp' }
    $metadata = Read-Json 'C:\ProgramData\POSApp\install.json'; $release = Read-Json 'C:\Program Files\POSApp\release.json'
    Add-Check 'server health and target release identity' {
        $health = Invoke-RestMethod "http://127.0.0.1:$([int]$metadata.posPort)/health" -TimeoutSec 10
        if ($health.status -ne 'ok' -or $health.db -ne 'connected' -or $null -eq $health.release) { throw 'POS health/database check failed.' }
        Assert-ReleaseIdentity $health $metadata $release
    }
    Add-Check 'stored ports and startup-repair task' { Require-StartupTask 'POSAPP Startup Health Repair' }
    $snapshot = Get-Snapshot
    Add-Check 'automatic migration ledger and target release metadata' {
        $db = Get-MariaDbContext 'C:\ProgramData\POSApp' 'C:\Program Files\POSApp'
        Assert-MigrationLedger $db 'C:\Program Files\POSApp\backend\migrations\auto-manifest.json' | Out-Null
        if ([string]$metadata.release.version -ne [string]$release.version -or [string]$metadata.release.commit -ne [string]$release.commit) { throw 'Installed metadata version mismatch.' }
    }
    if ($IncludeSpooler) {
        Add-Check 'spooler env/config/state hashes and station identity' {
            Require-Service 'POS Print Spooler'
            $values = Read-EnvFile 'C:\ProgramData\POS-Spooler\config\spooler.env'; $spoolerRelease = Read-Json 'C:\Program Files\POS-Spooler\release.json'
            if ([string]::IsNullOrWhiteSpace([string]$values.SPOOLER_ID) -or [string]::IsNullOrWhiteSpace([string]$values.SPOOLER_NAME)) { throw 'Spooler identity is incomplete.' }
            if ($ExpectedSpoolerVersion -and [string]$spoolerRelease.spoolerVersion -ne $ExpectedSpoolerVersion) { throw 'Spooler version mismatch.' }
            if ($ExpectedSpoolerCommit -and [string]$spoolerRelease.commit -ne $ExpectedSpoolerCommit) { throw 'Spooler commit mismatch.' }
        }
    }
    if (Test-Path -LiteralPath $BaselinePath -PathType Leaf) { Add-Check 'exact business/configuration preservation against baseline' { Compare-Snapshot (Read-Json $BaselinePath) $snapshot } }
    else { Write-Utf8NoBom $BaselinePath ($snapshot | ConvertTo-Json -Depth 16); $result.baselineCreated = $BaselinePath; Write-Output "BASELINE CREATED $BaselinePath" }
    if ($AfterReboot) {
        Add-Check 'fresh startup-health evidence after reboot' {
            Wait-StartupRepairResult 'POSAPP Startup Health Repair' 'C:\ProgramData\POSApp\logs\startup-health.json' $os.LastBootUpTime
            if ($IncludeSpooler) { Wait-StartupRepairResult 'POSAPP Spooler Startup Health Repair' 'C:\ProgramData\POS-Spooler\logs\startup-health.json' $os.LastBootUpTime }
        }
    }
    $result.snapshot = $snapshot; $result.completedAt = [DateTime]::UtcNow.ToString('o'); Write-Utf8NoBom $resultPath ($result | ConvertTo-Json -Depth 16); Write-Output "WROTE $resultPath"
}
catch {
    $result.error = $_.Exception.Message; $result.completedAt = [DateTime]::UtcNow.ToString('o'); Write-Utf8NoBom $resultPath ($result | ConvertTo-Json -Depth 16); throw
}
finally { Stop-Transcript | Out-Null }
