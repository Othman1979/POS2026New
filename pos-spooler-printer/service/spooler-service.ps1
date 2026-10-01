<#
    Register a raw-copied POS spooler folder as a Windows service.

    This is for the copy-the-folder-by-hand workflow, not for POSAPP-Spooler-Setup.exe.
    It does the same thing the real installer does to the service - same NSSM settings,
    same environment, same log rotation - without the packaged payload layout
    or update machinery that the packaged installer needs.

    ONE service is correct. server.js is not just an HTTP listener: it loads the V2
    agent runtime in-process (server.js:10) and spawns the C# platform helper as its
    own child (v2/platform-helper.js:174). Registering a second service for "the agent"
    would start a second agent against the same state directory, which the state root
    lock rejects with STATE_ROOT_LOCKED and exit code 73.

        .\spooler-service.ps1 -Action install
        .\spooler-service.ps1 -Action start | stop | restart | status | uninstall

    Elevates itself; you do not need an admin prompt first.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('install', 'start', 'stop', 'restart', 'status', 'uninstall')]
    [string]$Action,

    # Where server.js lives. Defaults to this folder, then its parent.
    [string]$SpoolerRoot,

    [string]$ServiceName = 'POS Print Spooler',
    [string]$StateDirectory = 'C:\ProgramData\POS-Spooler\state',
    [string]$LogDirectory = 'C:\ProgramData\POS-Spooler\logs'
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# ── elevation ───────────────────────────────────────────────────────────────
$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $argumentList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$($MyInvocation.MyCommand.Path)`"", '-Action', $Action)
    if ($SpoolerRoot) { $argumentList += @('-SpoolerRoot', "`"$SpoolerRoot`"") }
    Write-Host 'Requesting administrator rights...' -ForegroundColor Yellow
    Start-Process -FilePath 'powershell.exe' -ArgumentList $argumentList -Verb RunAs
    exit 0
}

function Fail([string]$Message) { Write-Host "  $Message" -ForegroundColor Red; exit 1 }
function Say([string]$Message) { Write-Host "  $Message" }
function Ok([string]$Message) { Write-Host "  $Message" -ForegroundColor Green }

function Invoke-Native([string]$File, [string[]]$Arguments) {
    # A native process writing to stderr is not a PowerShell error, but with
    # ErrorActionPreference=Stop the 2>&1 redirect turns every stderr line into a
    # terminating one. `npm warn deprecated prebuild-install@7.1.3` is written to
    # stderr by an npm run that exits 0, and it aborted an install that had already
    # succeeded. Exit code is the only reliable success signal for a native command,
    # so judge on that and let the process say whatever it likes on stderr.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $output = & $File @Arguments 2>&1 }
    finally { $ErrorActionPreference = $previous }
    if ($LASTEXITCODE -ne 0) { throw "$([IO.Path]::GetFileName($File)) $($Arguments -join ' ') failed: $output" }
    return $output
}

# Pinned to deployment/vendor-lock.json, the same versions and hashes the packaged
# installer ships. spoolerServiceBootstrap.test.js fails if these drift from it.
$NodeVersion = '22.23.0'
$NodeUrl = 'https://nodejs.org/dist/v22.23.0/node-v22.23.0-win-x64.zip'
$NodeSha256 = '425a5bd68cc95e8eb16bcccd0a75081b48983fc6a26f67126bd4d6c7198231e8'
$NssmUrl = 'https://nssm.cc/release/nssm-2.24.zip'
$NssmSha256 = '727d1e42275c605e0f04aba98095c38a8e1e46def453cdffce42869428aa6743'

# Never extract something we have not checked. These run as SYSTEM afterwards.
function Get-VerifiedArchive([string]$Url, [string]$Sha256, [string]$Destination) {
    Say "  downloading $([IO.Path]::GetFileName($Destination))"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $previous = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try { Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing }
    finally { $ProgressPreference = $previous }
    $actual = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Sha256) {
        Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
        Fail "Checksum mismatch for $Url`n  expected $Sha256`n  got      $actual"
    }
    Say '  checksum verified'
}

