[CmdletBinding()]
param([int]$Port, [string]$Ports, [int]$SearchLimit = 100, [switch]$RequireAvailable, [string]$MessageFile)
$ErrorActionPreference = 'Stop'
function Assert-Port([int]$candidate) {
    if ($candidate -lt 1 -or $candidate -gt 65535) { throw 'Port must be between 1 and 65535.' }
}
function Test-PortAvailable([int]$candidate) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse('127.0.0.1'), $candidate)
    try { $listener.Start(); return $true }
    catch { return $false }
    finally { $listener.Stop() }
}
function Get-Status([int]$candidate) {
    $available = Test-PortAvailable $candidate
    $listener = if ($available) { $null } else { Get-NetTCPConnection -State Listen -LocalPort $candidate -ErrorAction SilentlyContinue | Select-Object -First 1 }
    $processId = if ($listener) { [int]$listener.OwningProcess } else { $null }
    $processName = if ($processId) { (Get-Process -Id $processId -ErrorAction SilentlyContinue).ProcessName } else { $null }
    [pscustomobject][ordered]@{ port=$candidate; available=$available; processId=$processId; processName=$processName }
}
function Get-StatusWithSuggestion([int]$selected) {
    $current = Get-Status $selected
    $suggestion = if ($current.available) { $selected } else { $null }
    if (-not $current.available) {
        for ($candidate = $selected + 1; $candidate -le [Math]::Min(65535, $selected + $SearchLimit); $candidate++) {
            if (Test-PortAvailable $candidate) { $suggestion = $candidate; break }
        }
    }
    $current | Add-Member -NotePropertyName suggestion -NotePropertyValue $suggestion -PassThru
}
if ([string]::IsNullOrWhiteSpace($Ports)) {
    if (-not $PSBoundParameters.ContainsKey('Port')) { throw 'At least one port is required.' }
    $selectedPorts = @($Port)
} else {
    $selectedPorts = $Ports.Split(',') | ForEach-Object { [int]$_.Trim() }
}
$results = @()
foreach ($selected in $selectedPorts) {
    Assert-Port $selected
    $results += Get-StatusWithSuggestion $selected
}
$allAvailable = -not ($results | Where-Object { -not $_.available } | Select-Object -First 1)
if ($results.Count -eq 1) { $results[0] | ConvertTo-Json -Compress }
else { [ordered]@{ available=$allAvailable; ports=$results } | ConvertTo-Json -Compress }
if ($MessageFile) {
    $messages = foreach ($current in $results) {
        $owner = if ($current.processName) { "$($current.processName) (PID $($current.processId))" } else { 'another process' }
        if ($current.available) { "Port $($current.port) is available." }
        elseif ($current.suggestion) { "Port $($current.port) is already used by $owner. Suggested available port: $($current.suggestion)." }
        else { "Port $($current.port) is already used by $owner. No free port was found in the next $SearchLimit ports." }
    }
    $message = if ($allAvailable) { 'Selected ports are available.' } else { ($messages | Where-Object { $_ -notmatch ' is available\.$' }) -join [Environment]::NewLine }
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($MessageFile), $message, [Text.UTF8Encoding]::new($false))
}
if ($RequireAvailable -and -not $allAvailable) { exit 2 }
