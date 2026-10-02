# Sets up a fresh, empty POS on this PC (http://localhost). Requires Node.js 22+ and a running MariaDB/MySQL.
# Run from the project folder:  powershell -ExecutionPolicy Bypass -File scripts\setup-localhost.ps1
param(
    [int]$Port = 3000,
    [int]$DbPort = 3306
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Step([string]$message) { Write-Host "`n== $message" -ForegroundColor Cyan }
function Run([string]$exe, [string[]]$arguments) {
    & $exe @arguments
    if ($LASTEXITCODE -ne 0) { throw "'$exe $($arguments -join ' ')' failed (exit code $LASTEXITCODE)." }
}
function Plain([Security.SecureString]$secure) {
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
function AskNew([string]$prompt) {
    while ($true) {
        $first = Plain (Read-Host $prompt -AsSecureString)
        if ($first.Length -lt 4) { Write-Host 'Use at least 4 characters.' -ForegroundColor Yellow; continue }
        $second = Plain (Read-Host 'Type it again' -AsSecureString)
        if ($first -ceq $second) { return $first }
        Write-Host 'The two entries do not match.' -ForegroundColor Yellow
    }
}
function PortOpen([int]$number) {
    $client = New-Object Net.Sockets.TcpClient
    try { $client.Connect('127.0.0.1', $number); return $true } catch { return $false } finally { $client.Close() }
}
function WriteUtf8([string]$path, [string]$text) {
    [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false))
}

$envFile = Join-Path $repo '.env'
if (Test-Path $envFile) { throw ".env already exists, so this PC is already set up. Start the POS with start-pos.cmd." }

Step 'Checking Node.js'
$nodeVersion = (& node -p 'process.versions.node' 2>$null)
if (-not $nodeVersion) { throw 'Node.js is not installed. Install Node.js 22 LTS from https://nodejs.org and open a new PowerShell window.' }
if ([int]($nodeVersion.Split('.')[0]) -lt 22) { throw "Node.js $nodeVersion is too old. Install Node.js 22 LTS from https://nodejs.org." }
Write-Host "Node.js $nodeVersion"

Step "Checking the database server on port $DbPort"
if (-not (PortOpen $DbPort)) { throw "No MariaDB/MySQL is running on port $DbPort. Start it (or install MariaDB from https://mariadb.org/download) and run this script again." }
if (PortOpen $Port) { throw "Port $Port is already in use. Close the program using it, or run this script with -Port 3001." }
$dump = Get-ChildItem -Path 'C:\Program Files\MariaDB*\bin\mariadb-dump.exe', 'C:\xampp\mysql\bin\mysqldump.exe', 'C:\Program Files\MySQL\*\bin\mysqldump.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
$dumpPath = ''
if ($dump) { $dumpPath = $dump.FullName; Write-Host "Backups will use $dumpPath" } else { Write-Host 'mariadb-dump.exe was not found; database backups from the app will not work until MYSQLDUMP_PATH is set in .env.' -ForegroundColor Yellow }

$rootPassword = Plain (Read-Host 'MariaDB root password (the one you chose when installing MariaDB)' -AsSecureString)
$newRootPassword = $rootPassword
if (-not $rootPassword) { $newRootPassword = AskNew 'root has no password. Choose a new MariaDB root password' }
$maintenancePassword = AskNew 'Choose the maintenance password (asked before a reset in Settings)'

Step 'Installing packages (a few minutes)'
Run 'npm' @('ci', '--no-audit', '--no-fund')
Step 'Building the app'
Run 'npm' @('run', 'build')

Step 'Creating the empty database'
$secrets = (& node -e "const c=require('crypto');const r=()=>c.randomBytes(24).toString('hex');console.log(JSON.stringify({app:r(),maintenance:r(),spooler:r(),programmer:String(c.randomInt(100000000000,999999999999))}))") | ConvertFrom-Json
$config = Join-Path ([IO.Path]::GetTempPath()) ("posapp-bootstrap-" + [guid]::NewGuid().ToString('N') + '.json')
try {
    WriteUtf8 $config (@{
        host = '127.0.0.1'; port = $DbPort; adminUser = 'root'
        initialAdminPassword = $rootPassword; adminPassword = $newRootPassword
        appPassword = $secrets.app; maintenancePassword = $secrets.maintenance
        programmerUserNumber = $secrets.programmer
    } | ConvertTo-Json)
    Run 'node' @('deployment/tools/bootstrap-database.js', '--config', $config)
} finally {
    Remove-Item -LiteralPath $config -Force -ErrorAction SilentlyContinue
}

Step 'Writing .env'
$data = Join-Path $repo 'data'
foreach ($dir in @('logs', 'backups')) { New-Item -ItemType Directory -Force -Path (Join-Path $data $dir) | Out-Null }
$values = @{
    POS_PORT = $Port; DB_PORT = $DbPort; DB_APP_PASSWORD = $secrets.app; SPOOLER_KEY = $secrets.spooler
    DATA_DIR = $data; UPLOAD_DIR = (Join-Path $repo 'uploads'); LOG_DIR = (Join-Path $data 'logs')
    BACKUP_DIR = (Join-Path $data 'backups'); MARIADB_DUMP_EXE = $dumpPath
}
$text = [IO.File]::ReadAllText((Join-Path $repo 'deployment/templates/pos.env.template'))
foreach ($key in $values.Keys) { $text = $text.Replace("{{$key}}", [string]$values[$key]) }
$sha = [Security.Cryptography.SHA256]::Create()
$hash = -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($maintenancePassword)) | ForEach-Object { $_.ToString('x2') })
$text = $text.TrimEnd() + "`nMAINTENANCE_RESET_PASSWORD_HASH=$hash`n"
WriteUtf8 $envFile $text
WriteUtf8 (Join-Path $data 'maintenance.env') "DB_HOST=127.0.0.1`nDB_PORT=$DbPort`nDB_NAME=posapp`nDB_USER=posapp_maintenance`nDB_PASSWORD=$($secrets.maintenance)`n"

Step 'Done'
Write-Host "Start the POS with start-pos.cmd, then open http://localhost:$Port" -ForegroundColor Green
Write-Host 'Log in with user number 009384 (no PIN), then change it from Users.' -ForegroundColor Green