# ── locate the spooler ──────────────────────────────────────────────────────
function Resolve-SpoolerRoot {
    if ($SpoolerRoot) {
        if (-not (Test-Path -LiteralPath (Join-Path $SpoolerRoot 'server.js') -PathType Leaf)) {
            Fail "No server.js under -SpoolerRoot '$SpoolerRoot'."
        }
        return (Resolve-Path -LiteralPath $SpoolerRoot).Path.TrimEnd('\')
    }
    foreach ($candidate in @($scriptDir, (Split-Path -Parent $scriptDir))) {
        if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate 'server.js') -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $candidate).Path.TrimEnd('\')
        }
    }
    Fail "Could not find server.js in '$scriptDir' or its parent. Put this folder inside the spooler directory, or pass -SpoolerRoot."
}

$root = Resolve-SpoolerRoot
$serverScript = Join-Path $root 'server.js'
$envFile = Join-Path $root '.env'

Write-Host ''
Write-Host "POS Print Spooler service  -  $Action" -ForegroundColor Cyan
Write-Host "  spooler: $root"
Write-Host ''

# ── simple verbs ────────────────────────────────────────────────────────────
function Get-SpoolerService { return Get-Service -Name $ServiceName -ErrorAction SilentlyContinue }

function Show-Status {
    $service = Get-SpoolerService
    if (-not $service) { Say 'Service is not installed.'; return }
    $wmi = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
    Say "State       : $($service.Status)"
    Say "Startup     : $($wmi.StartMode)"
    Say "Runs        : $($wmi.PathName)"
    $parameters = Get-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters" -ErrorAction SilentlyContinue
    if ($parameters) {
        Say "Application : $($parameters.Application)"
        Say "Script      : $($parameters.AppParameters)"
        Say "Directory   : $($parameters.AppDirectory)"
    }
    $errorLog = Join-Path $LogDirectory 'spooler-service.err.log'
    if (Test-Path -LiteralPath $errorLog) {
        $tail = Get-Content -LiteralPath $errorLog -Tail 5 -ErrorAction SilentlyContinue
        if ($tail) { Write-Host ''; Say 'Last 5 error-log lines:'; $tail | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }
    }
}

switch ($Action) {
    'status' { Show-Status; Write-Host ''; exit 0 }
    'start' {
        if (-not (Get-SpoolerService)) { Fail 'Service is not installed. Run install first.' }
        Start-Service -Name $ServiceName
        Ok 'Started.'; Write-Host ''; exit 0
    }
    'stop' {
        if (-not (Get-SpoolerService)) { Fail 'Service is not installed.' }
        Stop-Service -Name $ServiceName -Force
        Ok 'Stopped.'; Write-Host ''; exit 0
    }
    'restart' {
        if (-not (Get-SpoolerService)) { Fail 'Service is not installed. Run install first.' }
        Restart-Service -Name $ServiceName -Force
        Ok 'Restarted.'; Write-Host ''; exit 0
    }
    'uninstall' {
        $service = Get-SpoolerService
        if (-not $service) { Say 'Service is not installed; nothing to remove.'; Write-Host ''; exit 0 }
        if ($service.Status -ne 'Stopped') { Stop-Service -Name $ServiceName -Force }
        $nssm = Join-Path $root 'runtime\nssm\nssm.exe'
        if (Test-Path -LiteralPath $nssm -PathType Leaf) {
            & $nssm 'remove' $ServiceName 'confirm' | Out-Null
        } else {
            & sc.exe delete "$ServiceName" | Out-Null
        }
        Start-Sleep -Milliseconds 750
        if (Get-SpoolerService) { Fail 'Service still present after removal; a reboot may be required.' }
        Ok 'Service removed. The spooler folder, its state and its logs were left alone.'
        Write-Host ''
        exit 0
    }
}

# ── install ─────────────────────────────────────────────────────────────────

