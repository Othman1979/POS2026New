[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('pre-reboot', 'post-reboot')][string]$Phase,
    [Parameter(Mandatory)][switch]$Disposable,
    [Parameter(Mandatory)][string]$BundlePath,
    [Parameter(Mandatory)][string]$ResultPath,
    [Parameter(Mandatory)][string]$SentinelPath,
    [Parameter(Mandatory)][string]$SentinelValue,
    [int]$PosPort = 39000,
    [int]$DatabasePort = 39001,
    [int]$PhpMyAdminPort = 39002
)

$ErrorActionPreference = 'Stop'
$guestScriptPath = [string]$PSCommandPath
$result = [ordered]@{
    phase = $Phase
    startedAt = [DateTime]::UtcNow.ToString('o')
    redacted = $true
    checks = [ordered]@{}
    pending = @('Windows 10 22H2 VM', 'physical printer output')
}
$resultDirectory = Split-Path -Parent $ResultPath
$exitMarker = Join-Path $resultDirectory "$Phase.exit"
$localBundle = $null

function Write-Utf8NoBom([string]$Path, [string]$Contents) {
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    [IO.File]::WriteAllText($Path, $Contents, [Text.UTF8Encoding]::new($false))
}
function Redact-Text([string]$Text) {
    if ($null -eq $Text) { return '' }
    $safe = $Text
    $safe = [regex]::Replace($safe, '(?im)(password|secret|spooler[_-]?key|token)\s*[=:]\s*[^\s,;]+', '$1=<redacted>')
    return $safe
}
function Write-Result {
    $result.completedAt = [DateTime]::UtcNow.ToString('o')
    $json = Redact-Text (($result | ConvertTo-Json -Depth 20))
    Write-Utf8NoBom $ResultPath $json
}
function Add-ServiceDiagnostics {
    $paths = @(
        'C:\ProgramData\POSApp\logs\posapp-service.err.log',
        'C:\ProgramData\POSApp\logs\posapp-service.out.log',
        'C:\ProgramData\POSApp\logs\install.log',
        'C:\ProgramData\POS-Spooler\logs\spooler-service.err.log',
        'C:\ProgramData\POS-Spooler\logs\spooler-service.out.log'
    )
    $tails = [ordered]@{}
    foreach ($path in $paths) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            $tails[$path] = Redact-Text ((Get-Content -LiteralPath $path -Tail 40 -ErrorAction SilentlyContinue) -join "`r`n")
        }
    }
    if ($tails.Count -gt 0) { $result.diagnostics = $tails }
}
function Complete([int]$Code) {
    try { Write-Result; Write-Utf8NoBom $exitMarker ([string]$Code) } catch {}
    if ($Code -ne 0) { exit $Code }
}
function Fail([string]$Message) {
    $result.error = Redact-Text $Message
    Complete 1
}
function Add-Check([string]$Name, [scriptblock]$Action) {
    try { & $Action; $result.checks[$Name] = 'pass' }
    catch { $result.checks[$Name] = "fail: $(Redact-Text $_.Exception.Message)"; throw }
}
function Quote-Argument([string]$Value) {
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}
function Invoke-Bounded([string]$FilePath, [string[]]$Arguments, [int]$TimeoutSeconds = 120, [int[]]$AllowedExitCodes = @(0)) {
    # Every external process has a bounded timeout; guest logs never contain secrets/passwords.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = ($Arguments | ForEach-Object { Quote-Argument ([string]$_) }) -join ' '
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process; $process.StartInfo = $psi
    try {
        if (-not $process.Start()) { throw "Could not start $FilePath." }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync(); $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) { try { $process.Kill() } catch {}; throw "Timed out after $TimeoutSeconds seconds: $FilePath" }
        $stdout = $stdoutTask.Result; $stderr = $stderrTask.Result
        if ($AllowedExitCodes -notcontains $process.ExitCode) { throw "Command failed ($($process.ExitCode)): $FilePath $stderr" }
        return [pscustomobject]@{ ExitCode = $process.ExitCode; StdOut = $stdout; StdErr = $stderr }
    }
    finally { $process.Dispose() }
}
function Invoke-PowerShellFile([string]$Script, [string[]]$Arguments, [int]$TimeoutSeconds = 600, [int[]]$AllowedExitCodes = @(0)) {
    $powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    return Invoke-Bounded $powershell (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Script) + $Arguments) $TimeoutSeconds $AllowedExitCodes
}
function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Get-TreeHashes([string]$Root, [string[]]$ExcludedNames = @()) {
    $hashes = [ordered]@{}
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return $hashes }
    foreach ($file in Get-ChildItem -LiteralPath $Root -Recurse -File | Sort-Object FullName) {
        if ($ExcludedNames -contains $file.Name) { continue }
        $relative = $file.FullName.Substring($Root.Length).TrimStart('\').Replace('\', '/')
        $hashes[$relative] = Get-Sha256 $file.FullName
    }
    return $hashes
}
function Read-EnvFile([string]$Path) {
    $values = @{}
    foreach ($line in Get-Content -LiteralPath $Path) { if ($line -match '^([A-Z0-9_]+)=(.*)$') { $values[$matches[1]] = $matches[2] } }
    return $values
}
function Invoke-MariaDb([string]$Client, [hashtable]$EnvValues, [string]$Database, [string]$Sql, [int]$TimeoutSeconds = 30) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo; $psi.FileName = $Client
    $arguments = @('-N', '-B', '-h', [string]$EnvValues.DB_HOST, '-P', [string]$EnvValues.DB_PORT, '-u', [string]$EnvValues.DB_USER, $Database, '-e', $Sql)
    $psi.Arguments = ($arguments | ForEach-Object { Quote-Argument ([string]$_) }) -join ' '
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.EnvironmentVariables['MYSQL_PWD'] = [string]$EnvValues.DB_PASSWORD
    $process = New-Object System.Diagnostics.Process; $process.StartInfo = $psi
    try {
        if (-not $process.Start()) { throw 'Could not start the private MariaDB client.' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync(); $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) { try { $process.Kill() } catch {}; throw 'MariaDB query timed out.' }
        $stdout = $stdoutTask.Result; if ($process.ExitCode -ne 0) { throw 'MariaDB query failed.' }; return $stdout
    }
    finally { $process.Dispose() }
}
function Assert-GuestPlatform {
    $os = Get-CimInstance Win32_OperatingSystem; $computer = Get-CimInstance Win32_ComputerSystem
    if ([int]$os.ProductType -ne 1 -or [int]$os.BuildNumber -lt 17763 -or [string]$os.OSArchitecture -notmatch '64-bit' -or [string]$computer.SystemType -notmatch '(?i)x64' -or [string]$computer.SystemType -match '(?i)arm64') { throw 'Disposable guest must be a Windows workstation on native x64 build 17763 or later.' }
    $result.environment = [ordered]@{ caption = [string]$os.Caption; build = [int]$os.BuildNumber; architecture = [string]$os.OSArchitecture; productType = [int]$os.ProductType; lastBootUpTime = $os.LastBootUpTime.ToUniversalTime().ToString('o') }
}
function Assert-DisposableBoundary {
    if (-not $Disposable) { throw 'The -Disposable opt-in switch is required.' }
    $bundle = [IO.Path]::GetFullPath($BundlePath).TrimEnd('\'); $sentinel = [IO.Path]::GetFullPath($SentinelPath); $scriptPath = [IO.Path]::GetFullPath($script:guestScriptPath)
    if (-not $sentinel.StartsWith($bundle + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Sentinel must be inside the mapped bundle.' }
    if (-not $scriptPath.StartsWith($bundle + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Guest runner must execute from the mapped bundle, never a host path.' }
    if (-not (Test-Path -LiteralPath $sentinel -PathType Leaf) -or (Get-Content -Raw -LiteralPath $sentinel).Trim() -ne $SentinelValue) { throw 'Disposable sentinel mismatch.' }
    $probe = Join-Path $bundle ".guest-write-probe-$PID"
    $writeSucceeded = $false
    try {
        [IO.File]::WriteAllText($probe, 'probe');
        $writeSucceeded = $true
    }
    catch {
        if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue }
    }
    if ($writeSucceeded) { Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue; throw 'Mapped artifact bundle must be read-only.' }
}
function Copy-LocalBundle {
    $root = [IO.Path]::GetFullPath($BundlePath).TrimEnd('\')
    $target = Join-Path $env:TEMP "posapp-update-bundle-$PID"
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $root -Force) { Copy-Item -LiteralPath $item.FullName -Destination $target -Recurse -Force }
    return $target
}
function Copy-PackagedStage([string]$Source, [string]$Destination, [string]$ProvisioningRoot, [string[]]$ProvisioningScripts) {
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw "Packaged stage is missing: $Source" }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $Source -Force) { Copy-Item -LiteralPath $item.FullName -Destination $Destination -Recurse -Force }
    $windowsDirectory = Join-Path $Destination 'deployment\windows'
    New-Item -ItemType Directory -Force -Path $windowsDirectory | Out-Null
    foreach ($name in $ProvisioningScripts) {
        $sourceScript = Join-Path $ProvisioningRoot $name
        if (-not (Test-Path -LiteralPath $sourceScript -PathType Leaf)) { throw "Packaged provisioning script is missing: $sourceScript" }
        Copy-Item -LiteralPath $sourceScript -Destination $windowsDirectory -Force
    }
}
function Require-NoExistingServices {
    foreach ($name in @('POSAppMariaDB', 'POSAppPhpMyAdmin', 'POSApp', 'POS Print Spooler')) { if (Get-Service -Name $name -ErrorAction SilentlyContinue) { throw "Disposable guest already has service $name." } }
}
function Require-Service([string]$Name) {
    $service = Get-Service -Name $Name -ErrorAction Stop
    if ($service.Status -ne 'Running') { throw "$Name is not running." }
    if (((sc.exe qc $Name) -join "`n") -notmatch 'START_TYPE.*AUTO_START') { throw "$Name is not automatic." }
    if (((sc.exe qfailure $Name) -join "`n") -notmatch 'RESTART') { throw "$Name has no restart recovery." }
    $key = "HKLM:\SYSTEM\CurrentControlSet\Services\$Name"; $config = Get-ItemProperty -LiteralPath $key -ErrorAction Stop
    if ([int]$config.FailureActionsOnNonCrashFailures -ne 1) { throw "$Name does not recover from reported startup failures." }
}
function Require-StartupRepairTask([string]$Name) {
    $task = Get-ScheduledTask -TaskName $Name -ErrorAction Stop
    if ($task.Principal.UserId -ne 'SYSTEM' -or $task.Principal.RunLevel -ne 'Highest') { throw "$Name is not owned by elevated SYSTEM." }
    if (-not ($task.Triggers | Where-Object { $_.CimClass.CimClassName -match 'BootTrigger' })) { throw "$Name has no startup trigger." }
}
function Wait-StartupRepairResult([string]$TaskName, [string]$StatusPath, [datetime]$BootTime) {
    $deadline = [DateTime]::UtcNow.AddMinutes(4)
    do {
        if (Test-Path -LiteralPath $StatusPath -PathType Leaf) {
            $file = Get-Item -LiteralPath $StatusPath; $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop; $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
            if ($file.LastWriteTimeUtc -ge $BootTime.ToUniversalTime() -and $task.State -ne 'Running' -and $taskInfo.LastTaskResult -eq 0 -and (Get-Content -Raw $StatusPath | ConvertFrom-Json).healthy) { return }
        }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$TaskName did not produce fresh healthy startup evidence after reboot."
}
function Get-ServerDb {
    $data = 'C:\ProgramData\POSApp'; $files = 'C:\Program Files\POSApp'; $values = Read-EnvFile (Join-Path $data 'config\backup.env'); $client = Join-Path (Split-Path -Parent $files) 'POSApp-MariaDB\bin\mariadb.exe'
    if (-not (Test-Path -LiteralPath $client -PathType Leaf)) { throw 'Private MariaDB client is missing.' }
    return [pscustomobject]@{ Data = $data; Files = $files; Env = $values; Client = $client; Database = [string]$values.DB_NAME }
}
function Get-MigrationLedgerEntries {
    $db = Get-ServerDb
    $rows = @(Invoke-MariaDb $db.Client $db.Env $db.Database 'SELECT migration_name,checksum FROM schema_migrations ORDER BY migration_name;')
    return @($rows -split "`r?`n" | Where-Object { $_ -match '\S' } | ForEach-Object {
        $parts = [string]$_ -split "`t", 2
        if ($parts.Count -ne 2) { throw 'Migration ledger output was malformed.' }
        [ordered]@{ name = $parts[0].Trim(); checksum = $parts[1].Trim() }
    })
}
function Seed-BusinessFixture($Db) {
    $sql = @(
        "INSERT IGNORE INTO categories (id,name,is_active) VALUES (9001,'Sandbox Category',1);",
        "INSERT IGNORE INTO products (id,name,price,tax_rate,category_id,is_active,is_bundle) VALUES (9001,'Sandbox Product',5.00,0,9001,1,0);",
        "INSERT IGNORE INTO customers (id,phone,name) VALUES (9001,'+962790009001','Sandbox Customer');",
        "INSERT IGNORE INTO orders (invoice_id,user_id,customer_id,subtotal,tax,total,payment_method) VALUES (9001,1,9001,5.00,0.00,5.00,'cash');",
        "INSERT IGNORE INTO held_orders (id,user_id,reference_name,cart_data,subtotal) VALUES (9001,1,'Sandbox Held Order','[{`"product_id`":9001,`"quantity`":1}]',5.00);"
    )
    foreach ($statement in $sql) { Invoke-MariaDb $Db.Client $Db.Env $Db.Database $statement | Out-Null }
    $checks = [ordered]@{ categories = 'id=9001'; products = 'id=9001'; customers = 'id=9001'; orders = 'invoice_id=9001'; held_orders = 'id=9001' }
    foreach ($table in $checks.Keys) { $count = (Invoke-MariaDb $Db.Client $Db.Env $Db.Database "SELECT COUNT(*) FROM ``$table`` WHERE $($checks[$table]);").Trim(); if ([int64]$count -lt 1) { throw "Fixture row missing from $table." } }
}
function Add-SpoolerFixture {
    $configRoot = 'C:\ProgramData\POS-Spooler\config'; $stateRoot = 'C:\ProgramData\POS-Spooler\state'
    New-Item -ItemType Directory -Force -Path (Join-Path $configRoot 'printers'), $stateRoot | Out-Null
    Write-Utf8NoBom (Join-Path $configRoot 'printers\sandbox-printer.json') '{"name":"Sandbox printer","type":"windows","role":"receipt"}'
    Write-Utf8NoBom (Join-Path $stateRoot 'sandbox-queue.marker') 'queued-sandbox-job'
}
function Run-Smoke([string]$Name, [string]$ExpectedServerVersion, [string]$ExpectedServerCommit, [string]$ExpectedSpoolerVersion, [string]$ExpectedSpoolerCommit, [switch]$AfterReboot) {
    $smoke = Join-Path $localBundle 'tools\update-smoke.ps1'; $dir = Join-Path $resultDirectory $Name
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $args = @('-IncludeSpooler', '-ResultDirectory', $dir, '-BaselinePath', (Join-Path $resultDirectory 'update-baseline.json'), '-ExpectedServerVersion', $ExpectedServerVersion, '-ExpectedServerCommit', $ExpectedServerCommit, '-ExpectedSpoolerVersion', $ExpectedSpoolerVersion, '-ExpectedSpoolerCommit', $ExpectedSpoolerCommit)
    if ($AfterReboot) { $args += '-AfterReboot' }
    Invoke-PowerShellFile $smoke $args 600 | Out-Null
}
function Run-Installer([string]$Path, [string]$LogPath, [switch]$Accept, [int[]]$AllowedExitCodes = @(0)) {
    $args = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=$LogPath"); if ($Accept) { $args += '/ACCEPTUPDATE=1' }
    return Invoke-Bounded $Path $args 1800 $AllowedExitCodes
}
function Start-RollbackWatcher([string]$ServiceName, [string]$LateSource) {
    return Start-Job -ArgumentList $ServiceName, $LateSource -ScriptBlock {
        param($name, $late)
        $deadline = [DateTime]::UtcNow.AddMinutes(10)
        do { $service = Get-Service -Name $name -ErrorAction SilentlyContinue; if ($service -and $service.Status -eq 'Stopped') { Start-Sleep -Milliseconds 500; Remove-Item -LiteralPath $late -Force -ErrorAction Stop; Write-Output 0; return }; Start-Sleep -Milliseconds 100 } while ([DateTime]::UtcNow -lt $deadline)
        Write-Output 1
    }
}
function Run-RollbackDrill([string]$Kind, [string]$ServiceName, [string]$UpdaterScript, [string]$PayloadRoot, [string]$ResultFile, [string]$Mode = 'Core') {
    $late = Get-ChildItem -LiteralPath $PayloadRoot -Recurse -File | Where-Object {
        $_.Name -ne 'update-payload-manifest.json' -and
        ($Kind -ne 'spooler' -or $_.FullName -notmatch '[\\/](?:node_modules|\.cache)[\\/]')
    } | Sort-Object FullName | Select-Object -Last 1
    if (-not $late) { throw "No late manifest source available for $Kind rollback." }
    $watcher = Start-RollbackWatcher $ServiceName $late.FullName
    $failed = $false
    $arguments = @('-PayloadRoot', $PayloadRoot, '-ResultFile', $ResultFile)
    if ($Kind -eq 'spooler') { $arguments += @('-Mode', $Mode) }
    try { Invoke-PowerShellFile $UpdaterScript $arguments 1800 | Out-Null } catch { $failed = $true }
    $watcherResult = Receive-Job -Job $watcher -Wait -AutoRemoveJob -ErrorAction SilentlyContinue
    if (-not $failed -or [int]$watcherResult -ne 0) { throw "$Kind rollback did not induce a deterministic post-stop managed-swap failure." }
    $log = if ($Kind -eq 'server') { 'C:\ProgramData\POSApp\logs\update-error.txt' } else { 'C:\ProgramData\POS-Spooler\logs\update-error.txt' }
    if (-not (Test-Path -LiteralPath $log) -or (Get-Content -Raw $log) -notmatch 'managed swap') { throw "$Kind rollback did not fail in managed swap." }
    if ($Kind -eq 'server') { Get-ChildItem 'C:\ProgramData\POSApp\tmp' -Filter 'update-rollback-*' -ErrorAction SilentlyContinue | ForEach-Object { throw 'Server rollback directory was abandoned.' } } else { Get-ChildItem 'C:\ProgramData\POS-Spooler\tmp' -Filter 'update-rollback-*' -ErrorAction SilentlyContinue | ForEach-Object { throw 'Spooler rollback directory was abandoned.' } }
}
function Get-ServicePid([string]$Name) { $service = Get-CimInstance Win32_Service -Filter "Name='$($Name.Replace("'", "''"))'"; if ($service) { return [int]$service.ProcessId }; return 0 }

try {
    Add-Check 'disposable guest boundary' { Assert-DisposableBoundary; Assert-GuestPlatform }
    if ($Phase -eq 'pre-reboot') {
        Add-Check 'clean disposable guest services' { Require-NoExistingServices }
        $localBundle = Copy-LocalBundle
        $baselineCommit = ((Get-Content -Raw (Join-Path $localBundle 'identities.json') | ConvertFrom-Json).baselineCommit)
        $baselineServer = Join-Path $localBundle 'baseline\server'; $baselineSpooler = Join-Path $localBundle 'baseline\spooler'
        $baselineProvisioning = Join-Path $localBundle 'baseline'
        Add-Check 'packaged baseline provisioning' {
            $serverConfig = Join-Path $env:TEMP "posapp-server-response-$PID.json"; Write-Utf8NoBom $serverConfig (([ordered]@{ RestaurantName = 'Sandbox Acceptance'; PosPort = $PosPort; DatabasePort = $DatabasePort; PhpMyAdminPort = $PhpMyAdminPort } | ConvertTo-Json -Compress))
            $serverFiles = 'C:\Program Files\POSApp'; Copy-PackagedStage $baselineServer $serverFiles $baselineProvisioning @('Install-PosServer.ps1','Repair-PosStartup.ps1','Remove-PosRuntime.ps1')
            Invoke-PowerShellFile (Join-Path $serverFiles 'deployment\windows\Install-PosServer.ps1') @('-ConfigFile', $serverConfig, '-ServerStage', $serverFiles, '-VendorDir', (Join-Path $serverFiles 'install\vendor'), '-ResultFile', (Join-Path $resultDirectory 'server-provisioning.txt')) 3600 | Out-Null
            $db = Get-ServerDb
            $spoolerEnv = Read-EnvFile 'C:\ProgramData\POSApp\config\pos.env'; if ([string]::IsNullOrWhiteSpace([string]$spoolerEnv.SPOOLER_KEY)) { throw 'Server did not produce a spooler key.' }
            $spoolerConfig = Join-Path $env:TEMP "posapp-spooler-response-$PID.json"; Write-Utf8NoBom $spoolerConfig (([ordered]@{ ServerUrl = "http://127.0.0.1:$PosPort"; SpoolerKey = [string]$spoolerEnv.SPOOLER_KEY; SpoolerId = 'sandbox-station'; SpoolerName = 'Sandbox Station' } | ConvertTo-Json -Compress))
            $spoolerFiles = 'C:\Program Files\POS-Spooler'; Copy-PackagedStage $baselineSpooler $spoolerFiles $baselineProvisioning @('Install-Spooler.ps1','Remove-SpoolerRuntime.ps1')
            Invoke-PowerShellFile (Join-Path $spoolerFiles 'deployment\windows\Install-Spooler.ps1') @('-ConfigFile', $spoolerConfig, '-PayloadRoot', $spoolerFiles) 1800 | Out-Null
        }
        Add-Check 'representative business data' {
            Seed-BusinessFixture (Get-ServerDb)
            $health = Invoke-RestMethod "http://127.0.0.1:$PosPort/health" -TimeoutSec 10
            if ($health.status -ne 'ok') { throw 'Baseline health check failed.' }
            $login = Invoke-RestMethod "http://127.0.0.1:$PosPort/api/auth/login" -Method Post -ContentType 'application/json' -Body '{"user_number":"009384"}' -TimeoutSec 10
            if (-not $login.success -or -not $login.user) { throw '009384 login failed.' }
            Add-SpoolerFixture
        }
        $result.baselineMigrationLedger = Get-MigrationLedgerEntries
        Run-Smoke 'baseline' '1.0.0' $baselineCommit '1.2.0' $baselineCommit
        $serverExe = Join-Path $localBundle 'artifacts\POSAPP-Server-Update.exe'; $spoolerExe = Join-Path $localBundle 'artifacts\POSAPP-Spooler-Update.exe'; $spoolerRuntimeExe = Join-Path $localBundle 'artifacts\POSAPP-Spooler-Runtime-Update.exe'
        foreach ($item in @(@{ Name = 'server'; Path = $serverExe }, @{ Name = 'spooler-core'; Path = $spoolerExe }, @{ Name = 'spooler-runtime'; Path = $spoolerRuntimeExe })) {
            Add-Check "negative silent gate ($($item.Name))" {
                $beforeResult = Join-Path $resultDirectory "negative-$($item.Name).log"; $exit = 0
                try { $run = Run-Installer $item.Path $beforeResult -AllowedExitCodes (0..255); $exit = [int]$run.ExitCode } catch { throw }
                if ($exit -eq 0) { throw 'Silent update without /ACCEPTUPDATE=1 unexpectedly succeeded.' }
                Run-Smoke "negative-$($item.Name)-unchanged" '1.0.0' $baselineCommit '1.2.0' $baselineCommit
            }
        }
        Run-RollbackDrill 'server' 'POSApp' (Join-Path $localBundle 'updaters\Update-PosServer.ps1') (Join-Path $localBundle 'current\server-update') (Join-Path $resultDirectory 'server-rollback.json')
        $result.serverRollbackMigrationLedger = Get-MigrationLedgerEntries
        Run-Smoke 'server-rollback-unchanged' '1.0.0' $baselineCommit '1.2.0' $baselineCommit
        Run-RollbackDrill 'spooler' 'POS Print Spooler' (Join-Path $localBundle 'updaters\Update-Spooler.ps1') (Join-Path $localBundle 'current\spooler-update-runtime') (Join-Path $resultDirectory 'spooler-rollback.json') 'RuntimeTransition'
        $result.spoolerRollbackMigrationLedger = Get-MigrationLedgerEntries
        Run-Smoke 'spooler-rollback-unchanged' '1.0.0' $baselineCommit '1.2.0' $baselineCommit
        Add-Check 'core refuses legacy runtime before transition' {
            $failed = $false
            try { Run-Installer $spoolerExe (Join-Path $resultDirectory 'spooler-core-legacy.log') -Accept | Out-Null } catch { $failed = $true }
            if (-not $failed) { throw 'Core spooler update unexpectedly accepted a legacy installation without a runtime hash.' }
        }
        Add-Check 'current packaged update EXEs' {
            Run-Installer $serverExe (Join-Path $resultDirectory 'server-update.log') -Accept | Out-Null
            Run-Installer $spoolerRuntimeExe (Join-Path $resultDirectory 'spooler-runtime-update.log') -Accept | Out-Null
            Run-Installer $spoolerExe (Join-Path $resultDirectory 'spooler-update.log') -Accept | Out-Null
        }
        $result.targetMigrationLedger = Get-MigrationLedgerEntries
        Run-Smoke 'updated' '1.0.2' ((Get-Content -Raw (Join-Path $localBundle 'identities.json') | ConvertFrom-Json).currentCommit) '1.2.2' ((Get-Content -Raw (Join-Path $localBundle 'identities.json') | ConvertFrom-Json).currentCommit)
        $serverPid = Get-ServicePid 'POSApp'; $spoolerPid = Get-ServicePid 'POS Print Spooler'; $backupCount = @(Get-ChildItem 'C:\ProgramData\POSApp\backups' -Filter 'update-*.sql.gz' -ErrorAction SilentlyContinue).Count
        Add-Check 'idempotent current update path' { Run-Installer $serverExe (Join-Path $resultDirectory 'server-update-current.log') -Accept | Out-Null; Run-Installer $spoolerExe (Join-Path $resultDirectory 'spooler-update-current.log') -Accept | Out-Null; if ((Get-ServicePid 'POSApp') -ne $serverPid -or (Get-ServicePid 'POS Print Spooler') -ne $spoolerPid) { throw 'Current update restarted a service.' }; if (@(Get-ChildItem 'C:\ProgramData\POSApp\backups' -Filter 'update-*.sql.gz' -ErrorAction SilentlyContinue).Count -ne $backupCount) { throw 'Current update created a new backup.' } }
        Write-Utf8NoBom (Join-Path $resultDirectory 'reboot.requested') ([DateTime]::UtcNow.ToString('o'))
        $result.artifacts = [ordered]@{ serverUpdateLog = 'C:\results\server-update.log'; spoolerCoreUpdateLog = 'C:\results\spooler-update.log'; spoolerRuntimeUpdateLog = 'C:\results\spooler-runtime-update.log' }
        Complete 0
    }
    else {
        $localBundle = Copy-LocalBundle
        Add-Check 'post-reboot startup recovery' {
            $os = Get-CimInstance Win32_OperatingSystem; Wait-StartupRepairResult 'POSAPP Startup Health Repair' 'C:\ProgramData\POSApp\logs\startup-health.json' $os.LastBootUpTime; Wait-StartupRepairResult 'POSAPP Spooler Startup Health Repair' 'C:\ProgramData\POS-Spooler\logs\startup-health.json' $os.LastBootUpTime
            Require-StartupRepairTask 'POSAPP Startup Health Repair'; Require-StartupRepairTask 'POSAPP Spooler Startup Health Repair'
            Require-Service 'POSAppMariaDB'; Require-Service 'POSAppPhpMyAdmin'; Require-Service 'POSApp'; Require-Service 'POS Print Spooler'
        }
        $identity = Get-Content -Raw (Join-Path $localBundle 'identities.json') | ConvertFrom-Json
        Add-Check 'post-reboot target health' {
            $health = Invoke-RestMethod "http://127.0.0.1:$PosPort/health" -TimeoutSec 10
            if ($health.status -ne 'ok' -or [string]$health.release.commit -ne [string]$identity.currentCommit) { throw 'Post-reboot server health target mismatch.' }
            $login = Invoke-RestMethod "http://127.0.0.1:$PosPort/api/auth/login" -Method Post -ContentType 'application/json' -Body '{"user_number":"009384"}' -TimeoutSec 10
            if (-not $login.success -or -not $login.user) { throw 'Post-reboot 009384 login failed.' }
            $spooler = Read-EnvFile 'C:\ProgramData\POS-Spooler\config\spooler.env'; Invoke-RestMethod "http://127.0.0.1:$PosPort/api/spooler/v2/status" -Method Post -ContentType 'application/json' -Headers @{ 'x-spooler-key' = $spooler.SPOOLER_KEY } -Body (@{ spooler_id = $spooler.SPOOLER_ID } | ConvertTo-Json) -TimeoutSec 10 | Out-Null
        }
        Run-Smoke 'post-reboot' '1.0.2' $identity.currentCommit '1.2.2' $identity.currentCommit -AfterReboot
        $result.logs = @('C:\results\server-update.log', 'C:\results\spooler-update.log', 'C:\ProgramData\POSApp\logs\startup-repair.log', 'C:\ProgramData\POS-Spooler\logs\startup-repair.log')
        Complete 0
    }
}
catch { Add-ServiceDiagnostics; Fail $_.Exception.Message }
finally {
    if ($localBundle -and (Test-Path -LiteralPath $localBundle) -and $localBundle.StartsWith([IO.Path]::GetFullPath($env:TEMP), [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $localBundle -Recurse -Force -ErrorAction SilentlyContinue }
}
