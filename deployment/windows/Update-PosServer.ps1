[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PayloadRoot,
    [ValidateSet('Core', 'RuntimeTransition')][string]$Mode = 'Core',
    [string]$ProgramFilesRoot = 'C:\Program Files\POSApp',
    [string]$ProgramDataRoot = 'C:\ProgramData\POSApp',
    [string]$ResultFile,
    [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'InstallerUpdateState.ps1')
. (Join-Path $PSScriptRoot 'ServerLayerState.ps1')

$appId = '{E99DB275-DDA0-43A0-95CD-7AE07185122C}'
$metadataPath = Join-Path $ProgramDataRoot 'install.json'
$logDir = Join-Path $ProgramDataRoot 'logs'
$updateLog = Join-Path $logDir 'update-error.txt'
$backupDir = Join-Path $ProgramDataRoot 'backups'
$backupEnv = Join-Path $ProgramDataRoot 'config\backup.env'
$posEnv = Join-Path $ProgramDataRoot 'config\pos.env'
$rollbackRoot = Join-Path $ProgramDataRoot "tmp\update-rollback-$PID"
$installedManifestPath = Join-Path $ProgramFilesRoot 'update-payload-manifest.json'
$installedRuntimePath = Join-Path $ProgramFilesRoot 'server-installed-runtime.json'
$phase = 'preflight'
$commitComplete = $false

function Write-Utf8NoBom([string]$Path, [string]$Contents) {
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    [IO.File]::WriteAllText($Path, $Contents, [Text.UTF8Encoding]::new($false))
}
function Write-Result([hashtable]$Value) {
    $json = $Value | ConvertTo-Json -Depth 8
    if ($ResultFile) { Write-Utf8NoBom $ResultFile $json }
    Write-Output $json
}
function Fail([string]$Message, [string]$State = 'blocked_incomplete') {
    $result = [ordered]@{ state = $State; updated = $false; mutates = $false; phase = $phase; error = $Message; logPath = $updateLog }
    try { if (-not $WhatIf) { Write-Utf8NoBom $updateLog (($result | ConvertTo-Json -Depth 8) + "`r`n") } } catch {}
    Write-Result $result
    throw $Message
}
function Read-Json([string]$Path) {
    try { return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json } catch { throw "Invalid JSON: $Path" }
}
function Get-ServiceOwnerState {
    $service = Get-Service -Name 'POSApp' -ErrorAction SilentlyContinue
    if (-not $service) { return 'missing' }
    $serviceImagePath = Get-ServiceImagePath 'POSApp'
    $registeredExecutable = Get-RegisteredExecutablePath $serviceImagePath
    $expectedNssm = Join-Path $ProgramDataRoot 'tmp\nssm\nssm-2.24\win64\nssm.exe'
    if (-not (Test-SamePath $registeredExecutable $expectedNssm)) { return 'invalid' }
    if (-not (Test-Path -LiteralPath $expectedNssm -PathType Leaf)) { return 'invalid' }
    $parameters = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Services\POSApp\Parameters' -ErrorAction SilentlyContinue
    if (-not $parameters) { return 'invalid' }
    $node = Join-Path $ProgramFilesRoot 'runtime\node\node.exe'
    $script = Join-Path $ProgramFilesRoot 'server.js'
    if (-not (Test-SamePath ([string]$parameters.Application) $node) -or -not (Test-SamePath ([string]$parameters.AppDirectory) $ProgramFilesRoot) -or [string]$parameters.AppParameters -ne ('"' + $script + '"')) { return 'invalid' }
    return 'owned'
}
function Wait-PosHealth([int]$Port, [string]$ExpectedVersion, [string]$ExpectedCommit) {
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
            if ($health.status -eq 'ok' -and $health.db -eq 'connected' -and $health.release.version -eq $ExpectedVersion -and $health.release.commit -eq $ExpectedCommit) { return $health }
        } catch {}
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "POS health/schema verify failed for release $ExpectedVersion/$ExpectedCommit."
}
function Start-Pos {
    $service = Get-Service -Name 'POSApp' -ErrorAction Stop
    if ($service.Status -ne 'Running') { Start-Service -Name 'POSApp' -ErrorAction Stop; $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(30)) }
}
function Stop-Pos {
    $service = Get-Service -Name 'POSApp' -ErrorAction SilentlyContinue
    if ($service -and $service.Status -ne 'Stopped') { Stop-Service -Name 'POSApp' -Force -ErrorAction Stop; $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) }
}
function Invoke-Node([string]$Node, [string]$Script, [string[]]$Arguments) {
    & $Node $Script @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Target operation failed with exit code ${LASTEXITCODE}: $Script" }
}
function Invoke-TargetNode([string]$Node, [string]$Script, [string[]]$Arguments) {
    $previousNodePath = [Environment]::GetEnvironmentVariable('NODE_PATH', 'Process')
    try {
        $dependencyRoot = if ($Mode -eq 'RuntimeTransition') { Join-Path $PayloadRoot 'node_modules' } else { Join-Path $ProgramFilesRoot 'node_modules' }
        [Environment]::SetEnvironmentVariable('NODE_PATH', $dependencyRoot, 'Process')
        Invoke-Node $Node $Script $Arguments
    }
    finally { [Environment]::SetEnvironmentVariable('NODE_PATH', $previousNodePath, 'Process') }
}
function Get-ApplicationOnlyManifest($Manifest) {
    if ($null -eq $Manifest) { return $null }
    $roots = @($Manifest.managedRoots | Where-Object { [string]$_ -ne 'node_modules' })
    $files = @($Manifest.files | Where-Object { ([string]$_.path).Replace('\', '/') -ne 'node_modules' -and -not ([string]$_.path).Replace('\', '/').StartsWith('node_modules/', [StringComparison]::OrdinalIgnoreCase) })
    return [pscustomobject]@{ format = 1; kind = [string]$Manifest.kind; version = [string]$Manifest.version; commit = [string]$Manifest.commit; managedRoots = $roots; files = $files }
}
function Read-InstalledServerManifest([switch]$ApplicationOnly) {
    if (-not (Test-Path -LiteralPath $installedManifestPath -PathType Leaf)) { return $null }
    try { $identity = Get-Content -LiteralPath $installedManifestPath -Raw | ConvertFrom-Json }
    catch { throw 'Installed update manifest is invalid JSON.' }
    if ([string]$identity.kind -notin @('server-update', 'server-update-core', 'server-update-runtime')) { throw 'Installed update manifest kind is invalid.' }
    $source = if ($ApplicationOnly) { Get-ApplicationOnlyManifest $identity } else { $identity }
    return Read-UpdateManifest -Path $source -PayloadRoot $ProgramFilesRoot -ExpectedKind ([string]$identity.kind) -ProgressStep 1 -ProgressStepTotal 8 -ProgressLabel 'Verifying installed files'
}
function Write-MetadataAtomically($Metadata) {
    $temp = "$metadataPath.$PID.tmp"
    Write-Utf8NoBom $temp ($Metadata | ConvertTo-Json -Depth 8)
    Move-Item -LiteralPath $temp -Destination $metadataPath -Force
}

try {
    # preflight
    $phase = 'preflight'
    Write-UpdateProgress -Step 1 -StepTotal 8 -Completed 0 -Total 0 -Label 'Verifying update package'
    if (-not (Test-Path -LiteralPath $metadataPath)) { Fail 'Packaged POS installation metadata is missing; use the fresh server installer.' 'blocked_fresh' }
    if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) { Fail 'Packaged POS installation metadata is not a file.' 'blocked_incomplete' }
    if (-not (Test-Path -LiteralPath $PayloadRoot -PathType Container)) { Fail 'Update payload root is missing.' }
    try { $metadata = Read-Json $metadataPath }
    catch { Fail "POSAPP ownership metadata is invalid: $($_.Exception.Message)" 'blocked_incomplete' }
    $metadataProperties = @($metadata.PSObject.Properties.Name)
    if ([string]$metadata.appId -ne $appId -or $metadataProperties -notcontains 'release' -or $null -eq $metadata.release) { Fail 'POSAPP ownership metadata is invalid; refusing an ambiguous installation.' 'blocked_ownership' }
    $metadataReleaseProperties = @($metadata.release.PSObject.Properties.Name)
    if ($metadataReleaseProperties -notcontains 'version' -or $metadataReleaseProperties -notcontains 'commit') { Fail 'POSAPP release metadata is incomplete.' 'blocked_incomplete' }
    $installedRelease = [pscustomobject]@{ version = [string]$metadata.release.version; commit = [string]$metadata.release.commit; payloadKind = 'server' }
    $installedPath = Join-Path $ProgramFilesRoot 'release.json'
    if (-not (Test-Path -LiteralPath $installedPath -PathType Leaf)) { Fail 'Installed release metadata is missing.' 'blocked_incomplete' }
    $installedFileRelease = Read-Json $installedPath
    $installedFileReleaseProperties = @($installedFileRelease.PSObject.Properties.Name)
    if ($installedFileReleaseProperties -notcontains 'version' -or $installedFileReleaseProperties -notcontains 'commit') { Fail 'Installed release metadata is incomplete.' 'blocked_incomplete' }
    if ([string]$installedFileRelease.version -ne $installedRelease.version -or [string]$installedFileRelease.commit -ne $installedRelease.commit) { Fail 'ProgramFiles and ProgramData release identities disagree.' 'blocked_ownership' }
    $targetKind = if ($Mode -eq 'RuntimeTransition') { 'server-update-runtime' } else { 'server-update-core' }
    $targetRelease = Read-ReleaseIdentity (Join-Path $PayloadRoot 'release.json') $targetKind
    $state = Compare-PackagedRelease $installedRelease $targetRelease
    if ($state.state -ne 'update') {
        $blocked = [ordered]@{ state = $state.state; updated = $false; mutates = $false; installed = $installedRelease; target = $targetRelease; ports = [ordered]@{ pos = [int]$metadata.posPort; database = [int]$metadata.databasePort; phpMyAdmin = [int]$metadata.phpMyAdminPort }; logPath = $updateLog }
        Write-Result $blocked
        if ($state.state -ne 'current') { throw "Packaged POS update refused: $($state.state)." }
        return
    }
    foreach ($path in @($posEnv, $backupEnv)) { if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { Fail "Protected configuration is missing: $path" } }
    $manifestPath = Join-Path $PayloadRoot 'update-payload-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { Fail 'Update payload manifest is missing.' }
    $manifest = Read-UpdateManifest -Path $manifestPath -PayloadRoot $PayloadRoot -ExpectedKind $targetKind -ProgressStep 1 -ProgressStepTotal 8 -ProgressLabel 'Verifying update package'
    if ($manifest.version -ne $targetRelease.version -or $manifest.commit -ne $targetRelease.commit) { Fail 'Update payload manifest identity does not match its release.' }
    $dependencyManifest = Read-ServerDependencyManifest (Join-Path $PayloadRoot 'server-dependency-manifest.json')
    if ($Mode -eq 'RuntimeTransition') {
        Assert-ServerDependencyInventory $PayloadRoot $dependencyManifest | Out-Null
    } else {
        $installedRuntime = Read-ServerInstalledRuntime $installedRuntimePath
        if ($null -eq $installedRuntime) {
            try { Assert-ServerDependencyInventory $ProgramFilesRoot $dependencyManifest | Out-Null }
            catch { Fail "Server runtime transition required: $($_.Exception.Message)" 'runtime_transition_required' }
        } elseif ([string]$installedRuntime.dependenciesId -ne [string]$dependencyManifest.dependencies.id) {
            Fail 'Server runtime transition required: installed dependencies do not match this application update.' 'runtime_transition_required'
        }
    }
    $oldManifest = $null
    if (-not $WhatIf) {
        Write-UpdateProgress -Step 1 -StepTotal 8 -Completed 0 -Total 0 -Label 'Verifying installed files'
        $phase = 'rollback-copy'
        if (Test-Path -LiteralPath $installedManifestPath -PathType Leaf) {
            try { $oldManifest = Read-InstalledServerManifest -ApplicationOnly:($Mode -eq 'Core') }
            catch { Fail "Installed update manifest is invalid: $($_.Exception.Message)" 'blocked_incomplete' }
        }
        elseif (Test-Path -LiteralPath $installedManifestPath) { Fail 'Installed update manifest is not a file.' 'blocked_incomplete' }
        $phase = 'preflight'
    }
    if ($WhatIf) {
        Write-Result ([ordered]@{ state = 'update'; updated = $false; mutates = $false; mode = $Mode; installed = $installedRelease; target = $targetRelease; posPort = [int]$metadata.posPort; databasePort = [int]$metadata.databasePort; phpMyAdminPort = [int]$metadata.phpMyAdminPort; managedFiles = @($manifest.files).Count; dependenciesId = [string]$dependencyManifest.dependencies.id; logPath = $updateLog })
        return
    }
    if ((Get-ServiceOwnerState) -ne 'owned') { Fail 'POSApp service ownership is not exact; refusing to modify an unknown service.' 'blocked_ownership' }
    New-Item -ItemType Directory -Force -Path $logDir, $backupDir, (Split-Path -Parent $rollbackRoot) | Out-Null
    $phase = 'database-backup'
    Write-UpdateProgress -Step 2 -StepTotal 8 -Completed 0 -Total 0 -Label 'Backing up database'
    $nodeExe = Join-Path $ProgramFilesRoot 'runtime\node\node.exe'
    if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) { Fail 'Installed private Node runtime is missing.' }
    $backupFile = Join-Path $backupDir "update-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))-$PID.sql.gz"
    $env:POSAPP_ENV_FILE = $backupEnv
    Invoke-TargetNode $nodeExe (Join-Path $PayloadRoot 'scripts\db-backup.js') @('--output', $backupFile)
    if (-not (Test-Path -LiteralPath $backupFile -PathType Leaf) -or -not (Test-Path -LiteralPath "$backupFile.sha256" -PathType Leaf)) { throw 'Database backup or checksum was not produced.' }
    $backupHash = ((Get-Content -Raw -LiteralPath "$backupFile.sha256") -split '\s+')[0]
    if ($backupHash -notmatch '^[0-9a-fA-F]{64}$') { throw 'Database backup checksum is invalid.' }
    $backupHash = $backupHash.ToLowerInvariant()
    $actualBackupHash = (Get-FileHash -LiteralPath $backupFile -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualBackupHash -ne $backupHash) { throw 'Database backup checksum does not match the archive.' }
    $phase = 'rollback-copy'
    Write-UpdateProgress -Step 3 -StepTotal 8 -Completed 0 -Total 0 -Label 'Preparing rollback'
    $effectiveOldManifest = if ($Mode -eq 'Core') { Get-ApplicationOnlyManifest $oldManifest } else { $oldManifest }
    $effectiveTargetManifest = if ($Mode -eq 'Core') { Get-ApplicationOnlyManifest $manifest } else { $manifest }
    $rollbackManifest = @(Get-ManagedFileUnion $effectiveOldManifest $effectiveTargetManifest)
    $rollback = Backup-ManagedPayload -SourceRoot $ProgramFilesRoot -DestinationRoot $rollbackRoot -Manifest $rollbackManifest -ProgressStep 3 -ProgressStepTotal 8 -ProgressLabel 'Preparing rollback'
    $manifestBackup = Backup-InstalledUpdateManifest $installedManifestPath $rollbackRoot
    $runtimeBackup = Backup-InstalledUpdateManifest $installedRuntimePath (Join-Path $rollbackRoot 'runtime-attestation')
    $metadataBackupPath = Join-Path $rollbackRoot 'install.json'
    $metadataExisted = Test-Path -LiteralPath $metadataPath -PathType Leaf
    if ($metadataExisted) { Copy-Item -LiteralPath $metadataPath -Destination $metadataBackupPath -Force }
    $phase = 'stop POSApp'
    Write-UpdateProgress -Step 4 -StepTotal 8 -Completed 0 -Total 0 -Label 'Applying database changes'
    Stop-Pos
    try {
        $phase = 'target migrations'
        Invoke-TargetNode $nodeExe (Join-Path $PayloadRoot 'deployment\tools\run-pending-migrations.js') @('--env', $backupEnv)
        $phase = 'managed swap'
        Copy-ManagedPayload -SourceRoot $PayloadRoot -DestinationRoot $ProgramFilesRoot -Manifest $effectiveTargetManifest -ProgressStep 5 -ProgressStepTotal 8 -ProgressLabel 'Updating application files'
        $phase = 'start POSApp'
        Write-UpdateProgress -Step 6 -StepTotal 8 -Completed 0 -Total 0 -Label 'Starting POSAPP'
        Start-Pos
        $phase = 'health/schema verify'
        Write-UpdateProgress -Step 7 -StepTotal 8 -Completed 0 -Total 0 -Label 'Verifying POSAPP'
        $health = Wait-PosHealth ([int]$metadata.posPort) $targetRelease.version $targetRelease.commit
        $phase = 'stale cleanup'
        Write-UpdateProgress -Step 8 -StepTotal 8 -Completed 0 -Total 0 -Label 'Cleaning up'
        if ($null -ne $effectiveOldManifest) { Remove-RetiredManagedPayload -DestinationRoot $ProgramFilesRoot -PreviousManifest $effectiveOldManifest -TargetManifest $effectiveTargetManifest -ProgressStep 8 -ProgressStepTotal 8 -ProgressLabel 'Cleaning up' }
        $phase = 'metadata write'
        $newMetadata = [ordered]@{ appId = $appId; restaurant = [string]$metadata.restaurant; posPort = [int]$metadata.posPort; databasePort = [int]$metadata.databasePort; phpMyAdminPort = [int]$metadata.phpMyAdminPort; release = [ordered]@{ version = $targetRelease.version; commit = $targetRelease.commit; schemaVersion = $targetRelease.schemaVersion; spoolerVersion = $targetRelease.spoolerVersion } }
        Write-MetadataAtomically $newMetadata
        Write-UpdateManifestAtomically $installedManifestPath $effectiveTargetManifest
        Write-ServerInstalledRuntime $installedRuntimePath $dependencyManifest | Out-Null
        $commitComplete = $true
        $phase = 'cleanup'
        Remove-Item -LiteralPath $rollbackRoot -Recurse -Force -ErrorAction SilentlyContinue
        Write-Result ([ordered]@{ state = 'update'; updated = $true; mutates = $true; mode = $Mode; installed = $installedRelease; target = $targetRelease; dependenciesId = [string]$dependencyManifest.dependencies.id; backupPath = $backupFile; backupSha256 = $backupHash; health = $health; logPath = $updateLog })
    } catch {
        $failure = $_
        if (-not $commitComplete) {
            try { Stop-Pos } catch {}
            try { Restore-ManagedPayload $ProgramFilesRoot $rollbackRoot $rollbackManifest } catch {}
            try { Restore-InstalledUpdateManifest $installedManifestPath $manifestBackup } catch {}
            try { Restore-InstalledUpdateManifest $installedRuntimePath $runtimeBackup } catch {}
            try {
                if ($metadataExisted -and (Test-Path -LiteralPath $metadataBackupPath -PathType Leaf)) { Copy-Item -LiteralPath $metadataBackupPath -Destination $metadataPath -Force }
                elseif (Test-Path -LiteralPath $metadataPath -PathType Leaf) { Remove-Item -LiteralPath $metadataPath -Force }
            } catch {}
            try { Start-Pos } catch {}
        }
        throw $failure
    }
} catch {
    $message = $_.Exception.Message
    try { Write-Utf8NoBom $updateLog ("[$([DateTime]::UtcNow.ToString('o'))] phase=$phase $message`r`n") } catch {}
    if ($ResultFile -and -not (Test-Path -LiteralPath $ResultFile)) { try { Write-Utf8NoBom $ResultFile ("state=failed`r`nphase=$phase`r`n$message") } catch {} }
    throw
}