# 1. Node. Prefer the copy bundled with the payload; a system Node is a fallback.
$bundledNode = Join-Path $root 'runtime\node\node.exe'
if (-not (Test-Path -LiteralPath $bundledNode -PathType Leaf)) {
    # Fetch the pinned runtime into the spooler folder rather than installing Node
    # system-wide. The spooler then owns its interpreter and cannot be broken by
    # someone upgrading or removing a machine-wide Node later.
    Say 'Node        : not bundled, fetching the pinned runtime'
    $temporary = Join-Path ([IO.Path]::GetTempPath()) "pos-spooler-node-$PID"
    New-Item -ItemType Directory -Path $temporary -Force | Out-Null
    try {
        $zip = Join-Path $temporary 'node.zip'
        Get-VerifiedArchive $NodeUrl $NodeSha256 $zip
        Expand-Archive -LiteralPath $zip -DestinationPath $temporary -Force
        $extracted = Get-ChildItem -LiteralPath $temporary -Directory |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'node.exe') } |
            Select-Object -First 1
        if (-not $extracted) { Fail 'The Node archive did not contain node.exe.' }
        New-Item -ItemType Directory -Path (Join-Path $root 'runtime') -Force | Out-Null
        Move-Item -LiteralPath $extracted.FullName -Destination (Join-Path $root 'runtime\node') -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue }
    }
    if (-not (Test-Path -LiteralPath $bundledNode -PathType Leaf)) { Fail 'Node was not installed into runtime\node.' }
}
$nodeExe = $bundledNode
$nodeReported = (& $nodeExe --version).Trim()
if ($nodeReported -notmatch '^v\d+\.\d+\.\d+$' -or [version]$nodeReported.TrimStart('v') -lt [version]'22.12.0') { Fail "The spooler needs Node 22.12 or newer; runtime\node reports $nodeReported. Upgrade the installed Node runtime first." }
Ok "Node        : $nodeReported (runtime\node)"

# npm generates a shim per bin that falls back to a bare `node` for whatever it
# spawns for install scripts.
# This machine has no system-wide Node by design - the runtime
# lives in runtime\node and is only ever called by full path - so those children die
# with "'node' is not recognized". Put the bundled runtime on PATH for this
# process only; nothing machine-wide changes and the service keeps its own env.
$env:PATH = "$(Split-Path -Parent $nodeExe);$env:PATH"

# 2. Dependencies. The staged payload already has them; only a source-tree copy
#    needs npm.
$nodeModules = Join-Path $root 'node_modules'
$typstRuntime = Join-Path $root '.cache\typst\0.15.1\typst.exe'
if ((Test-Path -LiteralPath $nodeModules -PathType Container) -and (Test-Path -LiteralPath (Join-Path $nodeModules 'dotenv') -PathType Container)) {
    Ok 'Dependencies: already present, skipping npm install'
} else {
    Say 'Dependencies: node_modules is missing - installing (needs internet)'
    $npmCmd = Join-Path (Split-Path -Parent $nodeExe) 'npm.cmd'
    if (-not (Test-Path -LiteralPath $npmCmd -PathType Leaf)) {
        $found = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if (-not $found) { Fail 'npm was not found next to node.exe or on PATH.' }
        $npmCmd = $found.Source
    }
    Push-Location $root
    try {
        if (Test-Path -LiteralPath (Join-Path $root 'package-lock.json') -PathType Leaf) {
            # npm ci installs the locked tree exactly, which is what every other
            # station runs. npm install would be free to resolve something newer.
            Say '  npm ci'
            Invoke-Native $npmCmd @('ci', '--omit=dev', '--no-audit', '--no-fund') | Out-Null
        } else {
            Say '  npm install (no package-lock.json present)'
            Invoke-Native $npmCmd @('install', '--omit=dev', '--no-audit', '--no-fund') | Out-Null
        }
    } finally { Pop-Location }
    Ok 'Dependencies: installed'
}
if (-not (Test-Path -LiteralPath $typstRuntime -PathType Leaf)) { Fail 'The pinned Typst runtime is missing. Use a packaged spooler installation.' }

# 3. Config. NODE_ENV=production makes these two mandatory (server.js:22-26), and a
#    service that crash-loops on a missing key is worse than refusing to install.
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    $example = Join-Path $root '.env.example'
    if (Test-Path -LiteralPath $example -PathType Leaf) { Copy-Item -LiteralPath $example -Destination $envFile }
    Fail @"
No .env in $root

