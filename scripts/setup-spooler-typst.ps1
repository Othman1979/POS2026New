[CmdletBinding()]
param([string]$Destination = '', [string]$VendorDirectory = '')

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$vendor = if ($VendorDirectory) { [IO.Path]::GetFullPath($VendorDirectory) } else { Join-Path $repo 'deployment/vendor' }
$lock = Get-Content -Raw -LiteralPath (Join-Path $repo 'deployment/vendor-lock.json') | ConvertFrom-Json
$target = if ($Destination) { [IO.Path]::GetFullPath($Destination) } else { Join-Path $repo 'pos-spooler-printer/.cache/typst/0.15.1' }
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([char[]]@('\', '/'))
$temporary = [IO.Path]::GetFullPath((Join-Path $tempRoot ("posapp-typst-setup-$PID-" + [guid]::NewGuid().ToString('N'))))
if (-not $temporary.StartsWith($tempRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe Typst temporary directory.' }

function Verified-Artifact([string]$Name) {
    $entry = @($lock.packages | Where-Object { $_.name -eq $Name })[0]
    if (-not $entry) { throw "Missing vendor lock entry: $Name" }
    if ([IO.Path]::GetFileName([string]$entry.file) -ne [string]$entry.file -or [string]$entry.sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "Invalid vendor lock entry: $Name" }
    $file = Join-Path $vendor $entry.file
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        $uri = [uri][string]$entry.source
        if ($uri.Scheme -ne 'https') { throw "Vendor source must use HTTPS: $Name" }
        New-Item -ItemType Directory -Force -Path $vendor | Out-Null
        $download = Join-Path $temporary $entry.file
        Invoke-WebRequest -Uri $uri -OutFile $download -UseBasicParsing -TimeoutSec 120 -MaximumRedirection 5
        if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$entry.sha256) { throw "Vendor checksum mismatch: $($entry.file)" }
        $partial = Join-Path $vendor ("$($entry.file).$PID.partial")
        try {
            Copy-Item -LiteralPath $download -Destination $partial -Force
            if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { Move-Item -LiteralPath $partial -Destination $file }
        } finally {
            if (Test-Path -LiteralPath $partial -PathType Leaf) { Remove-Item -LiteralPath $partial -Force }
        }
    }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$entry.sha256) { throw "Vendor checksum mismatch: $($entry.file)" }
    return $file
}

try {
    New-Item -ItemType Directory -Force -Path $temporary, (Join-Path $target 'fonts') | Out-Null
    Expand-Archive -LiteralPath (Verified-Artifact 'typst') -DestinationPath $temporary -Force
    $binary = @(Get-ChildItem -LiteralPath $temporary -Recurse -File -Filter typst.exe)[0]
    if (-not $binary) { throw 'Typst archive is missing typst.exe.' }
    foreach ($name in @('typst.exe', 'LICENSE', 'NOTICE')) {
        $source = Join-Path $binary.DirectoryName $name
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Typst archive is missing $name." }
        Copy-Item -LiteralPath $source -Destination $target -Force
    }
    & node (Join-Path $repo 'deployment/tools/patch-typst-fast-watch.js') (Join-Path $target 'typst.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Typst patch failed.' }
    Copy-Item -LiteralPath (Join-Path $repo 'deployment/patches/typst-0.15.1-fast-watch.txt') -Destination (Join-Path $target 'POSAPP-PATCH.txt') -Force
    foreach ($item in @(
        @{ Name = 'noto-sans'; File = 'NotoSans.ttf' },
        @{ Name = 'noto-sans-arabic'; File = 'NotoSansArabic.ttf' },
        @{ Name = 'noto-emoji'; File = 'NotoEmoji.ttf' },
        @{ Name = 'noto-ofl'; File = 'OFL.txt' }
    )) {
        Copy-Item -LiteralPath (Verified-Artifact $item.Name) -Destination (Join-Path $target "fonts/$($item.File)") -Force
    }
    $version = (& (Join-Path $target 'typst.exe') --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^typst 0\.15\.1\b') { throw "Unexpected Typst runtime: $version" }
    Write-Output $target
} finally {
    if ($temporary.StartsWith($tempRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $temporary)) {
        Remove-Item -LiteralPath $temporary -Recurse -Force
    }
}
