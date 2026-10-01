[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$detector = Join-Path $repo 'deployment\windows\Detect-LocalPosServer.ps1'
$work = Join-Path ([IO.Path]::GetTempPath()) "pos-local-spooler-detection-$PID-$([Guid]::NewGuid().ToString('N'))"
$validAppId = '{E99DB275-DDA0-43A0-95CD-7AE07185122C}'
$validKey = 'A' * 43
$listenerJobs = @()

function Write-Utf8NoBom([string]$Path, [string]$Contents) {
    [IO.File]::WriteAllText($Path, $Contents, [Text.UTF8Encoding]::new($false))
}
function New-Fixture([string]$Name, [string]$AppId = $validAppId, [string]$Key = $validKey, [int]$Port = 1, [switch]$OmitMetadata) {
    $root = Join-Path $work $Name
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'config') | Out-Null
    if (-not $OmitMetadata) { Write-Utf8NoBom (Join-Path $root 'install.json') (@{ appId = $AppId; posPort = $Port } | ConvertTo-Json -Compress) }
    Write-Utf8NoBom (Join-Path $root 'config\pos.env') "SPOOLER_KEY=$Key"
    $result = Join-Path $root 'result.txt'
    Write-Utf8NoBom $result ''
    return [pscustomobject]@{ Root = $root; Result = $result; Port = $Port }
}
function Get-FreeLoopbackPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try { $listener.Start(); return ([Net.IPEndPoint]$listener.LocalEndpoint).Port }
    finally { $listener.Stop() }
}
function Start-HealthListener([int]$Port, [hashtable]$Health, [string]$ReadyPath) {
    $prefix = "http://127.0.0.1:$Port/"
    $body = $Health | ConvertTo-Json -Compress -Depth 5
    $job = Start-Job -ArgumentList $prefix, $body, $ReadyPath -ScriptBlock {
        param($ListenerPrefix, $ResponseBody, $ReadyFile)
        $ErrorActionPreference = 'Stop'
        $listener = [Net.HttpListener]::new()
        $listener.Prefixes.Add($ListenerPrefix)
        try {
            $listener.Start()
            [IO.File]::WriteAllText($ReadyFile, 'ready', [Text.UTF8Encoding]::new($false))
            $contextTask = $listener.GetContextAsync()
            if (-not $contextTask.Wait(5000)) { return }
            $context = $contextTask.Result
            $bytes = [Text.Encoding]::UTF8.GetBytes($ResponseBody)
            $context.Response.StatusCode = 200
            $context.Response.ContentType = 'application/json'
            $context.Response.ContentLength64 = $bytes.Length
            $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
            $context.Response.OutputStream.Close()
        }
        finally {
            $listener.Stop()
            $listener.Close()
        }
    }
    $script:listenerJobs += $job
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        if (Test-Path -LiteralPath $ReadyPath -PathType Leaf) { return $job }
        if ($job.State -eq 'Failed') { $null = Receive-Job $job -ErrorAction SilentlyContinue; throw 'Health listener failed to start.' }
        Start-Sleep -Milliseconds 100
    }
    throw 'Health listener did not become ready.'
}
function Invoke-Detector([pscustomobject]$Fixture) {
    $output = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $detector -ResultFile $Fixture.Result -ProgramDataRoot $Fixture.Root -HealthTimeoutSeconds 2 2>&1)
    $exitCode = $LASTEXITCODE
    if (($output -join "`n") -match [regex]::Escape($validKey)) { throw 'Detector wrote the spooler key to stdout.' }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = $output }
}
function Assert-ExitCode([pscustomobject]$Result, [int]$Expected) {
    if ($Result.ExitCode -ne $Expected) { throw "Detector returned an unexpected exit code ($($Result.ExitCode))." }
}

try {
    New-Item -ItemType Directory -Force -Path $work | Out-Null

    $healthyPort = Get-FreeLoopbackPort
    $healthy = New-Fixture 'healthy' -Port $healthyPort
    if (Test-Path -LiteralPath (Join-Path $healthy.Root 'config\secrets.json')) { throw 'Probe fixture must not create secrets.json.' }
    $healthyReady = Join-Path $healthy.Root 'listener.ready'
    $healthyJob = Start-HealthListener $healthyPort @{ status = 'ok'; db = 'connected'; release = @{ version = '1.0.0' } } $healthyReady
    $healthyResult = Invoke-Detector $healthy
    Assert-ExitCode $healthyResult 0
    $healthyLines = @(Get-Content -LiteralPath $healthy.Result)
    if ($healthyLines.Count -ne 2 -or $healthyLines[0] -ne "http://127.0.0.1:$healthyPort" -or $healthyLines[1] -ne $validKey) { throw 'Healthy detection result was not the exact URL and key pair.' }
    $healthyBytes = [IO.File]::ReadAllBytes($healthy.Result)
    if ($healthyBytes.Length -ge 3 -and $healthyBytes[0] -eq 0xEF -and $healthyBytes[1] -eq 0xBB -and $healthyBytes[2] -eq 0xBF) { throw 'Healthy detection result contains a UTF-8 BOM.' }

    $missing = New-Fixture 'missing' -Port $healthyPort -OmitMetadata
    Assert-ExitCode (Invoke-Detector $missing) 2
    $wrongOwner = New-Fixture 'wrong-owner' -Port $healthyPort -AppId '{80657A48-9BCB-4455-8CA9-A18139FDFC58}'
    Assert-ExitCode (Invoke-Detector $wrongOwner) 2
    $invalidKey = New-Fixture 'invalid-key' -Port $healthyPort -Key 'not-a-spooler-key'
    Assert-ExitCode (Invoke-Detector $invalidKey) 2

    $unhealthyPort = Get-FreeLoopbackPort
    $unhealthy = New-Fixture 'unhealthy' -Port $unhealthyPort
    $unhealthyReady = Join-Path $unhealthy.Root 'listener.ready'
    $unhealthyJob = Start-HealthListener $unhealthyPort @{ status = 'starting'; db = 'connected'; release = @{ version = '1.0.0' } } $unhealthyReady
    Assert-ExitCode (Invoke-Detector $unhealthy) 2
    Write-Output 'Local spooler detection probe passed.'
}
finally {
    foreach ($job in @($listenerJobs)) {
        Remove-Job $job -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}
