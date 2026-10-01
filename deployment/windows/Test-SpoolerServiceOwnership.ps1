<#
    Read-only diagnostic for "Spooler service ownership is not exact".

    Update-Spooler.ps1 refuses to touch a service it does not recognise as its own, which
    is right - it renames runtimes aside and rewrites service parameters, and doing that to
    someone else's service would be worse than refusing. But the refusal reports only that
    ownership is "not exact", and the check has seven distinct ways to fail. This names
    which one.

    Mirrors Get-ServiceOwnerState in Update-Spooler.ps1 exactly. It changes nothing.

        powershell -NoProfile -ExecutionPolicy Bypass -File Test-SpoolerServiceOwnership.ps1
#>
[CmdletBinding()]
param(
    [string]$ProgramFilesRoot = 'C:\Program Files\POS-Spooler'
)

$serviceName = 'POS Print Spooler'
$ok = $true
function Say([string]$state, [string]$text) {
    $colour = switch ($state) { 'ok' { 'Green' } 'bad' { 'Red' } default { 'Yellow' } }
    Write-Host ("  [{0}] {1}" -f $state.ToUpper().PadRight(4), $text) -ForegroundColor $colour
    if ($state -eq 'bad') { $script:ok = $false }
}

Write-Host "`nSpooler service ownership check" -ForegroundColor Cyan
Write-Host "ProgramFilesRoot: $ProgramFilesRoot`n"

# 1. Does the expected service exist at all, and is it the only one?
$known = @('POS Print Spooler', 'POSPrintSpooler', 'POSAPPSpooler')
$present = @($known | Where-Object { Get-Service -Name $_ -ErrorAction SilentlyContinue })
if ($present.Count -eq 0) {
    Say 'bad' "No spooler service found. Expected '$serviceName'."
    Write-Host "`n  -> Nothing to update. Use POSAPP-Spooler-Setup.exe (the full installer), not an update.`n" -ForegroundColor Cyan
    exit 1
}
Say 'ok' ("Services present: " + ($present -join ', '))
if ($present.Count -gt 1) { Say 'bad' "More than one spooler service exists. The updater requires exactly one; remove the extras." }
if ($present -notcontains $serviceName) { Say 'bad' "The service is not named '$serviceName'. The updater only recognises that exact name." }

