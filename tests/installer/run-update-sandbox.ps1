[CmdletBinding()]
param(
    [string]$BaselineCommit = 'e6938caa',
    [string]$ResultDirectory,
    [switch]$KeepSandboxOnFailure,
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ([string]::IsNullOrWhiteSpace($ResultDirectory)) { $ResultDirectory = Join-Path $PSScriptRoot 'results' }
$resultDirectory = [IO.Path]::GetFullPath($ResultDirectory)
$tempCandidates = @('C:\tmp', (Join-Path $env:SystemRoot 'Temp'), [IO.Path]::GetTempPath())
$tempRoot = @($tempCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') } | Sort-Object Length | Select-Object -First 1)
if ([string]::IsNullOrWhiteSpace($tempRoot)) { throw 'No writable temporary directory is available for the disposable baseline worktree.' }
$sandboxId = [guid]::NewGuid().ToString()
$worktree = $null
$bundle = $null
$sandboxStarted = $false
$failure = $null
$hostSummary = [ordered]@{
    phase = 'host-preflight'
    startedAt = [DateTime]::UtcNow.ToString('o')
    pending = @('Windows 10 22H2 VM', 'physical printer output')
    artifacts = [ordered]@{}
    phases = [ordered]@{}
}

function Write-Utf8NoBom([string]$Path, [string]$Contents) {
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    [IO.File]::WriteAllText($Path, $Contents, [Text.UTF8Encoding]::new($false))
}
function Read-Json([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing JSON: $Path" }
    try { return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json } catch { throw "Invalid JSON: $Path" }
}
function Quote-Argument([string]$Value) {
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}
function Invoke-Bounded([string]$FilePath, [string[]]$Arguments, [int]$TimeoutSeconds = 120) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = ($Arguments | ForEach-Object { Quote-Argument ([string]$_) }) -join ' '
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    try {
        if (-not $process.Start()) { throw "Could not start $FilePath." }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) { try { $process.Kill() } catch {}; throw "Timed out after $TimeoutSeconds seconds: $FilePath" }
        $stdout = $stdoutTask.Result
        $stderr = $stderrTask.Result
        if ($process.ExitCode -ne 0) { throw "Command failed ($($process.ExitCode)): $FilePath $($Arguments -join ' ') $stderr" }
        return [pscustomobject]@{ ExitCode = $process.ExitCode; StdOut = $stdout; StdErr = $stderr }
    }
    finally { $process.Dispose() }
}
function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Assert-HostPlatform {
    $os = Get-CimInstance Win32_OperatingSystem
    $computer = Get-CimInstance Win32_ComputerSystem
    if ([int]$os.ProductType -ne 1 -or [string]$os.OSArchitecture -notmatch '64-bit' -or [string]$computer.SystemType -notmatch '(?i)x64' -or [string]$computer.SystemType -match '(?i)arm64') { throw 'Host must be a Windows workstation on native x64.' }
    if ([int]$os.BuildNumber -lt 19045) { throw 'Host Windows build must be at least 19045.' }
    $hostSummary.os = [ordered]@{ caption = [string]$os.Caption; build = [int]$os.BuildNumber; architecture = [string]$os.OSArchitecture; productType = [int]$os.ProductType }
}
function Assert-TrackedClean {
    # The unrelated untracked posapp.7z is the only archive intentionally ignored here.
    $status = @(git -C $repo status --porcelain=v1 --untracked-files=all)
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect git status.' }
    foreach ($line in $status) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line -match '^\?\?\s+posapp\.7z$') { continue }
        if ($line -match '^\?\?\s+(?:tests/installer/results/|deployment/out/|.*\.tmp(?:/|$))') { continue }
        throw "Tracked worktree is not clean: $line"
    }
}
function Assert-PackagedCommitScope([string]$PackageCommit, [string]$CheckoutCommit) {
    if ($PackageCommit -eq $CheckoutCommit) { return }
    $ancestor = Invoke-Bounded 'git.exe' @('-C', $repo, 'merge-base', '--is-ancestor', $PackageCommit, $CheckoutCommit) 120
    $allowlist = @(
        'tests/installer/update-smoke.ps1',
        'deployment/server/POSAPP-Server.iss',
        'deployment/spooler/POSAPP-Spooler.iss',
        'backend/tests/unit/installerUpdateContract.test.js',
        'deployment/README.md',
        'tests/installer/run-update-sandbox.ps1',
        'tests/installer/update-sandbox-guest.ps1'
    )
    $changed = @(git -C $repo diff --name-only "$PackageCommit..$CheckoutCommit")
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect post-package checkout scope.' }
    foreach ($path in $changed) {
        if ($allowlist -notcontains ([string]$path).Replace('\', '/')) { throw "Checkout changed a non-harness file after packaged commit ${PackageCommit}: $path" }
    }
    $hostSummary.packagedScope = [ordered]@{ packageCommit = $PackageCommit; checkoutCommit = $CheckoutCommit; changed = $changed; allowlist = $allowlist }
}
function Assert-Command([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) { throw "$Name is required." }
    return $command.Source
}
function Read-GitFile([string]$Commit, [string]$RelativePath) {
    $output = Invoke-Bounded 'git.exe' @('-C', $repo, 'show', "$Commit`:$RelativePath")
    return $output.StdOut
}
function Normalize-Lock([string]$Text) {
    # Windows PowerShell 5.1 cannot parse npm's empty-string package key. Remove
    # only the root version and packages[""].version, then compare canonical text.
    $normalized = [regex]::Replace($Text, '(?s)\A(\s*\{\s*"name"\s*:\s*"[^"]+"\s*,\s*)"version"\s*:\s*"[^"]+"\s*,', '$1')
    $normalized = [regex]::Replace($normalized, '(?s)("packages"\s*:\s*\{\s*""\s*:\s*\{\s*"name"\s*:\s*"[^"]+"\s*,\s*)"version"\s*:\s*"[^"]+"\s*,', '$1')
    return ($normalized -replace '\s', '')
}
function Assert-LockCompatibility([string]$BaselineCommit) {
    foreach ($relative in @('package-lock.json', 'pos-spooler-printer/package-lock.json')) {
        $current = Get-Content -Raw (Join-Path $repo $relative)
        $baseline = Read-GitFile $BaselineCommit $relative
        if ((Normalize-Lock $current) -ne (Normalize-Lock $baseline)) { throw "Dependency lock graph changed outside top-level release identity: $relative" }
    }
    $currentVendor = Get-Content -Raw (Join-Path $repo 'deployment/vendor-lock.json')
    $baselineVendor = Read-GitFile $BaselineCommit 'deployment/vendor-lock.json'
    if (($currentVendor | ConvertFrom-Json | ConvertTo-Json -Depth 20 -Compress) -ne ($baselineVendor | ConvertFrom-Json | ConvertTo-Json -Depth 20 -Compress)) { throw 'deployment/vendor-lock.json differs between baseline and target.' }
}
function Assert-Release([string]$Path, [string]$Version, [string]$Commit, [string]$PayloadKind = '') {
    $release = Read-Json $Path
    if ([string]$release.version -ne $Version -or [string]$release.commit -ne $Commit) { throw "Release identity mismatch: $Path" }
    if ($PayloadKind -and [string]$release.payloadKind -ne $PayloadKind) { throw "Release payload kind mismatch: $Path" }
    return $release
}
function Assert-Artifact([string]$Name, [int64]$MaxBytes = 0) {
    $path = Join-Path $repo "deployment/out/$Name"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing artifact: $Name" }
    if ($MaxBytes -gt 0 -and (Get-Item -LiteralPath $path).Length -gt $MaxBytes) { throw "Artifact exceeds size gate: $Name" }
    $actual = Get-Sha256 $path
    $sidecarPath = "$path.sha256"
    if (-not (Test-Path -LiteralPath $sidecarPath -PathType Leaf)) { throw "Missing artifact sidecar: $Name.sha256" }
    $sidecar = ((Get-Content -Raw -LiteralPath $sidecarPath) -split '\s+')[0].Trim().ToLowerInvariant()
    if ($sidecar -ne $actual) { throw "Artifact sidecar hash mismatch: $Name" }
    $hostSummary.artifacts[$Name] = [ordered]@{ bytes = [int64](Get-Item -LiteralPath $path).Length; sha256 = $actual }
    return $path
}
function Copy-Tree([string]$Source, [string]$Destination) {
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw "Missing source tree: $Source" }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $Source -Force) { Copy-Item -LiteralPath $item.FullName -Destination $Destination -Recurse -Force }
}
function Assert-Under([string]$Root, [string]$Path) {
    $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $resolvedPath = [IO.Path]::GetFullPath($Path)
    if (-not $resolvedPath.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "Path escapes owned root: $Path" }
}
function New-Bundle([string]$CurrentServerUpdate, [string]$CurrentSpoolerCoreUpdate, [string]$CurrentSpoolerRuntimeUpdate, [string]$ServerExe, [string]$SpoolerExe, [string]$SpoolerRuntimeExe, [string]$ServerSetup, [string]$SpoolerSetup, [string]$BaselineServer, [string]$BaselineSpooler, [string]$BaselineWorktree, [string]$BaselineCommit, [string]$CurrentCommit) {
    $bundle = Join-Path $tempRoot "posapp-update-bundle-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path $bundle | Out-Null
    Copy-Tree $BaselineServer (Join-Path $bundle 'baseline\server')
    Copy-Tree $BaselineSpooler (Join-Path $bundle 'baseline\spooler')
    Copy-Tree $CurrentServerUpdate (Join-Path $bundle 'current\server-update')
    Copy-Tree $CurrentSpoolerCoreUpdate (Join-Path $bundle 'current\spooler-update-core')
    Copy-Tree $CurrentSpoolerRuntimeUpdate (Join-Path $bundle 'current\spooler-update-runtime')
    New-Item -ItemType Directory -Force -Path (Join-Path $bundle 'artifacts'), (Join-Path $bundle 'guest'), (Join-Path $bundle 'tools') | Out-Null
    foreach ($source in @($ServerExe, "$ServerExe.sha256", $SpoolerExe, "$SpoolerExe.sha256", $SpoolerRuntimeExe, "$SpoolerRuntimeExe.sha256", $ServerSetup, "$ServerSetup.sha256", $SpoolerSetup, "$SpoolerSetup.sha256")) { Copy-Item -LiteralPath $source -Destination (Join-Path $bundle 'artifacts') -Force }
    New-Item -ItemType Directory -Force -Path (Join-Path $bundle 'updaters') | Out-Null
    foreach ($relative in @('Install-PosServer.ps1', 'Repair-PosStartup.ps1', 'Remove-PosRuntime.ps1', 'Install-Spooler.ps1', 'Remove-SpoolerRuntime.ps1')) {
        Copy-Item -LiteralPath (Join-Path $BaselineWorktree "deployment/windows/$relative") -Destination (Join-Path $bundle 'baseline') -Force
    }
    foreach ($relative in @('InstallerUpdateState.ps1', 'Update-PosServer.ps1', 'Update-Spooler.ps1')) {
        Copy-Item -LiteralPath (Join-Path $repo "deployment/windows/$relative") -Destination (Join-Path $bundle 'updaters') -Force
    }
    Copy-Item -LiteralPath (Join-Path $repo 'tests/installer/update-sandbox-guest.ps1') -Destination (Join-Path $bundle 'guest') -Force
    Copy-Item -LiteralPath (Join-Path $repo 'tests/installer/update-smoke.ps1') -Destination (Join-Path $bundle 'tools') -Force
    $sentinel = [guid]::NewGuid().ToString('N')
    Write-Utf8NoBom (Join-Path $bundle 'sentinel.txt') $sentinel
    Write-Utf8NoBom (Join-Path $bundle 'identities.json') (([ordered]@{ baselineCommit = $BaselineCommit; currentCommit = $CurrentCommit }) | ConvertTo-Json -Depth 4)
    return [pscustomobject]@{ Path = $bundle; Sentinel = $sentinel }
}
function Wait-GuestMarker([string]$Path, [int]$TimeoutSeconds = 2700) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do { if (Test-Path -LiteralPath $Path -PathType Leaf) { return [int](Get-Content -Raw -LiteralPath $Path).Trim() }; Start-Sleep -Seconds 2 } while ([DateTime]::UtcNow -lt $deadline)
    throw "Guest phase marker did not arrive within $TimeoutSeconds seconds: $Path"
}
function Invoke-Guest([string]$Id, [string]$Command, [int]$TimeoutSeconds = 2700) {
    return Invoke-Bounded (Assert-Command 'wsb.exe') @('exec', '--id', $Id, '--command', $Command, '--working-directory', 'C:\bundle', '--run-as', 'System') $TimeoutSeconds
}
function Start-Sandbox([string]$Id, [string]$BundlePath, [string]$ResultsPath) {
    # The CLI XML settings disable networking and vGPU (equivalent to NetworkingEnabled="false" and vGPUEnabled="false").
    $sandboxConfig = '<Configuration><VGpu>Disable</VGpu><Networking>Disable</Networking></Configuration>'
    $start = Invoke-Bounded (Assert-Command 'wsb.exe') @('start', '--id', $Id, '--config', $sandboxConfig) 120
    $script:sandboxStarted = $true
    Invoke-Bounded (Assert-Command 'wsb.exe') @('share', '--id', $Id, '--host-path', $BundlePath, '--sandbox-path', 'C:\bundle') 120 | Out-Null # artifact share is ReadOnly="true" by omission
    Invoke-Bounded (Assert-Command 'wsb.exe') @('share', '--id', $Id, '--host-path', $ResultsPath, '--sandbox-path', 'C:\results', '--allow-write') 120 | Out-Null # result mapping is the only writable share
}
function Stop-Sandbox([string]$Id) {
    if ($script:sandboxStarted) { try { Invoke-Bounded (Assert-Command 'wsb.exe') @('stop', '--id', $Id) 120 | Out-Null } catch {} }
}

