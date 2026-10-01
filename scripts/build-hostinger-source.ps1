param(
    [string]$Repo = (Split-Path $PSScriptRoot -Parent),
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [string]$PreviousZip = ''
)
$ErrorActionPreference = 'Stop'
function Get-StreamSha256([IO.Stream]$Stream) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($Stream)).Replace('-','').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}
function Get-PathSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try { return Get-StreamSha256 $stream }
    finally { $stream.Dispose() }
}
$Repo = (Resolve-Path -LiteralPath $Repo).Path
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path
$zip = Join-Path $OutputDirectory 'POSAPP-Hostinger-source.zip'
if (Test-Path -LiteralPath $zip) { throw 'Build only into a new candidate directory.' }
$stage = $null
$link = $null
Push-Location $Repo
try {
    $status = @(git status --porcelain)
    if ($LASTEXITCODE -ne 0 -or $status.Count) { throw 'Package a clean checkout; preserve and resolve outstanding changes first.' }
    $commit = (git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve Git revision.' }
    $files = @(git -c core.quotepath=false ls-files)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate source files.' }
    $stage = Join-Path ([IO.Path]::GetTempPath()) ('posapp-package-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage | Out-Null
    $roots = @('package.json','package-lock.json','server.js','vite.config.mjs','index.html','login.html','admin.html','menu.html','print_receipt.html','manifest.json')
    $sourceFiles = @($files | Where-Object {
        ($_ -in $roots -or $_ -eq 'scripts/verify-fontawesome-subset.cjs' -or $_ -eq 'scripts/verify-production-build.cjs' -or $_ -match '^(src|backend|assets)/') -and
        $_ -notmatch '(^|/)(tests?|__tests__|__fixtures__|node_modules|dist|uploads|logs)(/|$)|\.(test|spec)\.|(^|/)\.env|\.(pem|key|pfx|p12|log|zip)$'
    })
    foreach ($file in $sourceFiles) {
        $target = Join-Path $stage $file
        New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
        Copy-Item -LiteralPath (Join-Path $Repo $file) -Destination $target
    }
    foreach ($file in $roots) {
        if (!(Test-Path -LiteralPath (Join-Path $stage $file))) { throw "Missing build input: $file" }
    }
    $migrationDir = Join-Path $stage 'backend/migrations'
    $manifest = Get-Content -Raw -LiteralPath (Join-Path $migrationDir 'auto-manifest.json') | ConvertFrom-Json
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        foreach ($migration in $manifest.migrations) {
            $checks = @(@{ file=$migration.file; hash=$migration.sha256 })
            if ($migration.preflight) { $checks += @{ file=$migration.preflight; hash=$migration.preflightSha256 } }
            foreach ($check in $checks) {
                $sql = [IO.File]::ReadAllText((Join-Path $migrationDir $check.file)).TrimStart([char]0xFEFF).Replace("`r`n","`n")
                $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($sql))).Replace('-','')
                if ($hash -ne $check.hash) { throw "Migration hash mismatch: $($check.file)" }
            }
        }
    } finally { $sha.Dispose() }
    $package = Get-Content -Raw (Join-Path $stage 'package.json') | ConvertFrom-Json
    $spooler = Get-Content -Raw (Join-Path $Repo 'pos-spooler-printer/package.json') | ConvertFrom-Json
    $baseline = Get-Content -Raw (Join-Path $Repo 'deployment/database/manifest.json') | ConvertFrom-Json
    $release = @{ version=$package.version; commit=$commit; schemaVersion=$baseline.baseline.id; spoolerVersion=$spooler.version }
    [IO.File]::WriteAllText((Join-Path $stage 'release.json'), ($release | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    # Reuse installed build dependencies, never copy or archive them. Build outside
    # the checkout so local .env files and an old dist cannot enter the release.
    $link = Join-Path $stage 'node_modules'
    if (!(Test-Path -LiteralPath (Join-Path $Repo 'node_modules/vite/bin/vite.js'))) { throw 'Install the lockfile dependencies before packaging.' }
    New-Item -ItemType Junction -Path $link -Target (Join-Path $Repo 'node_modules') | Out-Null
    Push-Location $stage
    try {
        # Windows PowerShell wraps native stderr (including npm notices) as errors.
        # Preserve both streams and use the process exit code to judge the build.
        try {
            $ErrorActionPreference = 'Continue'
            & npm.cmd run build 2>&1 | Out-File -LiteralPath (Join-Path $OutputDirectory 'build.log') -Encoding utf8 -ErrorAction Stop
            $buildExitCode = $LASTEXITCODE
        } finally { $ErrorActionPreference = 'Stop' }
        if ($buildExitCode -ne 0) { throw 'Production build failed; no ZIP created.' }
    } finally {
        Pop-Location
        if (Test-Path -LiteralPath $link) { [IO.Directory]::Delete($link) }
    }
    foreach ($entry in @('index.html','login.html','admin.html','menu.html','print_receipt.html')) {
        if (!(Test-Path -LiteralPath (Join-Path $stage "dist/$entry"))) { throw "Missing built entry: $entry" }
    }
    if ((git rev-parse HEAD).Trim() -ne $commit -or @(git status --porcelain).Count) { throw 'Checkout changed during packaging; retry from stable source.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    Add-Type -AssemblyName System.IO.Compression
    # .NET Framework can emit backslashes from CreateFromDirectory. Specify each
    # entry name explicitly so the source tree extracts correctly on Linux hosts.
    $createdArchive = [IO.Compression.ZipFile]::Open($zip,[IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in Get-ChildItem -LiteralPath $stage -File -Recurse) {
            $entryName = $file.FullName.Substring($stage.Length + 1).Replace('\','/')
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($createdArchive,$file.FullName,$entryName,[IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally { $createdArchive.Dispose() }
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        $names = @($archive.Entries | ForEach-Object { $_.FullName })
        if ($names | Where-Object { $_.Contains('\') }) { throw 'Archive entry names must use forward slashes for Linux hosting.' }
        foreach ($file in ($roots + @('release.json','dist/index.html','dist/login.html','dist/admin.html','dist/menu.html','dist/print_receipt.html','backend/migrations/auto-manifest.json'))) {
            if ($file -notin $names) { throw "Archive is missing $file" }
        }
        if ($names | Where-Object { $_ -match '(^|/)(node_modules|\.git|tests?|__tests__)(/|$)|(^|/)\.env|\.(pem|key|pfx|p12|log)$' }) { throw 'Archive contains a forbidden file.' }
        $entries = @{}
        foreach ($entry in $archive.Entries) { $entries[$entry.FullName.Replace('\','/')] = $entry }
        foreach ($file in $sourceFiles) {
            if (!$entries.ContainsKey($file)) { throw "Archive is missing source: $file" }
            $stream = $entries[$file].Open()
            try { $archivedHash = Get-StreamSha256 $stream }
            finally { $stream.Dispose() }
            if ($archivedHash -ne (Get-PathSha256 (Join-Path $Repo $file))) {
                throw "Archived source changed: $file"
            }
        }
        $removed = @()
        if ($PreviousZip) {
            $previous = [IO.Compression.ZipFile]::OpenRead($PreviousZip)
            try {
                foreach ($entry in $previous.Entries) {
                    $name = $entry.FullName.Replace('\','/')
                    if ($name -match '^dist/|^release\.json$|/$' -or $name -in $names) { continue }
                    if ($name -in $files) { throw "Tracked source unexpectedly disappeared from archive: $name" }
                    $removed += $name
                }
            } finally { $previous.Dispose() }
        }
        $count = $names.Count
    } finally { $archive.Dispose() }
    if ((git rev-parse HEAD).Trim() -ne $commit -or @(git status --porcelain).Count) { throw 'Checkout changed during archive verification.' }
    $report = [ordered]@{
        commit=$commit; release=$release; sourceBytes=(Get-Item $zip).Length; sourceEntries=$count;
        verifiedSourceFiles=$sourceFiles.Count; automaticMigrations=$manifest.migrations.Count;
        sourceMigrationFiles=@($names | Where-Object { $_ -match '^backend/migrations/' }).Count;
        sourceZipSha256=(Get-PathSha256 $zip);
        intentionallyRemovedSourcePaths=$removed; unexpectedMissingSourcePaths=0;
        productionBuild='passed in environment-free staging'; migrationChecksums='passed'
    }
    [IO.File]::WriteAllText((Join-Path $OutputDirectory 'source-verification.json'), ($report | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    Write-Output "Source ZIP verified at $commit ($count entries)."
} finally {
    Pop-Location
    # Remove the dependency junction itself before the staging tree; never recurse through it.
    if ($link -and (Test-Path -LiteralPath $link)) { [IO.Directory]::Delete($link) }
    if ($stage -and (Test-Path -LiteralPath $stage)) {
        $resolvedStage = (Resolve-Path -LiteralPath $stage).Path
        $expectedParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
        if ((Split-Path $resolvedStage -Parent) -ne $expectedParent -or (Split-Path $resolvedStage -Leaf) -notlike 'posapp-package-*') {
            throw 'Unexpected staging cleanup path.'
        }
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
