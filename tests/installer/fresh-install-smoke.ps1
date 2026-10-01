[CmdletBinding()]
param(
    [int]$PosPort = 3000,
    [int]$DatabasePort = 3306,
    [int]$PhpMyAdminPort = 8081,
    [string]$ExpectedVersion,
    [string]$ExpectedCommit,
    [string]$ExpectedSchemaVersion,
    [string]$TerminalBUrl,
    [string]$RestoreDatabaseName = 'posapp_restore_test',
    [switch]$IncludeSpooler,
    [switch]$AfterReboot,
    [switch]$WhatIf
)
$ErrorActionPreference='Stop'
if ($RestoreDatabaseName -ne 'posapp_restore_test') { throw 'RestoreDatabaseName must remain the isolated installer test database.' }
if ($WhatIf) { Write-Output 'WhatIf: would inspect server services, recovery, loopback bindings, firewall, health, login, database rows, shortcut, destructive backup restore, and the optional spooler.'; return }

$resultDir=Join-Path $PSScriptRoot 'results'
New-Item -ItemType Directory -Force $resultDir | Out-Null
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
Start-Transcript -Path (Join-Path $resultDir "fresh-install-$stamp.log") -Append | Out-Null
$results=[ordered]@{startedAt=(Get-Date).ToUniversalTime().ToString('o');environment=[ordered]@{};checks=@{}}
function Check([string]$Name,[scriptblock]$Test) { & $Test; $results.checks[$Name]='pass'; Write-Output "PASS $Name" }
function Require-Service([string]$Name) {
    $service=Get-Service $Name -ErrorAction Stop
    if($service.Status -ne 'Running'){throw "$Name is not running."}
    if(((sc.exe qc $Name)-join "`n") -notmatch 'START_TYPE.*AUTO_START'){throw "$Name is not automatic."}
    if(((sc.exe qfailure $Name)-join "`n") -notmatch 'RESTART'){throw "$Name has no restart recovery."}
    $serviceConfig=Get-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$Name" -ErrorAction Stop
    if([int]$serviceConfig.FailureActionsOnNonCrashFailures -ne 1){throw "$Name does not recover from reported startup failures."}
}
function Require-StartupRepairTask([string]$Name) {
    $task=Get-ScheduledTask -TaskName $Name -ErrorAction Stop
    if($task.Principal.UserId -ne 'SYSTEM' -or $task.Principal.RunLevel -ne 'Highest'){throw "$Name is not owned by elevated SYSTEM."}
    if(-not ($task.Triggers | Where-Object {$_.CimClass.CimClassName -match 'BootTrigger'})){throw "$Name has no startup trigger."}
}
function Wait-StartupRepairResult([string]$TaskName,[string]$StatusPath,[datetime]$BootTime) {
    $deadline=[DateTime]::UtcNow.AddMinutes(4)
    do {
        if(Test-Path $StatusPath){
            $file=Get-Item $StatusPath
            $task=Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
            $taskInfo=Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
            if($file.LastWriteTimeUtc -ge $BootTime.ToUniversalTime() -and $task.State -ne 'Running' -and $taskInfo.LastTaskResult -eq 0){
                $health=Get-Content $StatusPath -Raw | ConvertFrom-Json
                if($health.healthy){return}
            }
        }
        Start-Sleep -Seconds 2
    }while([DateTime]::UtcNow -lt $deadline)
    throw "$TaskName did not produce a fresh healthy startup result within four minutes."
}
function Read-EnvFile([string]$Path) {
    $values=@{}
    Get-Content $Path | Where-Object { $_ -match '^[A-Z0-9_]+=' } | ForEach-Object { $key,$value=$_ -split '=',2; $values[$key]=$value }
    return $values
}

