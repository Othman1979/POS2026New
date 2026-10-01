<#
    Lightweight bootstrap for the updater-managed POS Print Spooler.

    The extracted folder is input only. Install hydrates a fresh protected payload,
    then delegates service/config/registration ownership to the same
    Install-Spooler.ps1 used by POSAPP-Spooler-Setup.exe.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('install', 'start', 'stop', 'restart', 'refresh', 'rebind', 'status', 'uninstall')]
    [string]$Action,
    [string]$ProgramFilesRoot = 'C:\Program Files\POS-Spooler',
    [string]$ProgramDataRoot = 'C:\ProgramData\POS-Spooler'
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'POS Print Spooler'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $scriptDir)).Path.TrimEnd('\')

function Say([string]$Message) { Write-Host "  $Message" }
function Ok([string]$Message) { Write-Host "  $Message" -ForegroundColor Green }
function Stop-WithError([string]$Message) { throw $Message }

function Invoke-Native([string]$File, [string[]]$Arguments) {
    # A native process writing to stderr is not a PowerShell error, but with
    # ErrorActionPreference=Stop the 2>&1 redirect turns every stderr line into a
    # terminating one. An `npm warn deprecated ...` line is written to
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

function Normalize-Path([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    try { return ([IO.Path]::GetFullPath($Path)).TrimEnd('\') }
    catch { return $null }
}

function Test-SamePath([string]$Left, [string]$Right) {
    $leftPath = Normalize-Path $Left
    $rightPath = Normalize-Path $Right
    return $null -ne $leftPath -and $null -ne $rightPath -and $leftPath.Equals($rightPath, [StringComparison]::OrdinalIgnoreCase)
}

function Get-RegisteredExecutablePath([string]$ImagePath) {
    if ([string]::IsNullOrWhiteSpace($ImagePath)) { return $null }
    $value = $ImagePath.Trim()
    if ($value.StartsWith('"')) {
        $closing = $value.IndexOf('"', 1)
        if ($closing -lt 1) { return $null }
        return $value.Substring(1, $closing - 1)
    }
    if ($value -match '^(?<path>.*?\.exe)(?:\s+.*)?$') { return $Matches.path.Trim() }
    return ($value -split '\s+', 2)[0]
}

function Get-ServiceOwnership {
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $service) { return 'absent' }
    $serviceKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
    $image = [string](Get-ItemProperty -LiteralPath $serviceKey -Name ImagePath -ErrorAction Stop).ImagePath
    $registeredExecutable = Get-RegisteredExecutablePath $image
    $sourceNssm = Join-Path $sourceRoot 'runtime\nssm\nssm.exe'
    $managedNssm = Join-Path $ProgramFilesRoot 'runtime\nssm\nssm.exe'
    $parameters = Get-ItemProperty -LiteralPath "$serviceKey\Parameters" -ErrorAction SilentlyContinue

    if (Test-SamePath $registeredExecutable $managedNssm) {
        if ($parameters -and (Test-SamePath ([string]$parameters.AppDirectory) $ProgramFilesRoot)) { return 'managed' }
        return 'unknown'
    }
    if (Test-SamePath $registeredExecutable $sourceNssm) {
        $sourceServer = Join-Path $sourceRoot 'server.js'
        $storedScript = ([string]$parameters.AppParameters).Trim().Trim('"')
        if ($parameters -and (Test-SamePath ([string]$parameters.AppDirectory) $sourceRoot) -and (Test-SamePath $storedScript $sourceServer)) { return 'source' }
    }
    return 'unknown'
}

function Wait-ServiceRemoved {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'The POS Print Spooler service was not removed within 30 seconds.'
}

function Show-Status {
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $service) { Say 'Service is not installed.'; return }
    $wmi = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
    Say "State       : $($service.Status)"
    Say "Startup     : $($wmi.StartMode)"
    Say "Ownership   : $(Get-ServiceOwnership)"
    Say "Runs        : $($wmi.PathName)"
    $errorLog = Join-Path $ProgramDataRoot 'logs\spooler-service.err.log'
    if (Test-Path -LiteralPath $errorLog -PathType Leaf) {
        $tail = Get-Content -LiteralPath $errorLog -Tail 5 -ErrorAction SilentlyContinue
        if ($tail) { Write-Host ''; Say 'Last 5 error-log lines:'; $tail | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }
    }
}

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$($MyInvocation.MyCommand.Path)`"",
        '-Action', $Action,
        '-ProgramFilesRoot', "`"$ProgramFilesRoot`"", '-ProgramDataRoot', "`"$ProgramDataRoot`""
    )
    Write-Host 'Requesting administrator rights...' -ForegroundColor Yellow
    $elevated = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs -Wait -PassThru
    exit $elevated.ExitCode
}

Write-Host ''
Write-Host "POS Print Spooler - $Action" -ForegroundColor Cyan
Write-Host ''

try {
    $ownership = Get-ServiceOwnership
    switch ($Action) {
        'status' { Show-Status; exit 0 }
        'start' {
            if ($ownership -notin @('managed', 'source')) { Stop-WithError 'No recognized POS Print Spooler service is installed.' }
            Start-Service -Name $ServiceName
            Ok 'Started.'
            exit 0
        }
        'stop' {
            if ($ownership -notin @('managed', 'source')) { Stop-WithError 'No recognized POS Print Spooler service is installed.' }
            Stop-Service -Name $ServiceName -Force
            Ok 'Stopped.'
            exit 0
        }
        'restart' {
            if ($ownership -notin @('managed', 'source')) { Stop-WithError 'No recognized POS Print Spooler service is installed.' }
            Restart-Service -Name $ServiceName -Force
            Ok 'Restarted.'
            exit 0
        }
        { $_ -in @('refresh', 'rebind') } {
            if ($ownership -ne 'managed') { Stop-WithError 'A recognized updater-managed POS Print Spooler is required.' }
            $maintenance = Join-Path $ProgramFilesRoot 'maintenance\Refresh-Agent.ps1'
            if (-not (Test-Path -LiteralPath $maintenance -PathType Leaf)) {
                $maintenance = Join-Path $sourceRoot 'maintenance\Refresh-Agent.ps1'
            }
            if (-not (Test-Path -LiteralPath $maintenance -PathType Leaf)) { Stop-WithError 'Spooler maintenance support is missing; install or update the current spooler package.' }
            $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $maintenance, '-ProgramFilesRoot', $ProgramFilesRoot, '-ProgramDataRoot', $ProgramDataRoot)
            if ($Action -eq 'rebind') { $arguments += '-ResetIdentity' }
            & powershell.exe @arguments
            if ($LASTEXITCODE -ne 0) { throw "Spooler $Action failed. Review the message above and the installed spooler logs." }
            Ok 'Fresh authenticated sync verified.'
            exit 0
        }
        'uninstall' {
            if ($ownership -eq 'absent') { Say 'Service is not installed; nothing to remove.'; exit 0 }
            if ($ownership -eq 'unknown') { Stop-WithError 'Refusing to remove an unrecognized Windows service.' }
            if ($ownership -eq 'managed') {
                $remover = Join-Path $ProgramFilesRoot 'deployment\windows\Remove-SpoolerRuntime.ps1'
                if (-not (Test-Path -LiteralPath $remover -PathType Leaf)) { throw 'The managed spooler removal script is missing.' }
                & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $remover -ProgramFilesRoot $ProgramFilesRoot
                if ($LASTEXITCODE -ne 0) { throw 'Managed spooler removal failed.' }
            } else {
                $service = Get-Service -Name $ServiceName
                if ($service.Status -ne 'Stopped') { Stop-Service -Name $ServiceName -Force; $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) }
                & sc.exe delete "$ServiceName" | Out-Null
                if ($LASTEXITCODE -ne 0) { throw 'Windows refused to remove the POS Print Spooler service.' }
            }
            Wait-ServiceRemoved
            Ok 'Service removed; config and state were preserved'
            exit 0
        }
    }

    if ($ownership -eq 'managed') { Stop-WithError 'This spooler is already updater-managed. Use POSAPP-Spooler-Update.exe.' }
    if ($ownership -ne 'absent') {
        Stop-WithError "The existing POS Print Spooler is not updater-managed.`n  Run uninstall.cmd from the folder that currently owns it, then run install.cmd again.`n  Config, state, and logs are preserved."
    }
    if (-not [Environment]::Is64BitOperatingSystem) { Stop-WithError 'The POS Print Spooler requires 64-bit Windows.' }
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $build = [int]$os.BuildNumber
    if ($build -lt 17763) { Stop-WithError "Windows build $build is unsupported. Build 17763 or newer is required." }

    $sourceEnv = Join-Path $sourceRoot '.env'
    if (-not (Test-Path -LiteralPath $sourceEnv -PathType Leaf)) {
        $example = Join-Path $sourceRoot '.env.example'
        if (Test-Path -LiteralPath $example -PathType Leaf) { Copy-Item -LiteralPath $example -Destination $sourceEnv -Force }
        Stop-WithError "No .env was found. A template was created at $sourceEnv. Set the server URL, key, station ID, and station name, then run install.cmd again."
    }
    $config = @{}
    $rawEnv = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($sourceEnv)).TrimStart([char]0xFEFF)
    foreach ($line in ($rawEnv -split "`r?`n")) {
        if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$') { $config[$Matches[1]] = $Matches[2] }
    }
    foreach ($required in @('CLOUD_SERVER_URL', 'SPOOLER_KEY', 'SPOOLER_ID', 'SPOOLER_NAME')) {
        if ([string]::IsNullOrWhiteSpace([string]$config[$required])) { Stop-WithError "$required is missing or empty in $sourceEnv." }
    }
    if ([string]$config.SPOOLER_KEY -eq 'replace-with-the-pos-spooler-key') { Stop-WithError 'SPOOLER_KEY is still the placeholder value.' }
    if ([string]$config.SPOOLER_ID -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$') { Stop-WithError 'SPOOLER_ID is invalid.' }
    if (([string]$config.SPOOLER_NAME).Length -gt 120) { Stop-WithError 'SPOOLER_NAME must be 120 characters or fewer.' }
    $serverUri = $null
    $serverValue = [string]$config.CLOUD_SERVER_URL
    if ([string]::IsNullOrWhiteSpace($serverValue) -or $serverValue -ne $serverValue.Trim() -or
        -not [Uri]::TryCreate($serverValue, [UriKind]::Absolute, [ref]$serverUri) -or
        $serverUri.Scheme -notin @('http', 'https') -or [string]::IsNullOrWhiteSpace($serverUri.Host) -or
        ($serverUri.Scheme -eq 'http' -and -not $serverUri.IsLoopback) -or
        -not [string]::IsNullOrEmpty($serverUri.UserInfo) -or -not [string]::IsNullOrEmpty($serverUri.Query) -or
        -not [string]::IsNullOrEmpty($serverUri.Fragment) -or $serverUri.AbsolutePath -notin @('', '/') -or
        $serverUri.Port -eq 0 -or $serverUri.Port -gt 65535) { Stop-WithError 'CLOUD_SERVER_URL is invalid.' }
    $serverOrigin = $serverUri.GetLeftPart([UriPartial]::Authority).TrimEnd('/')
    $health = Invoke-RestMethod -Uri "$serverOrigin/health" -TimeoutSec 10
    if ($health.status -ne 'ok' -or [string]::IsNullOrWhiteSpace([string]$health.release.version)) { Stop-WithError 'The configured POS server is not healthy.' }

    $payloadRootsFile = Join-Path $scriptDir 'payload-roots.json'
    $vendorLockFile = Join-Path $sourceRoot 'deployment\vendor-lock.json'
    if (-not (Test-Path -LiteralPath $payloadRootsFile -PathType Leaf)) { Stop-WithError 'The bundle is missing spooler-service\payload-roots.json.' }
    if (-not (Test-Path -LiteralPath $vendorLockFile -PathType Leaf)) { Stop-WithError 'The bundle is missing deployment\vendor-lock.json.' }
    $payloadRoots = @(Get-Content -LiteralPath $payloadRootsFile -Raw | ConvertFrom-Json)
    $vendorLock = Get-Content -LiteralPath $vendorLockFile -Raw | ConvertFrom-Json
    function Get-VendorPackage([string]$Name) {
        $package = @($vendorLock.packages | Where-Object { $_.name -eq $Name })
        if ($package.Count -ne 1) { throw "Vendor lock must contain exactly one $Name package." }
        return $package[0]
    }
    function Get-VerifiedArchive([object]$Package, [string]$Destination) {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $previous = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        try { Invoke-WebRequest -Uri ([string]$Package.source) -OutFile $Destination -UseBasicParsing }
        finally { $ProgressPreference = $previous }
        $actual = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne ([string]$Package.sha256).ToLowerInvariant()) {
            Remove-Item -LiteralPath $Destination -Force
            throw "Checksum mismatch for $($Package.name)."
        }
    }

    $nodePackage = Get-VendorPackage 'node'
    $nssmPackage = Get-VendorPackage 'nssm'
    $typstPackage = Get-VendorPackage 'typst'
    $typstFontPackages = @(
        @{ Package = Get-VendorPackage 'noto-sans'; Target = 'NotoSans.ttf' },
        @{ Package = Get-VendorPackage 'noto-sans-arabic'; Target = 'NotoSansArabic.ttf' },
        @{ Package = Get-VendorPackage 'noto-emoji'; Target = 'NotoEmoji.ttf' },
        @{ Package = Get-VendorPackage 'noto-ofl'; Target = 'OFL.txt' }
    )
    $temporaryRoot = Join-Path $ProgramDataRoot 'tmp'
    $stagingRoot = Join-Path $temporaryRoot "bootstrap-$PID"
    $responseFile = Join-Path $temporaryRoot "bootstrap-response-$PID.json"
    $installVerified = $false
    $installFailure = $null
    try {
        New-Item -ItemType Directory -Force -Path $ProgramDataRoot, $temporaryRoot, $stagingRoot | Out-Null
        Invoke-Native 'icacls.exe' @($ProgramDataRoot, '/reset', '/T', '/C') | Out-Null
        Invoke-Native 'icacls.exe' @($ProgramDataRoot, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)(F)', '*S-1-5-32-544:(OI)(CI)(F)', '/T', '/C') | Out-Null
        Invoke-Native 'icacls.exe' @($stagingRoot, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)(F)', '*S-1-5-32-544:(OI)(CI)(F)') | Out-Null

        foreach ($relative in $payloadRoots) {
            $source = Join-Path $sourceRoot ([string]$relative)
            if (-not (Test-Path -LiteralPath $source)) { throw "The bundle is missing application root: $relative" }
            $destination = Join-Path $stagingRoot ([string]$relative)
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
            Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
        }
        Copy-Item -LiteralPath (Join-Path $sourceRoot 'deployment') -Destination (Join-Path $stagingRoot 'deployment') -Recurse -Force

        $downloadRoot = Join-Path $stagingRoot '.bootstrap-downloads'
        New-Item -ItemType Directory -Force -Path $downloadRoot | Out-Null
        $nodeArchive = Join-Path $downloadRoot ([string]$nodePackage.file)
        Get-VerifiedArchive $nodePackage $nodeArchive
        $nodeExtract = Join-Path $downloadRoot 'node'
        Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract -Force
        $nodeSource = Get-ChildItem -LiteralPath $nodeExtract -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'node.exe') } | Select-Object -First 1
        if (-not $nodeSource) { throw 'The Node archive did not contain node.exe.' }
        New-Item -ItemType Directory -Force -Path (Join-Path $stagingRoot 'runtime') | Out-Null
        Move-Item -LiteralPath $nodeSource.FullName -Destination (Join-Path $stagingRoot 'runtime\node')
        $nodeExe = Join-Path $stagingRoot 'runtime\node\node.exe'
        $npmCmd = Join-Path $stagingRoot 'runtime\node\npm.cmd'
        $env:PATH = "$(Split-Path -Parent $nodeExe);$env:PATH"

        $vendorRoot = Join-Path $stagingRoot 'install\vendor'
        New-Item -ItemType Directory -Force -Path $vendorRoot | Out-Null
        Get-VerifiedArchive $nssmPackage (Join-Path $vendorRoot 'nssm-2.24.zip')

        $typstArchive = Join-Path $downloadRoot ([string]$typstPackage.file)
        Get-VerifiedArchive $typstPackage $typstArchive
        $typstExtract = Join-Path $downloadRoot 'typst'
        Expand-Archive -LiteralPath $typstArchive -DestinationPath $typstExtract -Force
        $typstSource = Get-ChildItem -LiteralPath $typstExtract -Recurse -File -Filter 'typst.exe' | Select-Object -First 1
        if (-not $typstSource) { throw 'The Typst archive did not contain typst.exe.' }
        $typstSourceRoot = Split-Path -Parent $typstSource.FullName
        $typstRuntime = Join-Path $stagingRoot '.cache\typst\0.15.1'
        $typstFonts = Join-Path $typstRuntime 'fonts'
        New-Item -ItemType Directory -Force -Path $typstFonts | Out-Null
        foreach ($name in @('typst.exe', 'LICENSE', 'NOTICE')) {
            $source = Join-Path $typstSourceRoot $name
            if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Typst runtime is missing $name." }
            Copy-Item -LiteralPath $source -Destination $typstRuntime -Force
        }
        $typstPatchTool = Join-Path $sourceRoot 'deployment\tools\patch-typst-fast-watch.js'
        $typstPatchNotice = Join-Path $sourceRoot 'deployment\patches\typst-0.15.1-fast-watch.txt'
        if (-not (Test-Path -LiteralPath $typstPatchTool -PathType Leaf) -or -not (Test-Path -LiteralPath $typstPatchNotice -PathType Leaf)) {
            throw 'The bundle is missing the verified Typst fast-watch patch.'
        }
        Invoke-Native $nodeExe @($typstPatchTool, (Join-Path $typstRuntime 'typst.exe')) | Out-Null
        Copy-Item -LiteralPath $typstPatchNotice -Destination (Join-Path $typstRuntime 'POSAPP-PATCH.txt') -Force
        foreach ($font in $typstFontPackages) {
            $download = Join-Path $downloadRoot ([string]$font.Package.file)
            Get-VerifiedArchive $font.Package $download
            Copy-Item -LiteralPath $download -Destination (Join-Path $typstFonts $font.Target) -Force
        }
        $typstVersion = (& (Join-Path $typstRuntime 'typst.exe') --version | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $typstVersion -notmatch '^typst 0\.15\.1\b') { throw "Unexpected Typst runtime: $typstVersion" }
        Remove-Item -LiteralPath $downloadRoot -Recurse -Force

        Push-Location $stagingRoot
        try {
            Invoke-Native $npmCmd @('ci', '--omit=dev', '--no-audit', '--no-fund') | Out-Null
        } finally { Pop-Location }

        $requestLink = Join-Path $stagingRoot 'node_modules/request'
        if (Test-Path -LiteralPath $requestLink) {
            $requestItem = Get-Item -LiteralPath $requestLink -Force
            if (($requestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                if ($requestItem.PSIsContainer) { [IO.Directory]::Delete($requestItem.FullName, $false) }
                else { [IO.File]::Delete($requestItem.FullName) }
            } else { Remove-Item -LiteralPath $requestLink -Recurse -Force }
            Copy-Item -LiteralPath (Join-Path $stagingRoot 'vendor/request-disabled') -Destination $requestLink -Recurse -Force
        }

        $payloadValidator = Join-Path $stagingRoot 'deployment\tools\validate-payload.js'
        Invoke-Native $nodeExe @($payloadValidator, $stagingRoot, 'spooler', $stagingRoot, '--stamp-spooler') | Out-Null

        $allowedAdditionalEnv = @(
            'KITCHEN_BEEP_ENABLED', 'KITCHEN_BEEP_COUNT', 'KITCHEN_BEEP_DURATION',
            'RECEIPT_BEEP_ENABLED', 'RECEIPT_BEEP_COUNT', 'RECEIPT_BEEP_DURATION',
            'SPOOLER_MAX_LOCAL_JOBS', 'SPOOLER_TYPST_TIMEOUT_MS', 'SPOOLER_TYPST_MAX_HEIGHT'
        )
        $additionalEnv = [ordered]@{}
        foreach ($key in $allowedAdditionalEnv) {
            if ($config.ContainsKey($key)) { $additionalEnv[$key] = [string]$config[$key] }
        }
        $response = [ordered]@{
            ServerUrl = $serverOrigin
            SpoolerKey = [string]$config.SPOOLER_KEY
            SpoolerId = [string]$config.SPOOLER_ID
            SpoolerName = [string]$config.SPOOLER_NAME
            AdditionalEnv = $additionalEnv
        }
        [IO.File]::WriteAllText($responseFile, ($response | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
        Invoke-Native 'icacls.exe' @($responseFile, '/inheritance:r', '/grant:r', '*S-1-5-18:F', '*S-1-5-32-544:F') | Out-Null

        $installer = Join-Path $stagingRoot 'deployment\windows\Install-Spooler.ps1'
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -PayloadRoot $stagingRoot -ConfigFile $responseFile -ProgramFilesRoot $ProgramFilesRoot -ProgramDataRoot $ProgramDataRoot
        if ($LASTEXITCODE -ne 0) { throw "Canonical spooler installation failed with exit code $LASTEXITCODE. Check $ProgramDataRoot\logs\install-error.txt." }
        $installVerified = $true
    } catch {
        $installFailure = $_
    } finally {
        if (Test-Path -LiteralPath $responseFile) { Remove-Item -LiteralPath $responseFile -Force -ErrorAction SilentlyContinue }
        if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }
    if ($installFailure) { throw $installFailure }
    if ($installVerified -and (Test-Path -LiteralPath $sourceEnv -PathType Leaf)) { Remove-Item -LiteralPath $sourceEnv -Force }
    Ok "Installed and verified station $($config.SPOOLER_ID). Future updates can use POSAPP-Spooler-Update.exe."
}
catch {
    Write-Host ''
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ''
    exit 1
}
