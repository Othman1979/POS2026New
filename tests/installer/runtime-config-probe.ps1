[CmdletBinding()]
param(
    [string]$VendorDir = '',
    [string]$WorkRoot = '',
    [switch]$ReuseExtracted
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$VendorDir = if ($VendorDir) { $VendorDir } else { Join-Path $repo 'deployment\vendor' }
$WorkRoot = if ($WorkRoot) { $WorkRoot } else { Join-Path $repo 'deployment\out\runtime-config-probe' }
$outRoot = (Resolve-Path (Join-Path $repo 'deployment\out')).Path
$work = [IO.Path]::GetFullPath($WorkRoot)
if (-not $work.StartsWith($outRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'WorkRoot must be below deployment\out.' }
if ((Test-Path $work) -and -not $ReuseExtracted) { Remove-Item -LiteralPath $work -Recurse -Force }
New-Item -ItemType Directory -Force -Path $work | Out-Null
function Write-Utf8NoBom([string]$Path, [string]$Contents) { [IO.File]::WriteAllText($Path, $Contents, [Text.UTF8Encoding]::new($false)) }
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

# Evaluate only the production socket helpers; do not dot-source the provisioning script.
$installScript = Join-Path $repo 'deployment\windows\Install-PosServer.ps1'
$installText = Get-Content -LiteralPath $installScript -Raw
$socketStart = $installText.IndexOf('function Assert-PortAvailable')
$socketEnd = $installText.IndexOf('function Set-PrivateAcl', $socketStart)
if ($socketStart -lt 0 -or $socketEnd -le $socketStart) { throw 'Socket helper block is missing from Install-PosServer.ps1.' }
Invoke-Expression $installText.Substring($socketStart, $socketEnd - $socketStart)
$socketTimer = [Diagnostics.Stopwatch]::StartNew()
$occupiedListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$freeListener = $null
try {
    $occupiedListener.Start()
    $occupiedPort = ([Net.IPEndPoint]$occupiedListener.LocalEndpoint).Port
    $occupiedRejected = $false
    try { Assert-PortAvailable $occupiedPort } catch { $occupiedRejected = $true }
    if (-not $occupiedRejected) { throw "Occupied socket probe unexpectedly accepted port $occupiedPort." }
    if (-not (Test-TcpPort $occupiedPort)) { throw "TCP connection probe did not detect listening port $occupiedPort." }

    $freeListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $freeListener.Start()
    $freePort = ([Net.IPEndPoint]$freeListener.LocalEndpoint).Port
    $freeListener.Stop()
    $freeListener = $null
    Assert-PortAvailable $freePort
    if (Test-TcpPort $freePort) { throw "TCP connection probe unexpectedly connected to free port $freePort." }
} finally {
    if ($freeListener) { $freeListener.Stop() }
    $occupiedListener.Stop()
    $socketTimer.Stop()
}
if ($socketTimer.ElapsedMilliseconds -ge 2000) { throw "Socket helper probe exceeded 2 seconds: $($socketTimer.ElapsedMilliseconds) ms." }
Write-Output "Socket helper probe passed in $($socketTimer.ElapsedMilliseconds) ms."

$apacheDir=Join-Path $work 'apache'; $phpDir=Join-Path $work 'php'; $pmaDir=Join-Path $work 'pma'
if (-not (Test-Path $apacheDir)) { Expand-Archive (Join-Path $VendorDir 'httpd-2.4.68-260617-Win64-VS18.zip') $apacheDir }
if (-not (Test-Path $phpDir)) { Expand-Archive (Join-Path $VendorDir 'php-8.4.16-Win32-vs17-x64.zip') $phpDir }
if (-not (Test-Path $pmaDir)) { Expand-Archive (Join-Path $VendorDir 'phpMyAdmin-5.2.3-all-languages.zip') $pmaDir }
$apacheRoot=Resolve-ArchiveRoot $apacheDir 'bin\httpd.exe'
$phpRoot=Resolve-ArchiveRoot $phpDir 'php.exe'
$pmaRoot=Resolve-ArchiveRoot $pmaDir 'index.php'
$logs=Join-Path $work 'logs'; $sessions=Join-Path $work 'sessions'
New-Item -ItemType Directory -Force -Path $logs,$sessions | Out-Null
$node=Join-Path $repo 'deployment\out\toolchain\node\node.exe'
$renderer=Join-Path $repo 'deployment\tools\installer-config.js'
$httpValues=Join-Path $work 'http-values.json'
Write-Utf8NoBom $httpValues (@{APACHE_ROOT=$apacheRoot;PHPMYADMIN_ROOT=$pmaRoot;PHPMYADMIN_PORT=18081;PHP_ROOT=$phpRoot;LOG_DIR=$logs}|ConvertTo-Json)
& $node $renderer write-server-config --template (Join-Path $repo 'deployment\templates\httpd.conf.template') --output (Join-Path $apacheRoot 'conf\httpd.conf') --values $httpValues
if($LASTEXITCODE -ne 0){throw 'Apache config rendering failed.'}
$phpValues=Join-Path $work 'php-values.json'
Write-Utf8NoBom $phpValues (@{PHP_ROOT=$phpRoot;LOG_DIR=$logs;SESSION_DIR=$sessions}|ConvertTo-Json)
& $node $renderer write-server-config --template (Join-Path $repo 'deployment\templates\php.ini.template') --output (Join-Path $phpRoot 'php.ini') --values $phpValues
if($LASTEXITCODE -ne 0){throw 'PHP config rendering failed.'}
& (Join-Path $apacheRoot 'bin\httpd.exe') -t -f (Join-Path $apacheRoot 'conf\httpd.conf')
if($LASTEXITCODE -ne 0){throw 'Apache configuration or PHP module compatibility probe failed.'}
$modules=& (Join-Path $phpRoot 'php.exe') -c (Join-Path $phpRoot 'php.ini') -m
if($LASTEXITCODE -ne 0){throw 'PHP module probe failed.'}
foreach($required in @('mysqli','mbstring','openssl','zip','gd')){if($modules -notcontains $required){throw "Missing PHP module: $required"}}
Write-Output 'Apache/PHP/phpMyAdmin runtime configuration probe passed.'