try {
    Assert-HostPlatform
    $wsb = Assert-Command 'wsb.exe'
    Assert-TrackedClean
    Assert-LockCompatibility $BaselineCommit
    $currentPackage = Read-Json (Join-Path $repo 'package.json')
    $currentSpoolerPackage = Read-Json (Join-Path $repo 'pos-spooler-printer/package.json')
    $checkoutCommit = (git -C $repo rev-parse HEAD).Trim()
    $baselinePackage = (Read-GitFile $BaselineCommit 'package.json') | ConvertFrom-Json
    $baselineSpoolerPackage = (Read-GitFile $BaselineCommit 'pos-spooler-printer/package.json') | ConvertFrom-Json
    if ([string]$baselinePackage.version -ne '1.0.0' -or [string]$baselineSpoolerPackage.version -ne '1.2.0') { throw 'Baseline commit does not expose the expected 1.0.0/1.2.0 release.' }
    if ([string]$currentPackage.version -ne '1.0.2' -or [string]$currentSpoolerPackage.version -ne '1.2.2') { throw 'Current checkout does not expose the expected 1.0.2/1.2.2 release.' }
    $currentStage = Join-Path $repo 'deployment/out/stage'
    $serverStage = Join-Path $currentStage 'server'; $spoolerStage = Join-Path $currentStage 'spooler'; $serverUpdateStage = Join-Path $currentStage 'server-update'; $spoolerCoreUpdateStage = Join-Path $currentStage 'spooler-update-core'; $spoolerRuntimeUpdateStage = Join-Path $currentStage 'spooler-update-runtime'
    foreach ($path in @($serverStage, $spoolerStage, $serverUpdateStage, $spoolerCoreUpdateStage, $spoolerRuntimeUpdateStage)) { if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw "Current staged payload is missing: $path" } }
    $serverRelease = Read-Json (Join-Path $serverStage 'release.json')
    $currentCommit = [string]$serverRelease.commit
    if ($currentCommit -notmatch '^[0-9a-fA-F]{40}$') { throw 'Current staged release commit is invalid.' }
    Assert-PackagedCommitScope $currentCommit $checkoutCommit
    Assert-Release (Join-Path $serverStage 'release.json') ([string]$currentPackage.version) $currentCommit | Out-Null
    Assert-Release (Join-Path $spoolerStage 'release.json') ([string]$currentPackage.version) $currentCommit | Out-Null
    Assert-Release (Join-Path $serverUpdateStage 'release.json') ([string]$currentPackage.version) $currentCommit 'server-update' | Out-Null
    Assert-Release (Join-Path $spoolerCoreUpdateStage 'release.json') ([string]$currentSpoolerPackage.version) $currentCommit 'spooler-update-core' | Out-Null
    Assert-Release (Join-Path $spoolerRuntimeUpdateStage 'release.json') ([string]$currentSpoolerPackage.version) $currentCommit 'spooler-update-runtime' | Out-Null
    $serverExe = Assert-Artifact 'POSAPP-Server-Update.exe' 90MB
    $spoolerExe = Assert-Artifact 'POSAPP-Spooler-Update.exe' 5MB
    $spoolerRuntimeExe = Assert-Artifact 'POSAPP-Spooler-Runtime-Update.exe' 170MB
    $serverSetup = Assert-Artifact 'POSAPP-Server-Setup.exe' 220MB
    $spoolerSetup = Assert-Artifact 'POSAPP-Spooler-Setup.exe' 180MB
    $hostSummary.identities = [ordered]@{ packageCommit = $currentCommit; checkoutCommit = $checkoutCommit; baseline = [ordered]@{ commit = $BaselineCommit; serverVersion = '1.0.0'; spoolerVersion = '1.2.0' }; target = [ordered]@{ commit = $currentCommit; serverVersion = [string]$currentPackage.version; spoolerVersion = [string]$currentSpoolerPackage.version } }
    if ($WhatIf) {
        [ordered]@{ whatIf = $true; mutates = $false; host = $hostSummary.os; sandbox = [ordered]@{ networking = $false; vGpu = $false; bundle = '<temporary bundle>'; programFiles = 'C:\Program Files'; programData = 'C:\ProgramData'; resultDirectory = $resultDirectory }; pending = $hostSummary.pending } | ConvertTo-Json -Depth 12
        return
    }
    New-Item -ItemType Directory -Force -Path $resultDirectory | Out-Null
    $worktree = Join-Path $tempRoot "posapp-update-baseline-$([guid]::NewGuid().ToString('N'))"
    Assert-Under $tempRoot $worktree
    # git worktree add --detach <temporary-path> e6938caa
    Invoke-Bounded 'git.exe' @('-C', $repo, 'worktree', 'add', '--detach', $worktree, $BaselineCommit) 120 | Out-Null
    $baselineOut = Join-Path $worktree 'deployment/out/update-baseline'
    New-Item -ItemType Directory -Force -Path (Join-Path $baselineOut 'stage/server'), (Join-Path $baselineOut 'stage/spooler'), (Join-Path $baselineOut 'toolchain') | Out-Null
    foreach ($cache in @('node_modules', 'deployment/vendor')) {
        $source = Join-Path $repo $cache; $destination = Join-Path $worktree $cache
        if (Test-Path -LiteralPath $source -PathType Container) {
            if ($cache -eq 'deployment/vendor') {
                # Copy vendor archives into the detached worktree: Windows PowerShell 5.1's
                # Expand-Archive cleanup can race a junction target and report missing entries.
                Copy-Tree $source $destination
            }
            else { New-Item -ItemType Junction -Path $destination -Target $source -ErrorAction Stop | Out-Null }
        }
    }
    foreach ($cache in @('node_modules', '.cache')) {
        $source = Join-Path $serverStage $cache; $destination = Join-Path $baselineOut "stage/server/$cache"
        if (Test-Path -LiteralPath $source -PathType Container) { Copy-Tree $source $destination }
        $source = Join-Path $spoolerStage $cache; $destination = Join-Path $baselineOut "stage/spooler/$cache"
        if (Test-Path -LiteralPath $source -PathType Container) { Copy-Tree $source $destination }
    }
    if (Test-Path -LiteralPath (Join-Path $repo 'deployment/out/toolchain/node') -PathType Container) { New-Item -ItemType Junction -Path (Join-Path $baselineOut 'toolchain/node') -Target (Join-Path $repo 'deployment/out/toolchain/node') | Out-Null }
    Invoke-Bounded 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $worktree 'scripts/build-installers.ps1'), '-StageOnly', '-SkipDependencyInstall', '-OutputRoot', $baselineOut) 3600 | Out-Null
    $baselineServer = Join-Path $baselineOut 'stage/server'; $baselineSpooler = Join-Path $baselineOut 'stage/spooler'
    foreach ($path in @($baselineServer, $baselineSpooler)) { if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw 'Baseline stage build did not produce both packaged stages.' } }
    $baselineRelease = Assert-Release (Join-Path $baselineServer 'release.json') '1.0.0' ((git -C $worktree rev-parse HEAD).Trim())
    Assert-Release (Join-Path $baselineSpooler 'release.json') '1.0.0' ((git -C $worktree rev-parse HEAD).Trim()) | Out-Null
    $bundleInfo = New-Bundle (Join-Path $currentStage 'server-update') (Join-Path $currentStage 'spooler-update-core') (Join-Path $currentStage 'spooler-update-runtime') $serverExe $spoolerExe $spoolerRuntimeExe $serverSetup $spoolerSetup $baselineServer $baselineSpooler $worktree $BaselineCommit $currentCommit
    $bundle = $bundleInfo.Path
    Start-Sandbox $sandboxId $bundle $resultDirectory
    $preCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\bundle\guest\update-sandbox-guest.ps1 -Phase pre-reboot -Disposable -BundlePath C:\bundle -ResultPath C:\results\pre-reboot.json -SentinelPath C:\bundle\sentinel.txt -SentinelValue $($bundleInfo.Sentinel)"
    try { Invoke-Guest $sandboxId $preCommand 3600 | Out-Null } catch { $failure = $_; throw }
    $preExit = Wait-GuestMarker (Join-Path $resultDirectory 'pre-reboot.exit') 30
    if ($preExit -ne 0) { throw 'Guest pre-reboot phase failed.' }
    $hostSummary.phases.preReboot = Read-Json (Join-Path $resultDirectory 'pre-reboot.json')
    $rebootCommand = 'shutdown.exe /r /t 0 /f'
    try { Invoke-Guest $sandboxId $rebootCommand 60 | Out-Null } catch {}
    $postCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\bundle\guest\update-sandbox-guest.ps1 -Phase post-reboot -Disposable -BundlePath C:\bundle -ResultPath C:\results\post-reboot.json -SentinelPath C:\bundle\sentinel.txt -SentinelValue $($bundleInfo.Sentinel)"
    $postDeadline = [DateTime]::UtcNow.AddMinutes(8)
    do {
        if (Test-Path -LiteralPath (Join-Path $resultDirectory 'post-reboot.exit') -PathType Leaf) { break }
        try { Invoke-Guest $sandboxId $postCommand 90 | Out-Null } catch {}
        Start-Sleep -Seconds 5
    } while ([DateTime]::UtcNow -lt $postDeadline)
    $postExit = Wait-GuestMarker (Join-Path $resultDirectory 'post-reboot.exit') 30
    if ($postExit -ne 0) { throw 'Guest post-reboot phase failed.' }
    $hostSummary.phases.postReboot = Read-Json (Join-Path $resultDirectory 'post-reboot.json')
    $hostSummary.completedAt = [DateTime]::UtcNow.ToString('o'); Write-Utf8NoBom (Join-Path $resultDirectory 'host-summary.json') ($hostSummary | ConvertTo-Json -Depth 20)
}
catch {
    $failure = $_
    $hostSummary.error = $_.Exception.Message
    $hostSummary.completedAt = [DateTime]::UtcNow.ToString('o')
    try { New-Item -ItemType Directory -Force -Path $resultDirectory | Out-Null; Write-Utf8NoBom (Join-Path $resultDirectory 'host-summary.json') ($hostSummary | ConvertTo-Json -Depth 20) } catch {}
    throw
}
finally {
    if ($sandboxStarted -and (-not $failure -or -not $KeepSandboxOnFailure)) { Stop-Sandbox $sandboxId }
    if (-not $failure -or -not $KeepSandboxOnFailure) {
        if ($bundle -and (Test-Path -LiteralPath $bundle) -and $bundle.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $bundle -Recurse -Force -ErrorAction SilentlyContinue }
        if ($worktree -and (Test-Path -LiteralPath $worktree) -and $worktree.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { try { Invoke-Bounded 'git.exe' @('-C', $repo, 'worktree', 'remove', '--force', $worktree) 120 | Out-Null } catch {}; Remove-Item -LiteralPath $worktree -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
