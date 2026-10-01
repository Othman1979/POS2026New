Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:InstallerUpdateStates = @('update', 'current', 'blocked_version_collision', 'blocked_downgrade', 'blocked_ownership', 'blocked_incomplete', 'blocked_fresh')

function Get-UpdateFileSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
        $stream.Dispose()
    }
}

function ConvertTo-UpdateProgressField([string]$Value) {
    return (($Value -replace '[\r\n|]', ' ').Trim())
}

function Write-UpdateProgress {
    param(
        [int]$Step,
        [int]$StepTotal,
        [string]$Label,
        [string]$Detail = '',
        [int]$Completed = 0,
        [int]$Total = 0
    )
    $line = 'POSAPP_PROGRESS|{0}|{1}|{2}|{3}|{4}|{5}' -f $Step, $StepTotal, $Completed, $Total,
        (ConvertTo-UpdateProgressField $Label), (ConvertTo-UpdateProgressField $Detail)
    [void][Console]::Out.WriteLine($line)
    [void][Console]::Out.Flush()
}

function Test-UpdateProgressCheckpoint([int]$Completed, [int]$Total) {
    return $Completed -gt 0 -and ($Completed -eq 1 -or $Completed -eq $Total -or ($Completed % 25) -eq 0)
}

function Read-ReleaseIdentity {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$ExpectedKind)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Release identity is missing: $Path" }
    try { $release = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json } catch { throw "Release identity is invalid: $Path" }
    if ([string]$release.payloadKind -ne $ExpectedKind -or [string]$release.version -notmatch '^\d+\.\d+\.\d+$' -or [string]$release.commit -notmatch '^[0-9a-fA-F]{40}$') {
        throw "Release identity does not match $ExpectedKind."
    }
    return [pscustomobject]@{ version = [string]$release.version; commit = [string]$release.commit.ToLowerInvariant(); payloadKind = [string]$release.payloadKind; schemaVersion = [string]$release.schemaVersion; spoolerVersion = [string]$release.spoolerVersion }
}