$(if (Test-Path -LiteralPath $envFile) { "A starting point was copied from .env.example. Edit it, then run install again." } else { "Create one with at least CLOUD_SERVER_URL and SPOOLER_KEY." })
"@
}
$envText = Get-Content -LiteralPath $envFile -Raw
foreach ($required in @('CLOUD_SERVER_URL', 'SPOOLER_KEY')) {
    $match = [regex]::Match($envText, "(?m)^\s*$required\s*=\s*(.+?)\s*$")
    if (-not $match.Success -or -not $match.Groups[1].Value.Trim()) {
        Fail "$required is missing or empty in $envFile. The spooler refuses to start in production without it."
    }
}
if ($envText -match '(?m)^\s*SPOOLER_KEY\s*=\s*replace-with-the-pos-spooler-key\s*$') {
    Fail "SPOOLER_KEY in $envFile is still the placeholder from .env.example."
}
Ok 'Config      : .env has CLOUD_SERVER_URL and SPOOLER_KEY'

# 4. NSSM. Reuse the copy in the payload, or unpack the vendored archive.
$nssmDirectory = Join-Path $root 'runtime\nssm'
$nssmExe = Join-Path $nssmDirectory 'nssm.exe'
if (-not (Test-Path -LiteralPath $nssmExe -PathType Leaf)) {
    # The staged payload carries the archive; a source-tree copy does not, so also
    # accept a copy dropped next to this script.
    $archive = @(
        (Join-Path $root 'install\vendor\nssm-2.24.zip'),
        (Join-Path $scriptDir 'nssm-2.24.zip')
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $archive) {
        Say 'NSSM        : not bundled, fetching the pinned archive'
        $archive = Join-Path ([IO.Path]::GetTempPath()) "pos-spooler-nssm-$PID.zip"
        Get-VerifiedArchive $NssmUrl $NssmSha256 $archive
        $temporaryArchive = $true
    }
    $extractRoot = Join-Path ([IO.Path]::GetTempPath()) "pos-spooler-nssm-$PID"
    try {
        if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
        Expand-Archive -LiteralPath $archive -DestinationPath $extractRoot -Force
        $source = Get-ChildItem -LiteralPath $extractRoot -Recurse -File -Filter 'nssm.exe' |
            Where-Object { $_.FullName -match '(?i)[\\/]win64[\\/]nssm\.exe$' } |
            Select-Object -First 1
        if (-not $source) { Fail 'The vendored NSSM archive has no win64\nssm.exe.' }
        New-Item -ItemType Directory -Path $nssmDirectory -Force | Out-Null
        Copy-Item -LiteralPath $source.FullName -Destination $nssmExe -Force
    } finally {
        if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue }
        if ($temporaryArchive) { Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue }
    }
}
Ok "NSSM        : $nssmExe"

New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null

# 5. Register. Same settings the packaged installer applies, so the service behaves
#    identically and Test-SpoolerServiceOwnership.ps1 can still read it.
$existing = Get-SpoolerService
if ($existing) {
    Say 'Service     : already exists, reconfiguring in place'
    if ($existing.Status -ne 'Stopped') { Stop-Service -Name $ServiceName -Force }
} else {
    Invoke-Native $nssmExe @('install', $ServiceName, $nodeExe) | Out-Null
}

Invoke-Native $nssmExe @('set', $ServiceName, 'Application', $nodeExe) | Out-Null
Invoke-Native $nssmExe @('set', $ServiceName, 'AppDirectory', $root) | Out-Null
Invoke-Native $nssmExe @('set', $ServiceName, 'AppParameters', ('"""' + $serverScript + '"""')) | Out-Null
Invoke-Native $nssmExe @('set', $ServiceName, 'AppEnvironmentExtra',
    'NODE_ENV=production', "SPOOLER_ENV_FILE=$envFile", "SPOOLER_STATE_DIR=$StateDirectory", "SPOOLER_LOG_DIR=$LogDirectory") | Out-Null
