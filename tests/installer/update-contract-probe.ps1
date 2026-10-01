[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$helper = Join-Path $repo 'deployment\windows\InstallerUpdateState.ps1'
if (-not (Test-Path -LiteralPath $helper)) { throw 'InstallerUpdateState.ps1 is missing.' }
. $helper

function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Identity([string]$Version, [string]$Commit, [string]$Kind = 'server-update') {
    [pscustomobject]@{ version = $Version; commit = $Commit; payloadKind = $Kind }
}

$a = Identity '1.0.0' ('a' * 40)
$b = Identity '1.0.1' ('b' * 40)
Assert ((Compare-PackagedRelease $a $b).state -eq 'update') 'Expected newer target to be update.'
Assert ((Compare-PackagedRelease $b $b).state -eq 'current') 'Expected matching target to be current.'
Assert ((Compare-PackagedRelease (Identity '1.0.1' ('a' * 40)) $b).state -eq 'blocked_version_collision') 'Expected same-version collision to block.'
Assert ((Compare-PackagedRelease (Identity '1.0.2' ('a' * 40)) $b).state -eq 'blocked_downgrade') 'Expected downgrade to block.'

$root = Join-Path ([IO.Path]::GetTempPath()) "pos-update-probe-$PID"
if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
try {
    $source = Join-Path $root 'source'; $target = Join-Path $root 'target'
    $backup = Join-Path $root 'backup'; $programData = Join-Path $root 'programdata'
    New-Item -ItemType Directory -Force -Path $source, $target, $backup, $programData | Out-Null
    Set-Content -LiteralPath (Join-Path $source 'app.js') -Value 'old' -NoNewline
    Set-Content -LiteralPath (Join-Path $target 'app.js') -Value 'new' -NoNewline
    Set-Content -LiteralPath (Join-Path $programData 'keep.txt') -Value 'keep' -NoNewline
    $targetFile = Join-Path $target 'app.js'
    $targetHash = Get-UpdateFileSha256 $targetFile
    $manifest = [pscustomobject]@{
        format = 1; kind = 'server-update'; version = '1.0.1'; commit = ('b' * 40)
        managedRoots = @('app.js')
        files = @([pscustomobject]@{ path = 'app.js'; bytes = (Get-Item -LiteralPath $targetFile).Length; sha256 = $targetHash })
    }
    $validated = Read-UpdateManifest $manifest $target 'server-update'
    Assert ($validated.managedRoots.Count -eq 1) 'Expected manifest roots.'
    Assert ((Assert-PathUnderRoot $target (Join-Path $target 'app.js')) -eq $true) 'Expected in-root path.'
    try { Assert-PathUnderRoot $target (Join-Path $target '..\programdata\keep.txt'); throw 'Traversal was not rejected.' } catch { if ($_.Exception.Message -eq 'Traversal was not rejected.') { throw } }

    # A payload whose bytes do not match its manifest must be refused before anything
    # is copied over a working install. The two guards are separate and must be
    # provoked separately: tampering that also changes the length is caught by the
    # size check, so it proves nothing about the digest.
    Set-Content -LiteralPath $targetFile -Value 'NEW' -NoNewline
    Assert ((Get-Item -LiteralPath $targetFile).Length -eq $manifest.files[0].bytes) 'Hash case must keep the manifest length.'
    try { Read-UpdateManifest $manifest $target 'server-update' | Out-Null; throw 'Manifest hash mismatch was not rejected.' } catch { if ($_.Exception.Message -eq 'Manifest hash mismatch was not rejected.') { throw } }
    Set-Content -LiteralPath $targetFile -Value 'new' -NoNewline
    # Size can only be isolated the other way round: leave the bytes alone so the
    # digest still matches, and let the manifest lie about the length.
    $wrongSize = [pscustomobject]@{
        format = 1; kind = 'server-update'; version = '1.0.1'; commit = ('b' * 40)
        managedRoots = @('app.js')
        files = @([pscustomobject]@{ path = 'app.js'; bytes = ((Get-Item -LiteralPath $targetFile).Length + 1); sha256 = $targetHash })
    }
    try { Read-UpdateManifest $wrongSize $target 'server-update' | Out-Null; throw 'Manifest size mismatch was not rejected.' } catch { if ($_.Exception.Message -eq 'Manifest size mismatch was not rejected.') { throw } }

    # A manifest may only claim files inside the roots it declares; otherwise an
    # update payload could write outside the tree it owns.
    $outsideRoot = [pscustomobject]@{
        format = 1; kind = 'server-update'; version = '1.0.1'; commit = ('b' * 40)
        managedRoots = @('other')
        files = @([pscustomobject]@{ path = 'app.js'; bytes = (Get-Item -LiteralPath $targetFile).Length; sha256 = $targetHash })
    }
    try { Read-UpdateManifest $outsideRoot $target 'server-update' | Out-Null; throw 'Managed-root escape was not rejected.' } catch { if ($_.Exception.Message -eq 'Managed-root escape was not rejected.') { throw } }
    $paths = @([pscustomobject]@{ path = 'app.js' })
    Backup-ManagedPayload $source $backup $paths
    Copy-Item -LiteralPath $targetFile -Destination (Join-Path $source 'app.js') -Force
    Restore-ManagedPayload $source $backup $paths
    Assert ((Get-Content -Raw -LiteralPath (Join-Path $source 'app.js')) -eq 'old') 'Restore did not return original content.'
    Assert ((Get-Content -Raw -LiteralPath (Join-Path $programData 'keep.txt')) -eq 'keep') 'Unrelated data changed.'
    # Model update A -> B: B retires one owned file and introduces a target-only file.
    # Rollback must span the union of both manifests, not just the target's files -
    # otherwise a failed update leaves the retired file gone and the new one behind.
    $programRoot = Join-Path $root 'program-files'
    New-Item -ItemType Directory -Force -Path (Join-Path $programRoot 'managed') | Out-Null
    Set-Content -LiteralPath (Join-Path $programRoot 'managed\keep.txt') -Value 'A-keep' -NoNewline
    Set-Content -LiteralPath (Join-Path $programRoot 'managed\retired.txt') -Value 'A-retired' -NoNewline
    Set-Content -LiteralPath (Join-Path $programRoot 'unmanaged.txt') -Value 'leave-me' -NoNewline
    $targetRoot = Join-Path $root 'target-b'
    New-Item -ItemType Directory -Force -Path (Join-Path $targetRoot 'managed') | Out-Null
    Set-Content -LiteralPath (Join-Path $targetRoot 'managed\keep.txt') -Value 'B-keep' -NoNewline
    Set-Content -LiteralPath (Join-Path $targetRoot 'managed\target-only.txt') -Value 'B-only' -NoNewline
    $oldManifest = [pscustomobject]@{ format = 1; kind = 'server-update'; version = '1.0.0'; commit = ('a' * 40); managedRoots = @('managed'); files = @(
        [pscustomobject]@{ path = 'managed/keep.txt' },
        [pscustomobject]@{ path = 'managed/retired.txt' }
    ) }
    $newManifest = [pscustomobject]@{ format = 1; kind = 'server-update'; version = '1.0.1'; commit = ('b' * 40); managedRoots = @('managed'); files = @(
        [pscustomobject]@{ path = 'managed/keep.txt' },
        [pscustomobject]@{ path = 'managed/target-only.txt' }
    ) }
    $union = @(Get-ManagedFileUnion $oldManifest $newManifest)
    Assert ($union.Count -eq 3) 'Rollback union must contain retired, retained, and target-only files.'
    $unionBackup = Join-Path $root 'union-backup'
    Backup-ManagedPayload $programRoot $unionBackup $union | Out-Null
    try {
        Copy-Item -LiteralPath (Join-Path $targetRoot 'managed\keep.txt') -Destination (Join-Path $programRoot 'managed\keep.txt') -Force
        Copy-Item -LiteralPath (Join-Path $targetRoot 'managed\target-only.txt') -Destination (Join-Path $programRoot 'managed\target-only.txt') -Force
        Remove-Item -LiteralPath (Join-Path $programRoot 'managed\retired.txt') -Force
        throw 'forced swap failure after target-only copy'
    }
    catch { Restore-ManagedPayload $programRoot $unionBackup $union }
    Assert ((Get-Content -Raw -LiteralPath (Join-Path $programRoot 'managed\keep.txt')) -eq 'A-keep') 'Union rollback did not restore retained file.'
    Assert ((Get-Content -Raw -LiteralPath (Join-Path $programRoot 'managed\retired.txt')) -eq 'A-retired') 'Union rollback did not restore retired file.'
    Assert (-not (Test-Path -LiteralPath (Join-Path $programRoot 'managed\target-only.txt'))) 'Union rollback did not remove target-only file.'

    # The retired file is deliberately left in place by the rollback above, so this
    # proves the success-path cleanup deletes it - and touches nothing unmanaged.
    Remove-RetiredManagedPayload $programRoot $oldManifest $newManifest
    Assert (-not (Test-Path -LiteralPath (Join-Path $programRoot 'managed\retired.txt'))) 'Successful update did not remove retired owned file.'
    Assert ((Get-Content -Raw -LiteralPath (Join-Path $programRoot 'unmanaged.txt')) -eq 'leave-me') 'Successful update removed unmanaged file.'

    $expectedNssm = 'C:\ProgramData\POSApp\tmp\nssm\nssm-2.24\win64\nssm.exe'
    Assert ((Test-SamePath (Get-RegisteredExecutablePath ('"' + $expectedNssm + '" -k run')) $expectedNssm)) 'Quoted ImagePath was not parsed exactly.'
    Assert (-not (Test-SamePath (Get-RegisteredExecutablePath ($expectedNssm + '.evil -k run')) $expectedNssm)) 'ImagePath lookalike was accepted.'
}
finally { if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force } }
Write-Output 'server update contract probe: PASS'
