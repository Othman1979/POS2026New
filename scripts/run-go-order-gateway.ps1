[CmdletBinding()]
param(
    [ValidateSet('build', 'test', 'voice', 'local', 'simulate', 'ucm-probe')]
    [string]$Action = 'build',
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$GatewayArgs
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$gatewayRoot = Join-Path $repoRoot 'integrations\gemini-order-gateway'
$binaryPath = Join-Path $gatewayRoot 'bin\posapp-order-gateway.exe'
$envPath = Join-Path $gatewayRoot 'gateway.env'

function Find-GoExecutable {
    param([switch]$AllowMissing)
    if ($env:POSAPP_GO_EXE -and (Test-Path -LiteralPath $env:POSAPP_GO_EXE -PathType Leaf)) {
        return (Resolve-Path -LiteralPath $env:POSAPP_GO_EXE).Path
    }
    $installed = Get-Command go.exe -ErrorAction SilentlyContinue
    if ($installed) { return $installed.Source }
    $portable = Get-ChildItem -Path (Join-Path $env:USERPROFILE '.cache\codex-runtimes') -Filter go.exe -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\go[0-9.]+\\go\\bin\\go\.exe$' } |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    if ($portable) { return $portable.FullName }
    if ($AllowMissing) { return $null }
    throw 'Go 1.25 or newer was not found. Set POSAPP_GO_EXE or install Go from https://go.dev/dl/.'
}

function Build-Gateway {
    param([string]$GoExecutable)
    $go = if ($GoExecutable) { $GoExecutable } else { Find-GoExecutable }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $binaryPath) | Out-Null
    Push-Location $gatewayRoot
    try {
        & $go build -trimpath -ldflags '-s -w' -o $binaryPath '.\cmd\order-gateway'
        if ($LASTEXITCODE -ne 0) { throw "Go gateway build failed with exit code $LASTEXITCODE." }
    } finally {
        Pop-Location
    }
}

switch ($Action) {
    'test' {
        $go = Find-GoExecutable
        Push-Location $gatewayRoot
        try {
            & $go test './...'
            if ($LASTEXITCODE -ne 0) { throw "Go gateway tests failed with exit code $LASTEXITCODE." }
        } finally {
            Pop-Location
        }
    }
    'build' {
        Build-Gateway
        Write-Host "Built $binaryPath"
    }
    default {
        if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) {
            Build-Gateway
        } else {
            $binaryModified = (Get-Item -LiteralPath $binaryPath).LastWriteTimeUtc
            $sources = @(Get-Item -LiteralPath (Join-Path $gatewayRoot 'go.mod'), (Join-Path $gatewayRoot 'go.sum'))
            $sources += Get-ChildItem -LiteralPath (Join-Path $gatewayRoot 'cmd'), (Join-Path $gatewayRoot 'internal'), (Join-Path $gatewayRoot 'voice-ui') -File -Recurse
            if ($sources | Where-Object { $_.LastWriteTimeUtc -gt $binaryModified } | Select-Object -First 1) {
                $go = Find-GoExecutable -AllowMissing
                if ($go) {
                    Build-Gateway -GoExecutable $go
                } else {
                    Write-Warning 'Gateway source is newer than the packaged executable; Go is unavailable, so the existing executable will run.'
                }
            }
        }
        if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
            throw "Create $envPath from gateway.env.example and add the local keys first."
        }
        $commandArgs = @($Action, '--env', $envPath)
        if ($Action -eq 'local') { $commandArgs += @('--repo-root', $repoRoot) }
        if ($GatewayArgs) { $commandArgs += $GatewayArgs }
        & $binaryPath @commandArgs
        if ($LASTEXITCODE -ne 0) { throw "Go gateway exited with code $LASTEXITCODE." }
    }
}
