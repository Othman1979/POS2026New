# Runs the POS as a Windows service (POSAppLocal) that starts with Windows and restarts if it stops.
# Run after setup-localhost.ps1:   powershell -ExecutionPolicy Bypass -File scripts\install-pos-service.ps1
# Remove the service:              powershell -ExecutionPolicy Bypass -File scripts\install-pos-service.ps1 -Remove
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$serviceName = 'POSAppLocal'
$repo = Split-Path -Parent $PSScriptRoot

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', "`"$PSCommandPath`"")
    if ($Remove) { $arguments += '-Remove' }
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments
    return
}

function Step([string]$message) { Write-Host "`n== $message" -ForegroundColor Cyan }
function Run([string]$exe, [string[]]$arguments) {
    & $exe @arguments
    if ($LASTEXITCODE -ne 0) { throw "'$exe $($arguments -join ' ')' failed (exit code $LASTEXITCODE)." }
}

$dataDir = Join-Path $repo 'data'
$nssm = Join-Path $dataDir 'nssm\nssm.exe'
$existing = Get-Service $serviceName -ErrorAction SilentlyContinue

if ($Remove) {
    if (-not $existing) { Write-Host "Service $serviceName is not installed."; return }
    Step "Removing service $serviceName"
    & sc.exe stop $serviceName | Out-Null
    Start-Sleep -Seconds 3
    Run 'sc.exe' @('delete', $serviceName)
    Write-Host 'Done. You can start the POS manually with start-pos.cmd again.' -ForegroundColor Green
    return
}

$envFile = Join-Path $repo '.env'
if (-not (Test-Path $envFile)) { throw 'This PC is not set up yet. Run scripts\setup-localhost.ps1 first.' }
if (-not (Test-Path (Join-Path $repo 'dist\index.html'))) { throw 'The app is not built. Run: npm run build' }
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'Node.js is not installed.' }
$nodeExe = $nodeCommand.Source
$port = 3000
$portLine = Get-Content $envFile | Where-Object { $_ -match '^PORT=\d+' } | Select-Object -First 1
if ($portLine) { $port = [int]($portLine.Split('=')[1]) }

if (-not (Test-Path $nssm)) {
    Step 'Downloading NSSM 2.24 (service helper)'
    $zip = Join-Path $dataDir 'nssm-2.24.zip'
    New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
    if (-not (Test-Path $zip)) {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        try { Invoke-WebRequest -UseBasicParsing -Uri 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $zip }
        catch { Remove-Item $zip -Force -ErrorAction SilentlyContinue; throw "Could not download NSSM. Download https://nssm.cc/release/nssm-2.24.zip in the browser, put it in $dataDir and run this script again." }
    }
    if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne '727D1E42275C605E0F04ABA98095C38A8E1E46DEF453CDFFCE42869428AA6743') {
        Remove-Item $zip -Force
        throw 'The NSSM download is damaged (checksum mismatch). Run this script again.'
    }
    $extract = Join-Path $dataDir 'nssm-extract'
    if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
    Expand-Archive $zip $extract -Force
    New-Item -ItemType Directory -Force -Path (Split-Path $nssm) | Out-Null
    Copy-Item (Join-Path $extract 'nssm-2.24\win64\nssm.exe') $nssm
    Remove-Item $extract -Recurse -Force
}

$dbService = Get-Service | Where-Object { $_.Name -match '^(MariaDB|MySQL)' } | Select-Object -First 1
if ($dbService) { Write-Host "The POS service will start after the database service $($dbService.Name)." }
else { Write-Host 'No MariaDB/MySQL service found; make sure the database starts with Windows.' -ForegroundColor Yellow }

if ($existing) {
    Step "Updating service $serviceName"
    & sc.exe stop $serviceName | Out-Null
    Start-Sleep -Seconds 3
} else {
    Step "Creating service $serviceName"
    Run $nssm @('install', $serviceName, $nodeExe)
}
$logDir = Join-Path $dataDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
# Windows PowerShell 5 strips one quote layer before NSSM sees AppParameters.
Run $nssm @('set', $serviceName, 'Application', $nodeExe)
Run $nssm @('set', $serviceName, 'AppDirectory', $repo)
Run $nssm @('set', $serviceName, 'AppParameters', ('"""' + (Join-Path $repo 'server.js') + '"""'))
Run $nssm @('set', $serviceName, 'AppEnvironmentExtra', 'NODE_ENV=production', "POSAPP_ENV_FILE=$envFile")
Run $nssm @('set', $serviceName, 'DisplayName', 'POS App (localhost)')
Run $nssm @('set', $serviceName, 'AppStdout', (Join-Path $logDir 'service.out.log'))
Run $nssm @('set', $serviceName, 'AppStderr', (Join-Path $logDir 'service.err.log'))
Run $nssm @('set', $serviceName, 'AppRotateFiles', '1')
Run $nssm @('set', $serviceName, 'AppRotateBytes', '1048576')
$startArgs = @('config', $serviceName, 'start=', 'delayed-auto')
if ($dbService) { $startArgs += @('depend=', $dbService.Name) }
Run 'sc.exe' $startArgs
Run 'sc.exe' @('failure', $serviceName, 'reset=', '86400', 'actions=', 'restart/5000/restart/15000/restart/60000')

Step "Starting service $serviceName"
Start-Service $serviceName
$ok = $false
for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
    Start-Sleep -Seconds 2
    try { $ok = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3).StatusCode -eq 200 } catch { }
}
if (-not $ok) { throw "The service did not answer on port $port. If start-pos.cmd is open, close it and run this script again. Details: $(Join-Path $logDir 'service.err.log')" }
Write-Host "Done. The POS now runs in the background and starts with Windows: http://localhost:$port" -ForegroundColor Green
Write-Host 'start-pos.cmd now only opens the browser.' -ForegroundColor Green
