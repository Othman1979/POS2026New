[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$ProgramFilesRoot = 'C:\Program Files\POS-Spooler',
    [string]$ProgramDataRoot = 'C:\ProgramData\POS-Spooler'
)
$ErrorActionPreference = 'Stop'
if ($WhatIfPreference) { Write-Output 'WhatIf: would remove the owned POS Print Spooler service while preserving configuration and state.'; return }

function Enter-SpoolerRemovalMutex {
    $mutex = [Threading.Mutex]::new($false, 'Global\POSAPP-Spooler-Service-Mutation')
    try {
        try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
        if (-not $acquired) { throw 'Another POS Print Spooler installer or updater is already running.' }
        return $mutex
    } catch { $mutex.Dispose(); throw }
}
function Exit-SpoolerRemovalMutex($Mutex) {
    if ($null -eq $Mutex) { return }
    try { $Mutex.ReleaseMutex() } catch {}
    $Mutex.Dispose()
}

function Normalize-RemovalPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    try { return [IO.Path]::GetFullPath($Path).TrimEnd('\') } catch { return $null }
}
function Get-RemovalExecutable([string]$ImagePath) {
    $value = [string]$ImagePath
    if ($value.Trim().StartsWith('"')) { return $value.Trim().Split('"')[1] }
    if ($value -match '^(?<path>.*?\.exe)(?:\s+.*)?$') { return $Matches.path.Trim() }
    return $null
}
function Wait-ServiceRemoved([string]$Name) {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        if (-not (Get-Service -Name $Name -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'POS Print Spooler service was not removed within 30 seconds.'
}

$serviceName = 'POS Print Spooler'
$known = @($serviceName, 'POSPrintSpooler', 'POSAPPSpooler')
$present = @($known | Where-Object { Get-Service -Name $_ -ErrorAction SilentlyContinue })
if ($present.Count -gt 1 -or ($present.Count -eq 1 -and $present[0] -ne $serviceName)) {
    throw "Refusing to remove an unrecognized Windows service set: $($present -join ', ')."
}
$lock = Enter-SpoolerRemovalMutex
try {
    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    $registry = "HKLM:\SYSTEM\CurrentControlSet\Services\$serviceName"
    # Get-Service -Name also matches DisplayName on Windows PowerShell 5.1, while
    # sc.exe knows key names only. A foreign service merely showing our display name
    # would otherwise be Stop-Service -Force'd - taking its dependents with it -
    # before sc.exe delete failed 1060 and threw, after the damage.
    if ($service -and -not (Test-Path -LiteralPath $registry)) {
        throw "Another service is displaying the name $serviceName; refusing to touch it."
    }
    if ($service) {
        $serviceRegistry = Get-ItemProperty -LiteralPath $registry -Name ImagePath -ErrorAction SilentlyContinue
        $parameters = Get-ItemProperty -LiteralPath "$registry\Parameters" -ErrorAction SilentlyContinue
        $image = [string]$serviceRegistry.ImagePath
        $actualExe = Normalize-RemovalPath (Get-RemovalExecutable $image)
        $expectedExe = Normalize-RemovalPath (Join-Path $ProgramFilesRoot 'runtime\nssm\nssm.exe')
        $actualRoot = Normalize-RemovalPath ([string]$parameters.AppDirectory)
        $expectedRoot = Normalize-RemovalPath $ProgramFilesRoot
        $actualScript = Normalize-RemovalPath ([string]$parameters.AppParameters).Trim('"')
        $allowedScripts = @((Normalize-RemovalPath (Join-Path $ProgramFilesRoot 'server.js')), (Normalize-RemovalPath (Join-Path $ProgramFilesRoot 'v2-server.js')))
        # All three installers register this same service name, so the name alone does
        # not make it ours. `nssm install` writes ImagePath before AppParameters, so an
        # ImagePath we can read that names a different nssm belongs to another
        # installation - the hand-copy one, most likely, and stopping it takes a
        # working till offline. An ImagePath we cannot read is our own unfinished
        # install and is still cleaned up below.
        if ($actualExe -and $actualExe -ne $expectedExe) {
            throw "Refusing to remove a POS Print Spooler service owned by $image."
        }
        if ($actualExe -ne $expectedExe -or $actualRoot -ne $expectedRoot -or $actualScript -notin $allowedScripts) {
            Write-Warning "Removing a POS Print Spooler service with unexpected configuration: $image"
        }
        if ($service.Status -ne 'Stopped') { Stop-Service -Name $serviceName -Force; $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) }
        & sc.exe delete $serviceName | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Windows refused to remove the POS Print Spooler service.' }
        Wait-ServiceRemoved $serviceName
    }
    Unregister-ScheduledTask -TaskName 'POSAPP Spooler Startup Health Repair' -Confirm:$false -ErrorAction SilentlyContinue
}
finally { Exit-SpoolerRemovalMutex $lock }
Write-Output 'Preserved: C:\ProgramData\POS-Spooler\config and state.'
