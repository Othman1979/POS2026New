[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$ResultFile,
    [string]$ProgramDataRoot = 'C:\ProgramData\POSApp',
    [int]$HealthTimeoutSeconds = 4
)

$ErrorActionPreference = 'Stop'
$temporaryResult = $null
$backupResult = $null
$detected = $false

try {
    if (-not (Test-Path -LiteralPath $ResultFile -PathType Leaf)) { throw 'Result file is missing.' }
    if ($HealthTimeoutSeconds -lt 1 -or $HealthTimeoutSeconds -gt 30) { throw 'Health timeout is invalid.' }

    $metadataPath = Join-Path $ProgramDataRoot 'install.json'
    $envPath = Join-Path $ProgramDataRoot 'config\pos.env'
    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    $envLines = @(Get-Content -LiteralPath $envPath)

    if ([string]$metadata.appId -cne '{E99DB275-DDA0-43A0-95CD-7AE07185122C}') { throw 'Installation ownership is invalid.' }
    $portValue = $metadata.posPort
    if ($portValue -isnot [byte] -and $portValue -isnot [int16] -and $portValue -isnot [int32] -and $portValue -isnot [int64]) { throw 'POS port is invalid.' }
    $portText = [string]$portValue
    if ($portText -notmatch '^\d+\z') { throw 'POS port is invalid.' }
    $port = [int]$portText
    if ($port -lt 1 -or $port -gt 65535) { throw 'POS port is invalid.' }

    $spoolerKeys = @(
        foreach ($line in $envLines) {
            if ($line -match '^(?<name>[A-Z0-9_]+)=(?<value>.*)\z' -and $Matches.name -ceq 'SPOOLER_KEY') { [string]$Matches.value }
        }
    )
    if ($spoolerKeys.Count -ne 1) { throw 'Spooler key is invalid.' }
    $spoolerKey = [string]$spoolerKeys[0]
    if ([string]::IsNullOrWhiteSpace($spoolerKey) -or $spoolerKey -notmatch '^[A-Za-z0-9_-]{43}\z') { throw 'Spooler key is invalid.' }

    $serverUrl = "http://127.0.0.1:$port"
    $health = Invoke-RestMethod -Uri "$serverUrl/health" -TimeoutSec $HealthTimeoutSeconds
    if ([string]$health.status -cne 'ok' -or [string]$health.db -cne 'connected' -or [string]::IsNullOrWhiteSpace([string]$health.release.version)) {
        throw 'POS server health verification failed.'
    }

    $resultDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($ResultFile))
    $temporaryResult = Join-Path $resultDirectory ('.' + [IO.Path]::GetRandomFileName())
    $backupResult = Join-Path $resultDirectory ('.' + [IO.Path]::GetRandomFileName())
    [IO.File]::WriteAllText($temporaryResult, "$serverUrl`r`n$spoolerKey", [Text.UTF8Encoding]::new($false))
    [IO.File]::Replace($temporaryResult, $ResultFile, $backupResult, $true)
    Remove-Item -LiteralPath $backupResult -Force -ErrorAction SilentlyContinue
    $temporaryResult = $null
    $backupResult = $null
    $detected = $true
}
catch {
    $detected = $false
}
finally {
    if ($temporaryResult -and (Test-Path -LiteralPath $temporaryResult -PathType Leaf)) {
        Remove-Item -LiteralPath $temporaryResult -Force -ErrorAction SilentlyContinue
    }
    if ($backupResult -and (Test-Path -LiteralPath $backupResult -PathType Leaf)) {
        Remove-Item -LiteralPath $backupResult -Force -ErrorAction SilentlyContinue
    }
}

if ($detected) { exit 0 }
exit 2
