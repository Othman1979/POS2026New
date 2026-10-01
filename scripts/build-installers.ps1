[CmdletBinding()]
param(
    [switch]$StageOnly,
    [switch]$SkipDependencyInstall,
    [switch]$SkipVersionBump,
    [string]$Version = '',
    [string]$OutputRoot = ''
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$out = if ($OutputRoot) { [IO.Path]::GetFullPath($OutputRoot) } else { Join-Path $repo 'deployment/out' }
$deploymentRoot = Join-Path $repo 'deployment'
if (-not $out.StartsWith($deploymentRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'OutputRoot must be below deployment.' }
$stage = Join-Path $out 'stage'
$serverStage = Join-Path $stage 'server'
$spoolerStage = Join-Path $stage 'spooler'
$serverUpdateCoreStage = Join-Path $stage 'server-update-core'
$serverUpdateRuntimeStage = Join-Path $stage 'server-update-runtime'
$spoolerUpdateCoreStage = Join-Path $stage 'spooler-update-core'
$spoolerUpdateRuntimeStage = Join-Path $stage 'spooler-update-runtime'
$toolchain = Join-Path $out 'toolchain'
$dependencyReuseRoot = Join-Path $out 'dependency-reuse'
$nodeToolRoot = Join-Path $toolchain 'node'
$nodeExe = Join-Path $nodeToolRoot 'node.exe'
$npmCli = Join-Path $nodeToolRoot 'node_modules/npm/bin/npm-cli.js'
$vendorDir = Join-Path $repo 'deployment/vendor'
$lockPath = Join-Path $repo 'deployment/vendor-lock.json'
$runtimeProfile = 'typst-only'

function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $FilePath $($Arguments -join ' ')" }
}

function Invoke-Npm([string[]]$Arguments) {
    Invoke-Native $nodeExe (@($npmCli) + $Arguments)
}

function Write-Utf8NoBom([string]$Path, [string]$Contents) {
    [IO.File]::WriteAllText($Path, $Contents, [Text.UTF8Encoding]::new($false))
}

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
        finally { $sha256.Dispose() }
    }
    finally { $stream.Dispose() }
}