# 2. What executable does the service actually run?
$image = (Get-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$serviceName" -ErrorAction SilentlyContinue).ImagePath
if (-not $image) { Say 'bad' 'Service registry key has no ImagePath.'; exit 1 }
# An unquoted ImagePath containing spaces - "C:\Program Files\..." - must not be split on
# the first space, or every default install reports running "C:\Program". Prefer the whole
# value when it resolves to a real file, and only fall back to splitting when it does not.
$trimmed = $image.Trim()
$exe = if ($trimmed.StartsWith('"')) { ($trimmed -split '"')[1] }
       elseif (Test-Path -LiteralPath $trimmed -PathType Leaf) { $trimmed }
       else { ($trimmed -split ' ')[0] }
Write-Host "  ImagePath: $image"

$nssm   = [IO.Path]::GetFullPath((Join-Path $ProgramFilesRoot 'runtime\nssm\nssm.exe'))
$legacy = [IO.Path]::GetFullPath((Join-Path $ProgramFilesRoot 'daemon\posprintspooler.exe'))
$exeFull = try { [IO.Path]::GetFullPath($exe) } catch { $exe }

if ($exeFull -ieq $legacy) {
    Say 'bad' 'This is a LEGACY daemon service (daemon\posprintspooler.exe).'
    Write-Host "`n  -> Cannot be updated. Remove the service and the daemon folder, then run" -ForegroundColor Cyan
    Write-Host "     POSAPP-Spooler-Setup.exe as a fresh install:" -ForegroundColor Cyan
    Write-Host "       sc.exe delete `"$serviceName`"" -ForegroundColor White
    Write-Host "       Remove-Item -Recurse -Force '$ProgramFilesRoot\daemon'`n" -ForegroundColor White
    exit 1
}
if ($exeFull -ine $nssm) {
    Say 'bad' "Service does not run the expected NSSM binary.`n         runs:     $exeFull`n         expected: $nssm"
} else {
    Say 'ok' 'Service runs the expected NSSM binary.'
}
if (-not (Test-Path -LiteralPath $nssm -PathType Leaf)) { Say 'bad' "NSSM binary is missing from disk: $nssm" }

# 3. The NSSM parameters must match exactly - this is where most failures actually are.
$p = Get-ItemProperty -LiteralPath "HKLM:\SYSTEM\CurrentControlSet\Services\$serviceName\Parameters" -ErrorAction SilentlyContinue
if (-not $p) { Say 'bad' 'Service has no NSSM Parameters registry key.'; exit 1 }

$node        = [IO.Path]::GetFullPath((Join-Path $ProgramFilesRoot 'runtime\node\node.exe'))
$serverJs    = [IO.Path]::GetFullPath((Join-Path $ProgramFilesRoot 'server.js'))
$v2Js        = [IO.Path]::GetFullPath((Join-Path $ProgramFilesRoot 'v2-server.js'))
$expectedDir = [IO.Path]::GetFullPath($ProgramFilesRoot)

foreach ($field in 'Application', 'AppDirectory', 'AppParameters') {
    if ([string]::IsNullOrWhiteSpace([string]$p.$field)) { Say 'bad' "Parameters\$field is empty." }
}

$storedNode = try { [IO.Path]::GetFullPath([string]$p.Application) } catch { [string]$p.Application }
$storedDir  = try { [IO.Path]::GetFullPath([string]$p.AppDirectory) } catch { [string]$p.AppDirectory }

if ($storedNode -ine $node) { Say 'bad' "Application points elsewhere.`n         stored:   $storedNode`n         expected: $node" }
else { Say 'ok' 'Application points at the bundled node.exe.' }

if ($storedDir -ine $expectedDir) { Say 'bad' "AppDirectory points elsewhere.`n         stored:   $storedDir`n         expected: $expectedDir" }
else { Say 'ok' 'AppDirectory is the install root.' }

$accepted = @('"' + $serverJs + '"', '"' + $v2Js + '"')
$stored = [string]$p.AppParameters
if ($stored -notin $accepted) {
    Say 'bad' ("AppParameters is not an accepted entry point.`n         stored:   " + $stored + "`n         accepted: " + ($accepted -join '  or  '))
    # The two can look identical in a console and still differ - trailing whitespace, a
    # non-breaking space, curly quotes from a copied command. Show the bytes, because the
    # updater compares these strings exactly and refuses on any difference at all.
    $a = [Text.Encoding]::UTF8.GetBytes($stored)
    $b = [Text.Encoding]::UTF8.GetBytes($accepted[0])
    Write-Host ("         stored length {0}, expected length {1}" -f $a.Length, $b.Length)
    if ($a.Length -ne $b.Length) {
        Write-Host "         -> lengths differ; likely trailing whitespace or an extra character."
    } else {
        for ($i = 0; $i -lt $a.Length; $i++) {
            if ($a[$i] -ne $b[$i]) {
                Write-Host ("         -> first difference at position {0}: stored 0x{1:X2} '{2}' vs expected 0x{3:X2} '{4}'" -f `
                    $i, $a[$i], [char]$a[$i], $b[$i], [char]$b[$i])
                break
            }
        }
    }
} else {
    Say 'ok' ('Entry point is ' + [IO.Path]::GetFileName($stored.Trim('"')) + '.')
}

foreach ($needed in @($node, $serverJs)) {
    if (-not (Test-Path -LiteralPath $needed -PathType Leaf)) { Say 'bad' "Missing on disk: $needed" }
}

Write-Host ""
if ($ok) {
    Write-Host "  Ownership is EXACT. This machine is not the reason the update refused." -ForegroundColor Green
} else {
    Write-Host "  Ownership is NOT exact - the lines marked BAD above are why." -ForegroundColor Red
    Write-Host "  If the install predates the current package, the supported route is to remove" -ForegroundColor Cyan
    Write-Host "  the service and reinstall with POSAPP-Spooler-Setup.exe rather than update." -ForegroundColor Cyan
}
Write-Host ""
exit ([int](-not $ok))
