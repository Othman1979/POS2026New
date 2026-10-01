[CmdletBinding()]
param(
    [string]$BaselineCommit = 'e6938caa',
    [string]$OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { $OutputDirectory = Join-Path $repo 'deployment\out\baseline-1.0.0' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
$expectedOutputRoot = [IO.Path]::GetFullPath((Join-Path $repo 'deployment\out')).TrimEnd('\') + '\'
if (-not $output.StartsWith($expectedOutputRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'OutputDirectory must remain below deployment\out.' }

$tempRoot = if (Test-Path -LiteralPath 'C:\tmp' -PathType Container) { 'C:\tmp' } else { [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') }
$worktree = Join-Path $tempRoot "posapp-baseline-$([guid]::NewGuid().ToString('N'))"
$worktreeAdded = $false

function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $FilePath $($Arguments -join ' ')" }
}
function Copy-Tree([string]$Source, [string]$Destination) {
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw "Missing build cache: $Source" }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $Source -Force) { Copy-Item -LiteralPath $item.FullName -Destination $Destination -Recurse -Force }
}
function Read-GitFile([string]$Commit, [string]$RelativePath) {
    $value = (& git.exe -C $repo show "$Commit`:$RelativePath" | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "Cannot read $RelativePath from $Commit." }
    return $value
}
function Normalize-Lock([string]$Text) {
    $value = [regex]::Replace($Text, '(?s)\A(\s*\{\s*"name"\s*:\s*"[^"]+"\s*,\s*)"version"\s*:\s*"[^"]+"\s*,', '$1')
    $value = [regex]::Replace($value, '(?s)("packages"\s*:\s*\{\s*""\s*:\s*\{\s*"name"\s*:\s*"[^"]+"\s*,\s*)"version"\s*:\s*"[^"]+"\s*,', '$1')
    return ($value -replace '\s', '')
}
function Assert-CompatibleCaches {
    foreach ($relative in @('package-lock.json', 'pos-spooler-printer/package-lock.json')) {
        if ((Normalize-Lock (Get-Content -Raw (Join-Path $repo $relative))) -ne (Normalize-Lock (Read-GitFile $BaselineCommit $relative))) {
            throw "Dependency graph differs from the baseline: $relative"
        }
    }
    $currentVendor = Get-Content -Raw (Join-Path $repo 'deployment\vendor-lock.json') | ConvertFrom-Json | ConvertTo-Json -Depth 20 -Compress
    $baselineVendor = Read-GitFile $BaselineCommit 'deployment/vendor-lock.json' | ConvertFrom-Json | ConvertTo-Json -Depth 20 -Compress
    if ($currentVendor -ne $baselineVendor) { throw 'Vendor lock differs from the baseline.' }
}
function Write-Hash([string]$Path) {
    $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$Path.sha256", $hash, [Text.UTF8Encoding]::new($false))
    return $hash
}
function Assert-TemporaryWorktree([string]$Path) {
    $root = [IO.Path]::GetFullPath($tempRoot).TrimEnd('\') + '\'
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw "Temporary worktree escaped $tempRoot." }
}

try {
    $baselinePackage = Read-GitFile $BaselineCommit 'package.json' | ConvertFrom-Json
    $baselineSpooler = Read-GitFile $BaselineCommit 'pos-spooler-printer/package.json' | ConvertFrom-Json
    if ([string]$baselinePackage.version -ne '1.0.0' -or [string]$baselineSpooler.version -ne '1.2.0') { throw 'Baseline commit is not POSAPP Server 1.0.0 / Spooler 1.2.0.' }
    Assert-CompatibleCaches

    $currentStage = Join-Path $repo 'deployment\out\stage'
    foreach ($required in @(
        (Join-Path $repo 'node_modules'),
        (Join-Path $repo 'deployment\vendor'),
        (Join-Path $currentStage 'server\node_modules'),
        (Join-Path $currentStage 'spooler\node_modules'),
        (Join-Path $currentStage 'spooler\.cache'),
        (Join-Path $repo 'deployment\out\toolchain\inno')
    )) { if (-not (Test-Path -LiteralPath $required -PathType Container)) { throw "Required verified build cache is missing: $required" } }

    Assert-TemporaryWorktree $worktree
    Invoke-Native 'git.exe' @('-C', $repo, 'worktree', 'add', '--detach', $worktree, $BaselineCommit)
    $worktreeAdded = $true

    Copy-Tree (Join-Path $repo 'deployment\vendor') (Join-Path $worktree 'deployment\vendor')
    New-Item -ItemType Junction -Path (Join-Path $worktree 'node_modules') -Target (Join-Path $repo 'node_modules') | Out-Null

    $oldOut = Join-Path $worktree 'deployment\out'
    Copy-Tree (Join-Path $currentStage 'server\node_modules') (Join-Path $oldOut 'stage\server\node_modules')
    Copy-Tree (Join-Path $currentStage 'spooler\node_modules') (Join-Path $oldOut 'stage\spooler\node_modules')
    Copy-Tree (Join-Path $currentStage 'spooler\.cache') (Join-Path $oldOut 'stage\spooler\.cache')
    Copy-Tree (Join-Path $repo 'deployment\out\toolchain\inno') (Join-Path $oldOut 'toolchain\inno')

    Invoke-Native 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $worktree 'scripts\build-installers.ps1'), '-SkipDependencyInstall', '-SkipVersionBump')

    New-Item -ItemType Directory -Force -Path $output | Out-Null
    $summary = [ordered]@{ baselineCommit = $BaselineCommit; serverVersion = '1.0.0'; spoolerVersion = '1.2.0'; output = $output; artifacts = [ordered]@{} }
    foreach ($name in @('POSAPP-Server-Setup.exe', 'POSAPP-Spooler-Setup.exe')) {
        $source = Join-Path $oldOut $name
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Baseline build did not produce $name." }
        $destination = Join-Path $output $name
        Copy-Item -LiteralPath $source -Destination $destination -Force
        $summary.artifacts[$name] = [ordered]@{ bytes = [int64](Get-Item -LiteralPath $destination).Length; sha256 = Write-Hash $destination }
    }
    $summary | ConvertTo-Json -Depth 6
}
finally {
    if ($worktreeAdded) {
        try { Invoke-Native 'git.exe' @('-C', $repo, 'worktree', 'remove', '--force', $worktree) }
        catch { Write-Warning "Could not remove temporary worktree: $worktree" }
    }
}