function Write-UpdateManifest([string]$Root, [string]$Kind, [string]$Version, [string]$Commit, [string[]]$ManagedRoots) {
    $files = @(Get-ChildItem -LiteralPath $Root -Recurse -Force -File | Where-Object { $_.Name -ne 'update-payload-manifest.json' } | ForEach-Object {
        $relative = $_.FullName.Substring($Root.Length).TrimStart([char[]]@('\', '/')).Replace('\', '/')
        [ordered]@{ path = $relative; bytes = [int64]$_.Length; sha256 = Get-Sha256 $_.FullName }
    } | Sort-Object path)
    $manifest = [ordered]@{ format = 1; kind = $Kind; version = $Version; commit = $Commit; managedRoots = $ManagedRoots; files = $files }
    Write-Utf8NoBom (Join-Path $Root 'update-payload-manifest.json') ($manifest | ConvertTo-Json -Depth 6)
}

function Copy-FilteredTree([string]$source, [string]$destination, [string[]]$excludeDirs = @(), [string[]]$excludeFiles = @()) {
    if (-not (Test-Path -LiteralPath $source)) { throw "Missing build input: $source" }
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Get-ChildItem -LiteralPath $source -Force | Where-Object {
        $excluded = $false
        foreach ($pattern in $excludeFiles) { if ($_.Name -like $pattern) { $excluded = $true; break } }
        $excludeDirs -notcontains $_.Name -and -not $excluded
    } | ForEach-Object {
        $target = Join-Path $destination $_.Name
        if ($_.PSIsContainer) { Copy-FilteredTree $_.FullName $target $excludeDirs $excludeFiles }
        else { Copy-Item -LiteralPath $_.FullName -Destination $target -Force }
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
    if ($matches.Count -eq 0) { throw "Archive marker missing under $Directory ($Marker)." }
    if ($matches.Count -gt 1) {
        $matches = @($matches | Sort-Object @{ Expression = {
            $relative = [string]$_
            if ($relative.StartsWith($Directory, [StringComparison]::OrdinalIgnoreCase)) { $relative = $relative.Substring($Directory.Length).TrimStart([char[]]@('\', '/')) }
            (@($relative -split '[\\/]+')).Count
        }}, @{ Expression = { $_ }})
    }
    return $matches[0]
}

function Stage-MariaDbRuntime([string]$ArchivePath, [string]$Destination) {
    $extract = Join-Path $out 'mariadb-runtime-extract'
    if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $extract | Out-Null
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $extract -Force
    $root = Resolve-ArchiveRoot $extract 'bin\mariadbd.exe'
    Copy-FilteredTree $root $Destination @()
    if (-not (Test-Path -LiteralPath (Join-Path $Destination 'bin\mariadb-install-db.exe'))) { throw 'MariaDB runtime is missing mariadb-install-db.exe.' }
    if (-not (Test-Path -LiteralPath (Join-Path $Destination 'bin\mariadb-dump.exe'))) { throw 'MariaDB runtime is missing mariadb-dump.exe.' }
    Remove-Item -LiteralPath $extract -Recurse -Force
}

function Stage-TypstRuntime($Packages, [string]$Destination) {
    $extract = Join-Path $out 'typst-runtime-extract'
    if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $extract, (Join-Path $Destination 'fonts') | Out-Null
    $typstPackage = @($Packages | Where-Object { $_.name -eq 'typst' })[0]
    if (-not $typstPackage) { throw 'Typst is missing from vendor-lock.json.' }
    Expand-Archive -LiteralPath (Join-Path $vendorDir $typstPackage.file) -DestinationPath $extract -Force
    $root = Resolve-ArchiveRoot $extract 'typst.exe'
    foreach ($name in @('typst.exe', 'LICENSE', 'NOTICE')) {
        $source = Join-Path $root $name
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Typst runtime is missing $name." }
        Copy-Item -LiteralPath $source -Destination $Destination -Force
    }
    Invoke-Native $nodeExe @((Join-Path $repo 'deployment\tools\patch-typst-fast-watch.js'), (Join-Path $Destination 'typst.exe'))
    Copy-Item -LiteralPath (Join-Path $repo 'deployment\patches\typst-0.15.1-fast-watch.txt') -Destination (Join-Path $Destination 'POSAPP-PATCH.txt') -Force
    $fontPackages = @(
        @{ Package = 'noto-sans'; Target = 'NotoSans.ttf' },
        @{ Package = 'noto-sans-arabic'; Target = 'NotoSansArabic.ttf' },
        @{ Package = 'noto-emoji'; Target = 'NotoEmoji.ttf' },
        @{ Package = 'noto-ofl'; Target = 'OFL.txt' }
    )
    foreach ($font in $fontPackages) {
        $package = @($Packages | Where-Object { $_.name -eq $font.Package })[0]
        if (-not $package) { throw "Typst font package is missing: $($font.Package)." }
        Copy-Item -LiteralPath (Join-Path $vendorDir $package.file) -Destination (Join-Path $Destination "fonts\$($font.Target)") -Force
    }
    $reportedVersion = (& (Join-Path $Destination 'typst.exe') --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $reportedVersion -notmatch '^typst 0\.15\.1\b') { throw "Unexpected Typst runtime: $reportedVersion" }
    Remove-Item -LiteralPath $extract -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $out | Out-Null
$pendingReleasePath = Join-Path $out 'pending-installer-release.json'
$allReleaseVersionFiles = @(
    'package.json', 'package-lock.json',
    'pos-spooler-printer/package.json', 'pos-spooler-printer/package-lock.json',
    'deployment/server/POSAPP-Server.iss', 'deployment/spooler/POSAPP-Spooler.iss'
)
$releaseVersionFiles = $allReleaseVersionFiles

if (-not $StageOnly -and -not $SkipVersionBump -and [string]::IsNullOrWhiteSpace($Version)) {
    $head = (& git.exe -C $repo rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the current Git commit.' }
    $currentServerVersion = [string](Get-Content -Raw (Join-Path $repo 'package.json') | ConvertFrom-Json).version
    $currentSpoolerVersion = [string](Get-Content -Raw (Join-Path $repo 'pos-spooler-printer/package.json') | ConvertFrom-Json).version
    $resumePendingRelease = $false
    if (Test-Path -LiteralPath $pendingReleasePath -PathType Leaf) {
        try {
            $pendingRelease = Get-Content -Raw -LiteralPath $pendingReleasePath | ConvertFrom-Json
            $resumePendingRelease = [string]$pendingRelease.commit -eq $head -and
                [string]$pendingRelease.serverVersion -eq $currentServerVersion -and
                [string]$pendingRelease.spoolerVersion -eq $currentSpoolerVersion
        } catch { $resumePendingRelease = $false }
        if (-not $resumePendingRelease) { Remove-Item -LiteralPath $pendingReleasePath -Force }
    }

    if ($resumePendingRelease) {
        Write-Output "Resuming pending installer release $currentServerVersion / $currentSpoolerVersion at $head."
    } else {
        if (git.exe -C $repo status --porcelain) { throw 'Release version bump requires a clean worktree.' }
        $beforeBump = $head
        try {
            $versionNode = (Get-Command node.exe -ErrorAction Stop).Source
            $bumpArguments = @((Join-Path $repo 'scripts/bump-installer-versions.js'), '--root', $repo)
            $bumpOutput = & $versionNode @bumpArguments
            if ($LASTEXITCODE -ne 0) { throw 'Installer version bump failed.' }
            $bumped = $bumpOutput | ConvertFrom-Json
            Invoke-Native 'git.exe' (@('-C', $repo, 'add', '--') + $releaseVersionFiles)
            $bumpMessage = "chore(release): bump server to $($bumped.serverVersion) and spooler to $($bumped.spoolerVersion)"
            Invoke-Native 'git.exe' @('-C', $repo, 'commit', '-m', $bumpMessage)
            $head = (& git.exe -C $repo rev-parse HEAD).Trim()
            if ($LASTEXITCODE -ne 0) { throw 'Could not read the release Git commit.' }
            $pendingRelease = [ordered]@{ commit = $head; serverVersion = [string]$bumped.serverVersion; spoolerVersion = [string]$bumped.spoolerVersion }
            Write-Utf8NoBom $pendingReleasePath ($pendingRelease | ConvertTo-Json -Depth 3)
        } catch {
            $currentHead = (& git.exe -C $repo rev-parse HEAD).Trim()
            if ($currentHead -eq $beforeBump) {
                & git.exe -C $repo restore --staged --worktree -- @releaseVersionFiles | Out-Null
            }
            throw
        }
    }
}

if (-not $StageOnly -and (git -C $repo status --porcelain)) { throw 'Release installers must be built from a clean worktree.' }
if (Test-Path -LiteralPath $dependencyReuseRoot) { Remove-Item -LiteralPath $dependencyReuseRoot -Recurse -Force }
if ($SkipDependencyInstall) {
    foreach ($required in @((Join-Path $serverStage 'node_modules'), (Join-Path $spoolerStage 'node_modules'), (Join-Path $spoolerStage '.cache'))) {
        if (-not (Test-Path -LiteralPath $required -PathType Container)) { throw "-SkipDependencyInstall requires existing stage directory: $required" }
    }
    New-Item -ItemType Directory -Force -Path $dependencyReuseRoot | Out-Null
    Move-Item -LiteralPath (Join-Path $serverStage 'node_modules') -Destination (Join-Path $dependencyReuseRoot 'server-node_modules')
    Move-Item -LiteralPath (Join-Path $spoolerStage 'node_modules') -Destination (Join-Path $dependencyReuseRoot 'spooler-node_modules')
    Move-Item -LiteralPath (Join-Path $spoolerStage '.cache') -Destination (Join-Path $dependencyReuseRoot 'spooler-cache')
}
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
if (-not (Test-Path $nodeExe) -or -not (Test-Path (Join-Path $nodeToolRoot 'node_modules/npm/bin/npm-cli.js'))) {
    if (Test-Path $nodeToolRoot) { Remove-Item -Recurse -Force $nodeToolRoot }
    New-Item -ItemType Directory -Force -Path $nodeToolRoot | Out-Null
}
New-Item -ItemType Directory -Force -Path $serverStage, $spoolerStage | Out-Null
if ($SkipDependencyInstall) {
    Move-Item -LiteralPath (Join-Path $dependencyReuseRoot 'server-node_modules') -Destination (Join-Path $serverStage 'node_modules')
    Move-Item -LiteralPath (Join-Path $dependencyReuseRoot 'spooler-node_modules') -Destination (Join-Path $spoolerStage 'node_modules')
    Move-Item -LiteralPath (Join-Path $dependencyReuseRoot 'spooler-cache') -Destination (Join-Path $spoolerStage '.cache')
    Remove-Item -LiteralPath $dependencyReuseRoot -Recurse -Force
}

$lock = Get-Content -Raw $lockPath | ConvertFrom-Json
foreach ($package in $lock.packages) {
    $artifact = Join-Path $vendorDir $package.file
    if (-not (Test-Path -LiteralPath $artifact)) { throw "Missing vendor artifact: $($package.file)" }
    $actual = Get-Sha256 $artifact
    if ($actual -ne $package.sha256) { throw "Vendor checksum mismatch: $($package.file)" }
}

$nodeArchive = Join-Path $vendorDir 'node-v22.23.0-win-x64.zip'
if (-not (Test-Path $nodeExe)) {
    Expand-Archive -LiteralPath $nodeArchive -DestinationPath $toolchain -Force
    $expanded = Join-Path $toolchain 'node-v22.23.0-win-x64'
    if (-not (Test-Path (Join-Path $expanded 'node.exe'))) { throw 'Node 22 archive did not contain node.exe.' }
    Copy-FilteredTree $expanded $nodeToolRoot @()
}
if ((& $nodeExe --version).Trim() -ne 'v22.23.0') { throw 'Build/runtime Node must be exactly v22.23.0.' }

Push-Location $repo
try { Invoke-Npm @('run', 'build') }
finally { Pop-Location }

Copy-Item (Join-Path $repo 'server.js') $serverStage -Force
Copy-Item (Join-Path $repo 'package.json') $serverStage -Force
Copy-Item (Join-Path $repo 'package-lock.json') $serverStage -Force
Copy-FilteredTree (Join-Path $repo 'backend') (Join-Path $serverStage 'backend') @('tests', 'fixtures', 'migrations') @('*.test.js')
$migrationSource = Join-Path $repo 'backend\migrations'
$migrationStage = Join-Path $serverStage 'backend\migrations'
New-Item -ItemType Directory -Force -Path $migrationStage | Out-Null
$migrationRuntimeFiles = @('backend\migrations\runPendingMigrations.js', 'backend\migrations\auto-manifest.json')
foreach ($relative in $migrationRuntimeFiles) {
    Copy-Item (Join-Path $repo $relative) $migrationStage -Force
}
$autoManifest = Get-Content -Raw (Join-Path $migrationSource 'auto-manifest.json') | ConvertFrom-Json
foreach ($migration in @($autoManifest.migrations)) {
    $migrationFile = [string]$migration.file
    if ([IO.Path]::GetFileName($migrationFile) -ne $migrationFile -or -not $migrationFile.EndsWith('.auto.sql', [StringComparison]::Ordinal)) {
        throw "Invalid automatic migration file name: $migrationFile"
    }
    Copy-Item (Join-Path $migrationSource $migrationFile) $migrationStage -Force
    if ($null -ne $migration.preflight) {
        $preflightFile = [string]$migration.preflight
        if ([IO.Path]::GetFileName($preflightFile) -ne $preflightFile -or -not $preflightFile.EndsWith('.sql', [StringComparison]::Ordinal)) {
            throw "Invalid migration preflight file name: $preflightFile"
        }
        Copy-Item (Join-Path $migrationSource $preflightFile) $migrationStage -Force
    }
}
Copy-Item (Join-Path $repo 'dist') (Join-Path $serverStage 'dist') -Recurse -Force
Copy-Item (Join-Path $repo 'assets') (Join-Path $serverStage 'assets') -Recurse -Force
New-Item -ItemType Directory -Force -Path (Join-Path $serverStage 'scripts') | Out-Null
Copy-Item (Join-Path $repo 'scripts/db-backup.js') (Join-Path $serverStage 'scripts') -Force
Copy-Item (Join-Path $repo 'deployment/database') (Join-Path $serverStage 'deployment/database') -Recurse -Force
New-Item -ItemType Directory -Force -Path (Join-Path $serverStage 'deployment/tools') | Out-Null
Copy-Item (Join-Path $repo 'deployment/tools/bootstrap-database.js'), (Join-Path $repo 'deployment/tools/installer-config.js'), (Join-Path $repo 'deployment/tools/run-pending-migrations.js'), (Join-Path $repo 'deployment/tools/verify-install.js'), (Join-Path $repo 'deployment/tools/validate-payload.js') (Join-Path $serverStage 'deployment/tools') -Force
Copy-Item (Join-Path $repo 'deployment/templates') (Join-Path $serverStage 'deployment/templates') -Recurse -Force
New-Item -ItemType Directory -Force -Path (Join-Path $serverStage 'runtime/node'), (Join-Path $serverStage 'install/vendor') | Out-Null
Copy-Item $nodeExe (Join-Path $serverStage 'runtime/node/node.exe') -Force
$serverVendorPackageNames = @('apache', 'php', 'phpmyadmin', 'nssm', 'vc-redist')
foreach ($package in @($lock.packages | Where-Object { $serverVendorPackageNames -contains $_.name })) {
    Copy-Item (Join-Path $vendorDir $package.file) (Join-Path $serverStage 'install/vendor') -Force
}
$mariaPackage = @($lock.packages | Where-Object { $_.name -eq 'mariadb' })[0]
Stage-MariaDbRuntime (Join-Path $vendorDir $mariaPackage.file) (Join-Path $serverStage 'install/mariadb-runtime')

$spoolerExcludedFiles = @('.env', '.env.*', '*.log', '*.pem', '*.key', '*.crt', '*.zip', 'README.md', 'install.bat', 'uninstall.bat', 'install-service.js', 'uninstall-service.js')
Copy-FilteredTree (Join-Path $repo 'pos-spooler-printer') $spoolerStage @('tests', 'node_modules', 'logs', '.git', '.cache') $spoolerExcludedFiles
Copy-Item (Join-Path $repo 'pos-spooler-printer/package-lock.json') $spoolerStage -Force
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$helperSource = Join-Path $spoolerStage 'windows-helper\PosSpoolerPlatform.cs'
$helperBin = Join-Path $spoolerStage 'bin'
$helperExe = Join-Path $helperBin 'PosSpoolerPlatform.exe'
if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) { throw 'Windows-inbox .NET Framework compiler was not found.' }
New-Item -ItemType Directory -Force -Path $helperBin | Out-Null
& $csc /nologo /optimize+ /target:exe "/out:$helperExe" /r:System.Web.Extensions.dll /r:System.Security.dll $helperSource
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $helperExe -PathType Leaf)) { throw 'Winspool platform helper compilation failed.' }
New-Item -ItemType Directory -Force -Path (Join-Path $spoolerStage 'runtime/node') | Out-Null
Copy-Item $nodeExe (Join-Path $spoolerStage 'runtime/node/node.exe') -Force
$spoolerVendorPackageNames = @('nssm')
New-Item -ItemType Directory -Force -Path (Join-Path $spoolerStage 'install/vendor') | Out-Null
foreach ($package in @($lock.packages | Where-Object { $spoolerVendorPackageNames -contains $_.name })) {
    Copy-Item (Join-Path $vendorDir $package.file) (Join-Path $spoolerStage 'install/vendor') -Force
}

function Install-ProductionDependencies([string]$directory, [switch]$RunScripts) {
    if ($SkipDependencyInstall) {
        if (-not (Test-Path (Join-Path $directory 'node_modules'))) { throw "-SkipDependencyInstall requires node_modules in $directory" }
        return
    }
    Push-Location $directory
    try {
        $args = @('ci', '--omit=dev')
        if (-not $RunScripts) { $args += '--ignore-scripts' }
        Invoke-Npm $args
    }
    finally { Pop-Location }
}
Install-ProductionDependencies $serverStage
Install-ProductionDependencies $spoolerStage -RunScripts

function Remove-ForbiddenPayloadFiles([string]$directory, [switch]$PreserveVendorArchives) {
    Get-ChildItem -LiteralPath $directory -Recurse -Force -File | Where-Object {
        $isVendorArchive = $PreserveVendorArchives -and $_.FullName.StartsWith((Join-Path $directory 'install\vendor'), [StringComparison]::OrdinalIgnoreCase)
        $_.Name -like '*.map' -or $_.Name -like '*.7z' -or ((-not $isVendorArchive) -and $_.Name -like '*.zip') -or $_.Name -eq '.env' -or $_.Name -eq '.env.test' -or $_.Name -like '*.log'
    } | Remove-Item -Force
    Get-ChildItem -LiteralPath $directory -Recurse -Force -Directory | Where-Object {
        $_.Name -in @('.git', 'tests', 'test', 'playwright-report', 'test-results')
    } | Sort-Object FullName -Descending | Remove-Item -Recurse -Force
}
Remove-ForbiddenPayloadFiles $serverStage -PreserveVendorArchives
Remove-ForbiddenPayloadFiles $spoolerStage -PreserveVendorArchives

# npm's file dependency may materialize node_modules/request as a junction. The
# deployable spooler must contain regular files only; replace it with the
# checked-in disabled implementation before any layer inventory is calculated.
$spoolerRequestLink = Join-Path $spoolerStage 'node_modules/request'
$spoolerRequestSource = Join-Path $spoolerStage 'vendor/request-disabled'
if (Test-Path -LiteralPath $spoolerRequestLink) {
    $requestItem = Get-Item -LiteralPath $spoolerRequestLink -Force
    if (($requestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        if ($requestItem.PSIsContainer) { [IO.Directory]::Delete($requestItem.FullName, $false) }
        else { [IO.File]::Delete($requestItem.FullName) }
    }
    else { Remove-Item -LiteralPath $spoolerRequestLink -Recurse -Force }
    Copy-Item -LiteralPath $spoolerRequestSource -Destination $spoolerRequestLink -Recurse -Force
}

Push-Location $spoolerStage
try {
    foreach ($forbidden in @('node_modules/puppeteer', 'node_modules/puppeteer-core', 'node_modules/@puppeteer', 'node_modules/chromium-bidi', '.cache/puppeteer', '.puppeteerrc.cjs')) {
        if (Test-Path -LiteralPath (Join-Path $spoolerStage $forbidden)) { throw "Typst-only runtime contains forbidden Chromium content: $forbidden" }
    }
    Invoke-Native $nodeExe @('-e', "require('./node_modules/dotenv'); console.log('dependencies ok'); process.exit(0)")
} finally { Pop-Location }
Stage-TypstRuntime $lock.packages (Join-Path $spoolerStage '.cache\typst\0.15.1')

$releaseVersion = if ($Version) { $Version } else { (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version }
$commit = (git -C $repo rev-parse HEAD).Trim()
$schema = (Get-Content (Join-Path $repo 'deployment/database/manifest.json') -Raw | ConvertFrom-Json)
$spoolerVersion = ((Get-Content (Join-Path $repo 'pos-spooler-printer/package.json') -Raw | ConvertFrom-Json).version)
$release = [ordered]@{ version = $releaseVersion; commit = $commit; schemaVersion = $schema.baseline.id; spoolerVersion = $spoolerVersion; runtimeProfile = $runtimeProfile }
$releaseJson = $release | ConvertTo-Json -Depth 5
Write-Utf8NoBom (Join-Path $serverStage 'release.json') $releaseJson
Write-Utf8NoBom (Join-Path $spoolerStage 'release.json') $releaseJson

# Fresh servers carry a dependency inventory and attestation. Existing packaged
# installs can be adopted by the core updater only after the same inventory is
# verified byte-for-byte against their installed node_modules tree.
$serverDependencyTool = Join-Path $repo 'deployment/tools/server-dependency-manifest.js'
$serverDependencyManifestPath = Join-Path $serverStage 'server-dependency-manifest.json'
Invoke-Native $nodeExe @($serverDependencyTool, $serverStage, $serverDependencyManifestPath)
$serverDependencyManifest = Get-Content -Raw -LiteralPath $serverDependencyManifestPath | ConvertFrom-Json
$serverRuntimeAttestation = [ordered]@{
    format = 1; appId = '{E99DB275-DDA0-43A0-95CD-7AE07185122C}'
    nodeVersion = [string]$serverDependencyManifest.nodeVersion; platform = 'win32'; arch = 'x64'
    dependenciesId = [string]$serverDependencyManifest.dependencies.id
}
Write-Utf8NoBom (Join-Path $serverStage 'server-installed-runtime.json') ($serverRuntimeAttestation | ConvertTo-Json -Depth 5)

# Update stages deliberately copy only application code and migration tooling. They never
# contain fresh-only runtimes, service installers, database bootstrap assets, or secrets.
foreach ($updateRoot in @($serverUpdateCoreStage, $serverUpdateRuntimeStage, $spoolerUpdateCoreStage, $spoolerUpdateRuntimeStage)) {
    if (Test-Path -LiteralPath $updateRoot) { Remove-Item -LiteralPath $updateRoot -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $updateRoot | Out-Null
}
$serverApplicationRoots = @('server.js', 'package.json', 'package-lock.json', 'release.json', 'dist', 'assets', 'backend', 'scripts', 'deployment', 'server-dependency-manifest.json')
$serverRuntimeRoots = @($serverApplicationRoots + 'node_modules')
foreach ($target in @(
    @{ Root = $serverUpdateCoreStage; Roots = $serverApplicationRoots },
    @{ Root = $serverUpdateRuntimeStage; Roots = $serverRuntimeRoots }
)) {
    foreach ($name in @($target.Roots)) {
        $source = Join-Path $serverStage $name
        $destination = Join-Path $target.Root $name
        if (-not (Test-Path -LiteralPath $source)) { throw "Missing server update root: $name" }
        if ($name -eq 'scripts') {
            New-Item -ItemType Directory -Force -Path $destination | Out-Null
            Copy-Item -LiteralPath (Join-Path $source 'db-backup.js') -Destination $destination -Force
        }
        elseif ($name -eq 'deployment') {
            $toolsDestination = Join-Path $destination 'tools'
            New-Item -ItemType Directory -Force -Path $toolsDestination | Out-Null
            foreach ($tool in @('run-pending-migrations.js', 'verify-install.js', 'validate-payload.js')) {
                Copy-Item -LiteralPath (Join-Path $source "tools/$tool") -Destination $toolsDestination -Force
            }
        }
        elseif ((Get-Item -LiteralPath $source).PSIsContainer) { Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force }
        else { Copy-Item -LiteralPath $source -Destination $destination -Force }
    }
}
Get-ChildItem -LiteralPath $serverUpdateRuntimeStage -Recurse -Force -File -Filter '.package-lock.json' | Remove-Item -Force

# The ordinary spooler update is an application-only payload. Copy the allowlist
# directly so node_modules/.cache/runtime/install can never enter the core stream.
# Every root-level module the package requires must be listed, not just the entry points:
# this list is copied verbatim, so a file left out ships its dependents broken. beep-tester
# and print-width-calibration both require raw-print, and installerPackageContract asserts
# that relationship rather than trusting this list to be kept in step by hand.
$spoolerApplicationRoots = @(
    'beep-tester.js', 'http-client.js',
    'print-width-calibration.js', 'printer-alerts.js', 'raw-print.js', 'recover-printer.js',
    'receipt-display.cjs', 'renderDocument.js', 'businessTime.js',
    'report-html.js', 'server.js', 'thermal-raster.js', 'package.json', 'package-lock.json', 'release.json', 'vendor',
    'v2', 'windows-helper', 'bin', 'maintenance'
)
foreach ($name in $spoolerApplicationRoots) {
    $source = Join-Path $spoolerStage $name
    $target = Join-Path $spoolerUpdateCoreStage $name
    if (-not (Test-Path -LiteralPath $source)) { throw "Missing spooler application root: $name" }
    if ((Get-Item -LiteralPath $source).PSIsContainer) { Copy-Item -LiteralPath $source -Destination $target -Recurse -Force }
    else { Copy-Item -LiteralPath $source -Destination $target -Force }
}

# The runtime-transition payload contains the complete runtime exactly once. Copy
# the explicit application/dependency roots so stale stage leftovers or
# fresh-only files cannot enter the transition package.
$spoolerRuntimeRoots = @($spoolerApplicationRoots + 'node_modules', '.cache')
foreach ($name in $spoolerRuntimeRoots) {
    $source = Join-Path $spoolerStage $name
    $target = Join-Path $spoolerUpdateRuntimeStage $name
    if (-not (Test-Path -LiteralPath $source)) { throw "Missing spooler runtime root: $name" }
    if ((Get-Item -LiteralPath $source).PSIsContainer) { Copy-Item -LiteralPath $source -Destination $target -Recurse -Force }
    else { Copy-Item -LiteralPath $source -Destination $target -Force }
}
Get-ChildItem -LiteralPath $spoolerUpdateRuntimeStage -Recurse -Force -File -Filter '.package-lock.json' | Remove-Item -Force
$requestLink = Join-Path $spoolerUpdateRuntimeStage 'node_modules/request'
$requestSource = Join-Path $spoolerUpdateRuntimeStage 'vendor/request-disabled'
if (Test-Path -LiteralPath $requestLink) {
    $requestItem = Get-Item -LiteralPath $requestLink -Force
    if ($requestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        if ($requestItem.PSIsContainer) { [IO.Directory]::Delete($requestItem.FullName, $false) }
        else { [IO.File]::Delete($requestItem.FullName) }
    } else {
        Remove-Item -LiteralPath $requestLink -Recurse -Force
    }
    Copy-Item -LiteralPath $requestSource -Destination $requestLink -Recurse -Force
}

$serverCoreRelease = [ordered]@{ version = $releaseVersion; commit = $commit; schemaVersion = $schema.baseline.id; spoolerVersion = $spoolerVersion; payloadKind = 'server-update-core' }
$serverRuntimeRelease = [ordered]@{ version = $releaseVersion; commit = $commit; schemaVersion = $schema.baseline.id; spoolerVersion = $spoolerVersion; payloadKind = 'server-update-runtime' }
$spoolerCoreRelease = [ordered]@{ version = $spoolerVersion; commit = $commit; schemaVersion = $schema.baseline.id; spoolerVersion = $spoolerVersion; payloadKind = 'spooler-update-core'; runtimeProfile = $runtimeProfile }
$spoolerRuntimeRelease = [ordered]@{ version = $spoolerVersion; commit = $commit; schemaVersion = $schema.baseline.id; spoolerVersion = $spoolerVersion; payloadKind = 'spooler-update-runtime'; runtimeProfile = $runtimeProfile }
Write-Utf8NoBom (Join-Path $serverUpdateCoreStage 'release.json') ($serverCoreRelease | ConvertTo-Json -Depth 5)
Write-Utf8NoBom (Join-Path $serverUpdateRuntimeStage 'release.json') ($serverRuntimeRelease | ConvertTo-Json -Depth 5)
Write-Utf8NoBom (Join-Path $spoolerUpdateCoreStage 'release.json') ($spoolerCoreRelease | ConvertTo-Json -Depth 5)
Write-Utf8NoBom (Join-Path $spoolerUpdateRuntimeStage 'release.json') ($spoolerRuntimeRelease | ConvertTo-Json -Depth 5)
Write-UpdateManifest $serverUpdateCoreStage 'server-update-core' $releaseVersion $commit $serverApplicationRoots
Write-UpdateManifest $serverUpdateRuntimeStage 'server-update-runtime' $releaseVersion $commit $serverRuntimeRoots

$payloadValidator = Join-Path $repo 'deployment/tools/validate-payload.js'
# release.json is excluded from its own payload hash. The runtime hash is copied
# into the core release so a cheap update can refuse an incompatible installed runtime.
Invoke-Native $nodeExe @($payloadValidator, $spoolerStage, 'spooler', $spoolerStage, '--stamp-spooler')
Invoke-Native $nodeExe @($payloadValidator, $spoolerUpdateRuntimeStage, 'spooler-update-runtime', $spoolerUpdateRuntimeStage, '--stamp-spooler')
Invoke-Native $nodeExe @($payloadValidator, $spoolerUpdateCoreStage, 'spooler-update-core', $spoolerUpdateRuntimeStage, '--stamp-spooler')

Invoke-Native $nodeExe @($payloadValidator, $serverStage, 'server')
Invoke-Native $nodeExe @($payloadValidator, $spoolerStage, 'spooler')
Invoke-Native $nodeExe @($payloadValidator, $serverUpdateCoreStage, 'server-update-core')
Invoke-Native $nodeExe @($payloadValidator, $serverUpdateRuntimeStage, 'server-update-runtime')
Invoke-Native $nodeExe @($payloadValidator, $spoolerUpdateCoreStage, 'spooler-update-core')
Invoke-Native $nodeExe @($payloadValidator, $spoolerUpdateRuntimeStage, 'spooler-update-runtime')

$corePayloadBytes = [int64]((Get-ChildItem -LiteralPath $spoolerUpdateCoreStage -Recurse -Force -File | Measure-Object -Property Length -Sum).Sum)
Write-Output ("spooler-update-core unpacked: {0:N0} bytes ({1:N2} MiB)" -f $corePayloadBytes, ($corePayloadBytes / 1MB))
if ($corePayloadBytes -ge 5MB) { throw "Spooler core payload exceeds 5MB gate: $corePayloadBytes bytes." }
if (Get-ChildItem -LiteralPath $spoolerUpdateCoreStage -Recurse -Force -File | Where-Object { $_.FullName -match '[\\/](?:node_modules|\.cache|runtime|install)[\\/]' }) { throw 'Spooler core payload contains forbidden runtime content.' }
if (Get-ChildItem -LiteralPath $spoolerUpdateRuntimeStage -Recurse -Force -Directory | Where-Object { $_.FullName -match '[\\/](?:node_modules|\.cache)[\\/](?:node_modules|\.cache)(?:[\\/]|$)' }) { throw 'Spooler runtime payload contains nested dependency/cache roots.' }
$serverCorePayloadBytes = [int64]((Get-ChildItem -LiteralPath $serverUpdateCoreStage -Recurse -Force -File | Measure-Object -Property Length -Sum).Sum)
Write-Output ("server-update-core unpacked: {0:N0} bytes ({1:N2} MiB)" -f $serverCorePayloadBytes, ($serverCorePayloadBytes / 1MB))
if ($serverCorePayloadBytes -ge 35MB) { throw "Server core payload exceeds 35MB gate: $serverCorePayloadBytes bytes." }
if (Get-ChildItem -LiteralPath $serverUpdateCoreStage -Recurse -Force | Where-Object { $_.FullName -match '[\\/](?:node_modules|runtime|install)(?:[\\/]|$)' }) { throw 'Server core payload contains forbidden runtime content.' }
if (-not $StageOnly) {
    $portableIscc = Join-Path $repo 'deployment/out/toolchain/inno/ISCC.exe'
    $pathIscc = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    $iscc = if (Test-Path -LiteralPath $portableIscc -PathType Leaf) { $portableIscc } elseif ($pathIscc) { $pathIscc.Source } else { $null }
    if (-not $iscc) { throw 'ISCC.exe was not found; use -StageOnly or install Inno Setup on the build machine.' }
    $spoolerDefines = @()
    $spoolerDefines += "/DStageRoot=$stage"
    $spoolerDefines += "/DInstallerOutputDir=$out"
    $spoolerInstaller = Join-Path $repo 'deployment/spooler/POSAPP-Spooler.iss'
    $spoolerSetupArguments = @($spoolerDefines) + @("/DAppVersion=$spoolerVersion", $spoolerInstaller)
    $spoolerUpdateArguments = @($spoolerDefines) + @('/DUpdateOnly=1', "/DAppVersion=$spoolerVersion", $spoolerInstaller)
    $spoolerRuntimeArguments = @($spoolerDefines) + @('/DUpdateOnly=1', '/DRuntimeUpdate=1', "/DAppVersion=$spoolerVersion", $spoolerInstaller)
    Invoke-Native $iscc $spoolerSetupArguments
    Invoke-Native $iscc $spoolerUpdateArguments
    Invoke-Native $iscc $spoolerRuntimeArguments
    $serverDefines = @("/DStageRoot=$stage", "/DInstallerOutputDir=$out")
    $serverInstaller = Join-Path $repo 'deployment/server/POSAPP-Server.iss'
    Invoke-Native $iscc (@($serverDefines) + @("/DAppVersion=$releaseVersion", $serverInstaller))
    Invoke-Native $iscc (@($serverDefines) + @('/DUpdateOnly=1', "/DAppVersion=$releaseVersion", $serverInstaller))
    Invoke-Native $iscc (@($serverDefines) + @('/DUpdateOnly=1', '/DRuntimeUpdate=1', "/DAppVersion=$releaseVersion", $serverInstaller))
    $ServerInstallerMaxBytes = 220MB
    $ServerUpdateMaxBytes = 15MB
    $ServerRuntimeUpdateMaxBytes = 35MB
    $SpoolerUpdateMaxBytes = 5MB
    $installerArtifacts = @(
        @{ Name = 'POSAPP-Server-Setup.exe'; MaxBytes = $ServerInstallerMaxBytes },
        @{ Name = 'POSAPP-Server-Update.exe'; MaxBytes = $ServerUpdateMaxBytes },
        @{ Name = 'POSAPP-Server-Runtime-Update.exe'; MaxBytes = $ServerRuntimeUpdateMaxBytes },
        @{ Name = 'POSAPP-Spooler-Typst-Only-Setup.exe'; MaxBytes = 100MB },
        @{ Name = 'POSAPP-Spooler-Typst-Only-Update.exe'; MaxBytes = $SpoolerUpdateMaxBytes },
        @{ Name = 'POSAPP-Spooler-Typst-Only-Runtime-Update.exe'; MaxBytes = 65MB }
    )
    foreach ($item in $installerArtifacts) {
        $path = Join-Path $out $item.Name
        if (-not (Test-Path $path)) { throw "Missing installer output: $($item.Name)" }
        $length = (Get-Item -LiteralPath $path).Length
        Write-Output ("{0}: {1:N0} bytes ({2:N2} MiB)" -f $item.Name, $length, ($length / 1MB))
        if ($length -gt $item.MaxBytes) { throw "Installer exceeds size gate: $($item.Name) is $length bytes; maximum is $($item.MaxBytes) bytes." }
        Write-Utf8NoBom "$path.sha256" (Get-Sha256 $path)
    }
    if (Test-Path -LiteralPath $pendingReleasePath -PathType Leaf) { Remove-Item -LiteralPath $pendingReleasePath -Force }
}
Write-Output "Staged production payloads under $stage"
