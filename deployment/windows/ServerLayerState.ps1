Set-StrictMode -Version Latest

$script:ServerLayerAppId = '{E99DB275-DDA0-43A0-95CD-7AE07185122C}'

function Read-ServerDependencyManifest([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'Server dependency manifest is missing.' }
    try { $manifest = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
    catch { throw 'Server dependency manifest is invalid.' }
    if ([int]$manifest.format -ne 1 -or [string]$manifest.kind -ne 'server-dependencies' -or
        [string]$manifest.nodeVersion -ne '22.23.0' -or [string]$manifest.platform -ne 'win32' -or
        [string]$manifest.arch -ne 'x64' -or [string]$manifest.dependencies.id -notmatch '^[0-9a-f]{64}$') {
        throw 'Server dependency manifest identity is invalid.'
    }
    return $manifest
}

function Assert-ServerDependencyInventory([string]$Root, $Manifest) {
    $inventory = $Manifest.dependencies
    $seen = @{}
    $canonical = @()
    $previous = $null
    foreach ($entry in @($inventory.files)) {
        $relative = ([string]$entry.path).Replace('\', '/')
        if ($relative -ne 'node_modules' -and -not $relative.StartsWith('node_modules/', [StringComparison]::OrdinalIgnoreCase)) { throw "Server dependency path is outside node_modules: $relative" }
        if ([string]::IsNullOrWhiteSpace($relative) -or [IO.Path]::IsPathRooted($relative) -or $relative.Split('/') -contains '..' -or $relative.Split('/') -contains '.') { throw "Unsafe server dependency path: $relative" }
        $key = $relative.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { throw "Duplicate server dependency path: $relative" }
        if ($null -ne $previous -and [string]::CompareOrdinal($previous, $relative) -gt 0) { throw 'Server dependency inventory is not sorted.' }
        $seen[$key] = $true
        $previous = $relative
        $candidate = Join-Path $Root $relative.Replace('/', '\')
        Assert-PathUnderRoot $Root $candidate | Out-Null
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "Missing server dependency file: $relative" }
        $item = Get-Item -LiteralPath $candidate -Force
        $digest = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
        if ([int64]$entry.bytes -ne [int64]$item.Length -or [string]$entry.sha256 -notmatch '^[0-9a-f]{64}$' -or $digest -ne [string]$entry.sha256.ToLowerInvariant()) { throw "Server dependency hash mismatch: $relative" }
        $canonical += [ordered]@{ path = $relative; bytes = [int64]$item.Length; sha256 = $digest }
    }
    $actualFiles = @(Get-ChildItem -LiteralPath (Join-Path $Root 'node_modules') -Recurse -Force -File | Where-Object { $_.Name -ne '.package-lock.json' })
    if ($actualFiles.Count -ne $canonical.Count) { throw 'Server dependency inventory file count mismatch.' }
    $json = ConvertTo-Json -InputObject ([object[]]$canonical) -Compress -Depth 5
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $expectedId = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($json)))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
    if ($expectedId -ne [string]$inventory.id.ToLowerInvariant()) { throw 'Server dependency inventory identity mismatch.' }
    return $inventory
}

function Read-ServerInstalledRuntime([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { $record = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
    catch { throw 'Installed server runtime attestation is invalid.' }
    if ([int]$record.format -ne 1 -or [string]$record.appId -ne $script:ServerLayerAppId -or
        [string]$record.nodeVersion -ne '22.23.0' -or [string]$record.platform -ne 'win32' -or
        [string]$record.arch -ne 'x64' -or [string]$record.dependenciesId -notmatch '^[0-9a-f]{64}$') { throw 'Installed server runtime attestation is incomplete.' }
    return $record
}

function Write-ServerInstalledRuntime([string]$Path, $DependencyManifest) {
    $record = [ordered]@{
        format = 1
        appId = $script:ServerLayerAppId
        nodeVersion = [string]$DependencyManifest.nodeVersion
        platform = [string]$DependencyManifest.platform
        arch = [string]$DependencyManifest.arch
        dependenciesId = [string]$DependencyManifest.dependencies.id
    }
    $parent = Split-Path -Parent $Path
    Assert-PathUnderRoot $parent $Path | Out-Null
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    $temporary = Join-Path $parent ('.server-runtime-' + $PID + '-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($temporary, ($record | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    }
    finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue } }
    return $record
}