Invoke-Native $nssmExe @('set', $ServiceName, 'AppStdout', (Join-Path $LogDirectory 'spooler-service.out.log')) | Out-Null
Invoke-Native $nssmExe @('set', $ServiceName, 'AppStderr', (Join-Path $LogDirectory 'spooler-service.err.log')) | Out-Null
Invoke-Native $nssmExe @('set', $ServiceName, 'AppRotateFiles', '1') | Out-Null
Invoke-Native $nssmExe @('set', $ServiceName, 'AppRotateOnline', '1') | Out-Null
Invoke-Native $nssmExe @('set', $ServiceName, 'AppRotateSeconds', '86400') | Out-Null
Invoke-Native $nssmExe @('set', $ServiceName, 'AppRotateBytes', '1048576') | Out-Null
# Restart on any unexpected exit, but back off so a bad .env cannot spin the CPU.
Invoke-Native $nssmExe @('set', $ServiceName, 'AppExit', 'Default', 'Restart') | Out-Null
Invoke-Native $nssmExe @('set', $ServiceName, 'AppRestartDelay', '5000') | Out-Null
Invoke-Native $nssmExe @('set', $ServiceName, 'AppThrottle', '10000') | Out-Null
Invoke-Native $nssmExe @('set', $ServiceName, 'Description', 'POS print spooler and V2 print agent.') | Out-Null
# Delayed auto-start: the network stack and any local POS server should be up first.
Invoke-Native $nssmExe @('set', $ServiceName, 'Start', 'SERVICE_DELAYED_AUTO_START') | Out-Null

# Prove the registry actually holds what we asked for rather than trusting nssm's exit code.
$parametersKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters"
$stored = Get-ItemProperty -LiteralPath $parametersKey -ErrorAction Stop
if ([string]$stored.Application -ne $nodeExe) { Fail "NSSM stored the wrong application path: $($stored.Application)" }
if ([string]$stored.AppDirectory -ne $root) { Fail "NSSM stored the wrong working directory: $($stored.AppDirectory)" }
if ([string]$stored.AppParameters -ne ('"' + $serverScript + '"')) { Fail "NSSM stored the wrong entry point: $($stored.AppParameters)" }
$startMode = (Get-CimInstance Win32_Service -Filter "Name='$ServiceName'").StartMode
if ($startMode -ne 'Auto') { Fail "Service startup mode is '$startMode', expected Auto." }
Ok "Service     : registered, starts automatically on boot (delayed)"

# Start-Service throws when the app exits inside NSSM's throttle window, and with
# ErrorActionPreference=Stop that aborted the script before it could show why -
# which is the one moment the logs matter. Catch it and report instead.
$startFailure = $null
try { Start-Service -Name $ServiceName -ErrorAction Stop }
catch { $startFailure = $_.Exception.Message }
Start-Sleep -Seconds 3

$service = Get-SpoolerService
if ($startFailure -or $service.Status -ne 'Running') {
    Write-Host ''
    Say "The service did not stay up (state: $($service.Status))."
    if ($startFailure) { Say $startFailure }

    foreach ($name in @('spooler-service.err.log', 'spooler-service.out.log')) {
        $logFile = Join-Path $LogDirectory $name
        if (-not (Test-Path -LiteralPath $logFile)) { continue }
        $tail = Get-Content -LiteralPath $logFile -Tail 20 -ErrorAction SilentlyContinue
        if (-not $tail) { continue }
        Write-Host ''
        Say "$name :"
        $tail | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    }

    Write-Host ''
    Say 'Run it in the foreground to see the failure directly:'
    Write-Host "    cd `"$root`"" -ForegroundColor White
    Write-Host "    `$env:NODE_ENV='production'; `$env:SPOOLER_ENV_FILE='$envFile'; `$env:SPOOLER_STATE_DIR='$StateDirectory'" -ForegroundColor White
    Write-Host "    `"$nodeExe`" server.js" -ForegroundColor White
    Write-Host ''
    Say 'Common causes: CLOUD_SERVER_URL unreachable from this machine, a wrong'
    Say 'SPOOLER_KEY, or a stale lock in the state directory from an earlier run.'
    Fail 'Service registered but would not start. It is still installed; fix the cause and run start.cmd.'
}

Write-Host ''
Ok 'Running. It will come back automatically after a reboot.'
Say "State : $StateDirectory"
Say "Logs  : $LogDirectory"
Write-Host ''