try {
    $os=Get-CimInstance Win32_OperatingSystem
    $computer=Get-CimInstance Win32_ComputerSystem
    $results.environment=[ordered]@{
        Caption=[string]$os.Caption
        Version=[string]$os.Version
        BuildNumber=[int]$os.BuildNumber
        ProductType=[int]$os.ProductType
        OSArchitecture=[string]$os.OSArchitecture
        SystemType=[string]$computer.SystemType
    }
    Write-Output ("Environment: " + ($results.environment | ConvertTo-Json -Compress))
    if($results.environment.BuildNumber -lt 17763 -or $results.environment.ProductType -ne 1 -or $results.environment.OSArchitecture -notmatch '64-bit' -or $results.environment.SystemType -notmatch '(?i)x64' -or $results.environment.SystemType -match '(?i)arm64'){throw 'Unsupported OS: POSAPP requires Windows 10 1809 (build 17763) or later workstation on native x64.'}
    Check 'POSAppMariaDB service' { Require-Service 'POSAppMariaDB' }
    Check 'POSAppPhpMyAdmin service' { Require-Service 'POSAppPhpMyAdmin' }
    Check 'POSApp service' { Require-Service 'POSApp' }
    if($IncludeSpooler){ Check 'POS Print Spooler service' { Require-Service 'POS Print Spooler' } }
    Check 'POSApp dependency' { if(((sc.exe qc POSApp)-join "`n") -notmatch 'POSAppMariaDB'){throw 'POSAppMariaDB dependency missing.'} }
    Check 'Server startup repair task' { Require-StartupRepairTask 'POSAPP Startup Health Repair' }
    if($IncludeSpooler){ Check 'Spooler startup repair task' { Require-StartupRepairTask 'POSAPP Spooler Startup Health Repair' } }
    Check 'POS health release' {
        $health=Invoke-RestMethod "http://127.0.0.1:$PosPort/health"
        if($health.status -ne 'ok' -or $health.db -ne 'connected' -or ($ExpectedVersion -and $health.release.version -ne $ExpectedVersion) -or ($ExpectedCommit -and $health.release.commit -ne $ExpectedCommit) -or ($ExpectedSchemaVersion -and $health.release.schemaVersion -ne $ExpectedSchemaVersion)){throw 'Health/release mismatch.'}
    }
    Check '009384 login' {
        $login=Invoke-RestMethod "http://127.0.0.1:$PosPort/api/auth/login" -Method Post -ContentType 'application/json' -Body '{"user_number":"009384"}'
        if(-not $login.success -or -not $login.user){throw '009384 login failed.'}
    }
    Check 'MariaDB loopback bind' {
        $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $DatabasePort -ErrorAction Stop)
        if($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1','::1') }){throw 'MariaDB is listening beyond loopback.'}
        $ini=Get-Content 'C:\ProgramData\POSApp\database\my.ini' -Raw
        if($ini -notmatch 'bind-address=127\.0\.0\.1' -or $ini -notmatch "port=$DatabasePort"){throw 'MariaDB bind configuration mismatch.'}
    }
    Check 'Apache/phpMyAdmin loopback' {
        $httpd=Get-ChildItem 'C:\Program Files\POSApp\web-tools' -Filter httpd.conf -Recurse -ErrorAction Stop | Select-Object -First 1
        if(-not $httpd -or (Get-Content $httpd.FullName -Raw) -notmatch "Listen 127\.0\.0\.1:$PhpMyAdminPort"){throw 'Apache bind configuration mismatch.'}
        $response=Invoke-WebRequest "http://127.0.0.1:$PhpMyAdminPort/" -UseBasicParsing
        if($response.StatusCode -lt 200 -or $response.StatusCode -ge 400){throw 'phpMyAdmin HTTP check failed.'}
    }
    Check 'Private firewall rule' {
        $rule=Get-NetFirewallRule -DisplayName 'POSAPP POS Server' -ErrorAction Stop
        if($rule.Profile -notmatch 'Private' -or $rule.Direction -ne 'Inbound'){throw 'Firewall scope mismatch.'}
        if([string](Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule).LocalPort -ne [string]$PosPort){throw 'Firewall port mismatch.'}
    }
    Check 'Fresh database rows' {
        $node='C:\Program Files\POSApp\runtime\node\node.exe'
        $verify=Get-ChildItem 'C:\ProgramData\POSApp\config' -Filter verify.json -ErrorAction Stop | Select-Object -First 1
        & $node 'C:\Program Files\POSApp\deployment\tools\verify-install.js' '--config' $verify.FullName
        if($LASTEXITCODE -ne 0){throw 'Database verification failed.'}
    }
    Check 'POS App shortcut' {
        $shortcut=Get-Content 'C:\Users\Public\Desktop\POS App.url' -Raw
        if($shortcut -notmatch "(?m)^URL=http://localhost:$PosPort/pos\s*$"){throw 'Shortcut target mismatch.'}
    }
    Check 'Backup restore evidence' {
        $backup=Get-ChildItem 'C:\ProgramData\POSApp\backups' -Filter '*.sql.gz' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if(-not $backup){throw 'No compressed backup found.'}
        $checksum=(Get-FileHash $backup.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $sidecar=((Get-Content "$($backup.FullName).sha256" -Raw)-split '\s+')[0]
        if($checksum -ne $sidecar){throw 'Backup checksum mismatch.'}
        $sql=Join-Path $env:TEMP "posapp-restore-$PID.sql"
        $input=[IO.File]::OpenRead($backup.FullName); $gzip=[IO.Compression.GzipStream]::new($input,[IO.Compression.CompressionMode]::Decompress); $output=[IO.File]::Create($sql)
        try{$gzip.CopyTo($output)}finally{$output.Dispose();$gzip.Dispose();$input.Dispose()}
        $credentials=Read-EnvFile 'C:\ProgramData\POSApp\config\backup.env'
        $client='C:\Program Files\POSApp-MariaDB\bin\mariadb.exe'
        $env:MYSQL_PWD=$credentials.DB_PASSWORD
        try {
            & $client '-h' '127.0.0.1' '-P' $DatabasePort '-u' $credentials.DB_USER '-e' "DROP DATABASE IF EXISTS ``$RestoreDatabaseName``; CREATE DATABASE ``$RestoreDatabaseName`` CHARACTER SET utf8mb4;"
            if($LASTEXITCODE -ne 0){throw 'Restore database creation failed.'}
            & cmd.exe /d /s /c "`"`"$client`" -h 127.0.0.1 -P $DatabasePort -u $($credentials.DB_USER) $RestoreDatabaseName < `"$sql`"`""
            if($LASTEXITCODE -ne 0){throw 'Backup SQL restore failed.'}
            $tables=& $client '-N' '-h' '127.0.0.1' '-P' $DatabasePort '-u' $credentials.DB_USER $RestoreDatabaseName '-e' 'SHOW TABLES;'
            if($LASTEXITCODE -ne 0 -or @($tables).Count -lt 1){throw 'Restored database contains no tables.'}
        } finally {
            & $client '-h' '127.0.0.1' '-P' $DatabasePort '-u' $credentials.DB_USER '-e' "DROP DATABASE IF EXISTS ``$RestoreDatabaseName``;" | Out-Null
            Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
            Remove-Item $sql -Force -ErrorAction SilentlyContinue
        }
    }
    if($IncludeSpooler){
        Check 'Spooler registered identity' {
            $spooler=Read-EnvFile 'C:\ProgramData\POS-Spooler\config\spooler.env'
            $identity=Get-Content -Raw 'C:\ProgramData\POS-Spooler\state\agent.json' | ConvertFrom-Json
            $status=Invoke-RestMethod "http://127.0.0.1:$PosPort/api/spooler/v2/status" -Method Post -ContentType 'application/json' -Headers @{'x-spooler-key'=$spooler.SPOOLER_KEY} -Body (@{ spooler_id = $spooler.SPOOLER_ID } | ConvertTo-Json)
            if($status.station_protocol -ne 'v2' -or $status.agent_id -ne [string]$identity.agent_id -or -not $status.last_sync_at){throw 'Spooler v2 status mismatch.'}
        }
    }
    if($TerminalBUrl){ Check 'Terminal B probe' { if((Invoke-WebRequest "$TerminalBUrl/health" -UseBasicParsing).StatusCode -ne 200){throw 'Terminal B health failed.'} } }
    if($AfterReboot){
        Check 'reboot recovery' { Require-Service 'POSApp'; Require-Service 'POSAppMariaDB'; Require-Service 'POSAppPhpMyAdmin'; if($IncludeSpooler){Require-Service 'POS Print Spooler'} }
        Check 'server startup health result' {
            Wait-StartupRepairResult 'POSAPP Startup Health Repair' 'C:\ProgramData\POSApp\logs\startup-health.json' $os.LastBootUpTime
        }
        if($IncludeSpooler){ Check 'spooler startup health result' {
            Wait-StartupRepairResult 'POSAPP Spooler Startup Health Repair' 'C:\ProgramData\POS-Spooler\logs\startup-health.json' $os.LastBootUpTime
        } }
    }
    $results.completedAt=(Get-Date).ToUniversalTime().ToString('o')
    $results|ConvertTo-Json -Depth 8|Set-Content (Join-Path $resultDir "fresh-install-$stamp.json")
} finally { Stop-Transcript | Out-Null }