function Compare-PackagedRelease {
    param([Parameter(Mandatory)]$Installed, [Parameter(Mandatory)]$Target)
    if ([string]$Installed.version -notmatch '^\d+\.\d+\.\d+$' -or [string]$Target.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Release version must be major.minor.patch.' }
    $installedVersion = [version][string]$Installed.version
    $targetVersion = [version][string]$Target.version
    if ($targetVersion -lt $installedVersion) { $state = 'blocked_downgrade' }
    elseif ($targetVersion -eq $installedVersion -and [string]$Installed.commit -eq [string]$Target.commit) { $state = 'current' }
    elseif ($targetVersion -eq $installedVersion) { $state = 'blocked_version_collision' }
    else { $state = 'update' }
    return [pscustomobject]@{ state = $state; installed = $Installed; target = $Target }
}

# Keep service executable parsing identical to the fresh spooler installer.
# ImagePath may be quoted or followed by service arguments; ownership is an
# exact normalized path comparison, never a substring match.
function Get-ServiceImagePath([string]$Name) {
    $serviceKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$Name"
    if (-not (Test-Path -LiteralPath $serviceKey)) { return $null }
    try { return [string](Get-ItemProperty -LiteralPath $serviceKey -Name ImagePath -ErrorAction Stop).ImagePath }
    catch { return $null }
}
function Get-RegisteredExecutablePath([string]$ImagePath) {
    if ([string]::IsNullOrWhiteSpace($ImagePath)) { return $null }
    $trimmed = $ImagePath.Trim()
    if ($trimmed.StartsWith('"')) {
        $closingQuote = $trimmed.IndexOf('"', 1)
        if ($closingQuote -lt 1) { return $null }
        return $trimmed.Substring(1, $closingQuote - 1)
    }
    if ($trimmed -match '^(?<path>.*?\.exe)(?:\s+.*)?$') { return $Matches.path.Trim() }
    return ($trimmed -split '\s+', 2)[0]
}
function Normalize-Path([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    try { return ([IO.Path]::GetFullPath($Path)).TrimEnd('\') }
    catch { return $null }
}
function Test-SamePath([string]$Left, [string]$Right) {
    $leftNormalized = Normalize-Path $Left
    $rightNormalized = Normalize-Path $Right
    return $null -ne $leftNormalized -and $null -ne $rightNormalized -and $leftNormalized.Equals($rightNormalized, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-PathUnderRoot {
    param([Parameter(Mandatory)][string]$Root, [Parameter(Mandatory)][string]$Candidate)
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $candidateFull = [IO.Path]::GetFullPath($Candidate)
    $prefix = $rootFull + [IO.Path]::DirectorySeparatorChar
    if (-not $candidateFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Path escapes install root: $Candidate" }
    if (Test-Path -LiteralPath $rootFull) {
        $rootItem = Get-Item -LiteralPath $rootFull -Force
        if ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse path is not allowed: $rootFull" }
    }
    $current = $rootFull
    foreach ($part in $candidateFull.Substring($prefix.Length) -split '[\\/]') {
        $current = Join-Path $current $part
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse path is not allowed: $current" }
        }
    }
    return $true
}

function Read-UpdateManifest {
    param(
        [Parameter(Mandatory)]$Path,
        [Parameter(Mandatory)][string]$PayloadRoot,
        [Parameter(Mandatory)][string]$ExpectedKind,
        [int]$ProgressStep = 0,
        [int]$ProgressStepTotal = 1,
        [string]$ProgressLabel = 'Verifying update package'
    )
    $manifest = if ($Path -is [string]) { Get-Content -Raw -LiteralPath ([string]$Path) | ConvertFrom-Json } else { $Path }
    if ([int]$manifest.format -ne 1 -or [string]$manifest.kind -ne $ExpectedKind -or -not $manifest.files) { throw "Invalid $ExpectedKind update manifest." }
    if ([string]$manifest.version -notmatch '^\d+\.\d+\.\d+$' -or [string]$manifest.commit -notmatch '^[0-9a-fA-F]{40}$') { throw "Invalid $ExpectedKind update manifest identity." }
    $managedRoots = @($manifest.managedRoots)
    if (-not $managedRoots.Count) { throw "Invalid $ExpectedKind managed roots." }
    $normalizedRoots = @()
    foreach ($rootEntry in $managedRoots) {
        $root = ([string]$rootEntry).Replace('\', '/')
        if ([string]::IsNullOrWhiteSpace($root) -or [IO.Path]::IsPathRooted($root) -or $root.Split('/') -contains '..' -or $root.Split('/') -contains '.' -or $root.StartsWith('ProgramData/', [StringComparison]::OrdinalIgnoreCase)) { throw "Invalid update managed root: $root" }
        if ($normalizedRoots -contains $root) { throw "Duplicate update managed root: $root" }
        $normalizedRoots += $root
    }
    $seen = @{}
    $manifestEntries = @($manifest.files)
    $verified = 0
    foreach ($entry in $manifestEntries) {
        $relative = ([string]$entry.path).Replace('\', '/')
        if ([string]::IsNullOrWhiteSpace($relative) -or [IO.Path]::IsPathRooted($relative) -or $relative.Split('/') -contains '..' -or $relative.StartsWith('ProgramData/', [StringComparison]::OrdinalIgnoreCase)) { throw "Invalid update manifest path: $relative" }
        if ($seen.ContainsKey($relative)) { throw "Duplicate update manifest path: $relative" }
        $rooted = $false
        foreach ($managedRoot in $normalizedRoots) {
            if ($relative -eq $managedRoot -or $relative.StartsWith($managedRoot + '/', [StringComparison]::OrdinalIgnoreCase)) { $rooted = $true; break }
        }
        if (-not $rooted) { throw "Update manifest path is outside managed roots: $relative" }
        $seen[$relative] = $true
        $candidate = Join-Path $PayloadRoot $relative
        Assert-PathUnderRoot $PayloadRoot $candidate | Out-Null
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "Missing update payload file: $relative" }
        $item = Get-Item -LiteralPath $candidate -Force
        if ($null -eq $entry.bytes -or [int64]$entry.bytes -ne [int64]$item.Length -or [string]$entry.sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "Update payload metadata mismatch: $relative" }
        $actualHash = Get-UpdateFileSha256 $candidate
        if ($actualHash -ne ([string]$entry.sha256).ToLowerInvariant()) { throw "Update payload hash mismatch: $relative" }
        $verified++
        if ($ProgressStep -gt 0 -and (Test-UpdateProgressCheckpoint $verified $manifestEntries.Count)) {
            Write-UpdateProgress -Step $ProgressStep -StepTotal $ProgressStepTotal -Completed $verified -Total $manifestEntries.Count -Label $ProgressLabel -Detail $relative
        }
    }
    return [pscustomobject]@{ format = [int]$manifest.format; kind = [string]$manifest.kind; version = [string]$manifest.version; commit = ([string]$manifest.commit).ToLowerInvariant(); managedRoots = $normalizedRoots; files = @($manifest.files) }
}

function Get-ManifestEntries($Manifest) {
    if ($null -eq $Manifest) { return @() }
    if ($Manifest.PSObject.Properties.Name -contains 'files') { return @($Manifest.files) }
    return @($Manifest)
}

function Get-ManagedEntryRelative {
    param([Parameter(Mandatory)]$Manifest, [Parameter(Mandatory)]$Entry)
    $relative = ([string]$Entry.path).Replace('\', '/')
    if ([string]::IsNullOrWhiteSpace($relative) -or [IO.Path]::IsPathRooted($relative) -or $relative.Split('/') -contains '..' -or $relative.Split('/') -contains '.' -or $relative.StartsWith('ProgramData/', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Invalid managed payload path: $relative"
    }
    $roots = @($Manifest.managedRoots)
    if (-not $roots.Count) { throw 'Managed payload manifest has no exact managed roots.' }
    $allowed = $false
    foreach ($managedRoot in $roots) {
        $root = ([string]$managedRoot).Replace('\', '/').TrimEnd('/')
        if ($relative -eq $root -or $relative.StartsWith($root + '/', [StringComparison]::OrdinalIgnoreCase)) { $allowed = $true; break }
    }
    if (-not $allowed) { throw "Managed payload path is outside exact managed roots: $relative" }
    return $relative
}

function Get-ManagedFileUnion {
    param($PreviousManifest, $TargetManifest)
    $seen = @{}
    foreach ($manifest in @($PreviousManifest, $TargetManifest)) {
        if ($null -eq $manifest) { continue }
        foreach ($entry in @(Get-ManifestEntries $manifest)) {
            $relative = Get-ManagedEntryRelative $manifest $entry
            $key = $relative.ToLowerInvariant()
            if (-not $seen.ContainsKey($key)) {
                $seen[$key] = [pscustomobject]@{ path = $relative }
            }
        }
    }
    return @($seen.Values)
}

function Backup-ManagedPayload {
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string]$DestinationRoot,
        [Parameter(Mandatory)]$Manifest,
        [int]$ProgressStep = 0,
        [int]$ProgressStepTotal = 1,
        [string]$ProgressLabel = 'Preparing rollback'
    )
    New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null
    $existing = @()
    $missing = @()
    $entries = @(Get-ManifestEntries $Manifest)
    $completed = 0
    foreach ($entry in $entries) {
        $relative = if ($Manifest.PSObject.Properties.Name -contains 'files') { Get-ManagedEntryRelative $Manifest $entry } else { ([string]$entry.path).Replace('/', '\') }
        $source = Join-Path $SourceRoot $relative
        $destination = Join-Path $DestinationRoot $relative
        Assert-PathUnderRoot $SourceRoot $source | Out-Null
        Assert-PathUnderRoot $DestinationRoot $destination | Out-Null
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            $missing += $entry
            $completed++
            if ($ProgressStep -gt 0 -and (Test-UpdateProgressCheckpoint $completed $entries.Count)) {
                Write-UpdateProgress -Step $ProgressStep -StepTotal $ProgressStepTotal -Completed $completed -Total $entries.Count -Label $ProgressLabel -Detail $relative
            }
            continue
        }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination -Force | Out-Null
        $existing += $entry
        $completed++
        if ($ProgressStep -gt 0 -and (Test-UpdateProgressCheckpoint $completed $entries.Count)) {
            Write-UpdateProgress -Step $ProgressStep -StepTotal $ProgressStepTotal -Completed $completed -Total $entries.Count -Label $ProgressLabel -Detail $relative
        }
    }
    if ($ProgressStep -gt 0 -and $entries.Count -eq 0) {
        Write-UpdateProgress -Step $ProgressStep -StepTotal $ProgressStepTotal -Completed 0 -Total 0 -Label $ProgressLabel
    }
    return [pscustomobject]@{ existing = $existing; missing = $missing }
}

function Copy-ManagedPayload {
    param(
        [Parameter(Mandatory)][string]$SourceRoot,
        [Parameter(Mandatory)][string]$DestinationRoot,
        [Parameter(Mandatory)]$Manifest,
        [int]$ProgressStep = 0,
        [int]$ProgressStepTotal = 1,
        [string]$ProgressLabel = 'Updating application files'
    )
    $entries = @(Get-ManifestEntries $Manifest)
    $completed = 0
    foreach ($entry in $entries) {
        $relative = Get-ManagedEntryRelative $Manifest $entry
        $source = Join-Path $SourceRoot $relative
        $destination = Join-Path $DestinationRoot $relative
        Assert-PathUnderRoot $SourceRoot $source | Out-Null
        Assert-PathUnderRoot $DestinationRoot $destination | Out-Null
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination -Force | Out-Null
        $completed++
        if ($ProgressStep -gt 0 -and (Test-UpdateProgressCheckpoint $completed $entries.Count)) {
            Write-UpdateProgress -Step $ProgressStep -StepTotal $ProgressStepTotal -Completed $completed -Total $entries.Count -Label $ProgressLabel -Detail $relative
        }
    }
    if ($ProgressStep -gt 0 -and $entries.Count -eq 0) {
        Write-UpdateProgress -Step $ProgressStep -StepTotal $ProgressStepTotal -Completed 0 -Total 0 -Label $ProgressLabel
    }
}

function Restore-ManagedPayload {
    param([Parameter(Mandatory)][string]$DestinationRoot, [Parameter(Mandatory)][string]$BackupRoot, [Parameter(Mandatory)]$Manifest)
    foreach ($entry in @(Get-ManifestEntries $Manifest)) {
        $relative = if ($Manifest.PSObject.Properties.Name -contains 'files') { Get-ManagedEntryRelative $Manifest $entry } else { ([string]$entry.path).Replace('/', '\') }
        $backup = Join-Path $BackupRoot $relative
        $destination = Join-Path $DestinationRoot $relative
        Assert-PathUnderRoot $DestinationRoot $destination | Out-Null
        if (Test-Path -LiteralPath $backup -PathType Leaf) {
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
            Copy-Item -LiteralPath $backup -Destination $destination -Force
        } elseif (Test-Path -LiteralPath $destination -PathType Leaf) {
            Remove-Item -LiteralPath $destination -Force
        }
    }
}

function Remove-RetiredManagedPayload {
    param(
        [Parameter(Mandatory)][string]$DestinationRoot,
        [Parameter(Mandatory)]$PreviousManifest,
        [Parameter(Mandatory)]$TargetManifest,
        [int]$ProgressStep = 0,
        [int]$ProgressStepTotal = 1,
        [string]$ProgressLabel = 'Cleaning up'
    )
    $targetPaths = @{}
    foreach ($entry in @(Get-ManifestEntries $TargetManifest)) {
        $relative = Get-ManagedEntryRelative $TargetManifest $entry
        $targetPaths[$relative.ToLowerInvariant()] = $true
    }
    $entries = @(Get-ManifestEntries $PreviousManifest)
    $completed = 0
    foreach ($entry in $entries) {
        $relative = Get-ManagedEntryRelative $PreviousManifest $entry
        if (-not $targetPaths.ContainsKey($relative.ToLowerInvariant())) {
            $candidate = Join-Path $DestinationRoot $relative
            Assert-PathUnderRoot $DestinationRoot $candidate | Out-Null
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { Remove-Item -LiteralPath $candidate -Force }
        }
        $completed++
        if ($ProgressStep -gt 0 -and (Test-UpdateProgressCheckpoint $completed $entries.Count)) {
            Write-UpdateProgress -Step $ProgressStep -StepTotal $ProgressStepTotal -Completed $completed -Total $entries.Count -Label $ProgressLabel -Detail $relative
        }
    }
    if ($ProgressStep -gt 0 -and $entries.Count -eq 0) {
        Write-UpdateProgress -Step $ProgressStep -StepTotal $ProgressStepTotal -Completed 0 -Total 0 -Label $ProgressLabel
    }
}

function Write-UpdateManifestAtomically {
    param([Parameter(Mandatory)][string]$DestinationPath, [Parameter(Mandatory)]$Manifest)
    $root = Split-Path -Parent $DestinationPath
    Assert-PathUnderRoot $root $DestinationPath | Out-Null
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $temp = Join-Path $root ('.update-payload-manifest-' + $PID + '-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $serialized = [ordered]@{
        format = [int]$Manifest.format
        kind = [string]$Manifest.kind
        version = [string]$Manifest.version
        commit = ([string]$Manifest.commit).ToLowerInvariant()
        managedRoots = @($Manifest.managedRoots)
        files = @($Manifest.files)
    } | ConvertTo-Json -Depth 10
    try {
        [IO.File]::WriteAllText($temp, $serialized, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temp -Destination $DestinationPath -Force
    }
    finally {
        if (Test-Path -LiteralPath $temp -PathType Leaf) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
    }
}

function Backup-InstalledUpdateManifest {
    param([Parameter(Mandatory)][string]$InstalledPath, [Parameter(Mandatory)][string]$RollbackRoot)
    $installedRoot = Split-Path -Parent $InstalledPath
    Assert-PathUnderRoot $installedRoot $InstalledPath | Out-Null
    $backupPath = Join-Path $RollbackRoot 'update-payload-manifest.json'
    $exists = Test-Path -LiteralPath $InstalledPath -PathType Leaf
    New-Item -ItemType Directory -Force -Path $RollbackRoot | Out-Null
    if ($exists) { Copy-Item -LiteralPath $InstalledPath -Destination $backupPath -Force }
    return [pscustomobject]@{ exists = $exists; backupPath = $backupPath }
}

function Restore-InstalledUpdateManifest {
    param([Parameter(Mandatory)][string]$InstalledPath, [Parameter(Mandatory)]$Backup)
    $installedRoot = Split-Path -Parent $InstalledPath
    Assert-PathUnderRoot $installedRoot $InstalledPath | Out-Null
    if ($Backup.exists -and (Test-Path -LiteralPath $Backup.backupPath -PathType Leaf)) {
        Copy-Item -LiteralPath $Backup.backupPath -Destination $InstalledPath -Force
    }
    elseif (Test-Path -LiteralPath $InstalledPath -PathType Leaf) {
        Remove-Item -LiteralPath $InstalledPath -Force
    }
}
