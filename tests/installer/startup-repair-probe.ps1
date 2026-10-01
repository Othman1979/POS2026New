$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$work = Join-Path $repo 'deployment\out\startup-repair-probe'
if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
$serverData = Join-Path $work 'server-data'
New-Item -ItemType Directory -Force -Path $serverData | Out-Null

function Assert-PowerShellSyntax([string]$Path) {
    $tokens = $null; $errors = $null
    [void][Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) { throw "PowerShell syntax failed for $Path`: $($errors[0].Message)" }
}

$serverScript = Join-Path $repo 'deployment\windows\Repair-PosStartup.ps1'
Assert-PowerShellSyntax $serverScript
Assert-PowerShellSyntax (Join-Path $repo 'deployment\windows\Install-PosServer.ps1')
Assert-PowerShellSyntax (Join-Path $repo 'deployment\windows\Install-Spooler.ps1')
Assert-PowerShellSyntax (Join-Path $repo 'deployment\windows\InstallerUpdateState.ps1')

$metadata = [ordered]@{ posPort=3100; databasePort=3307; phpMyAdminPort=8082 }
[IO.File]::WriteAllText((Join-Path $serverData 'install.json'), ($metadata | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$serverResult = & $serverScript -ProgramFilesRoot (Join-Path $work 'server-files') -ProgramDataRoot $serverData -StartupDelaySeconds 0 -WhatIf | ConvertFrom-Json
if ($serverResult.mutates -ne $false -or $serverResult.posPort -ne 3100 -or $serverResult.databasePort -ne 3307 -or $serverResult.phpMyAdminPort -ne 8082) { throw 'Server startup repair WhatIf contract failed.' }
if (Test-Path -LiteralPath (Join-Path $serverData 'logs')) { throw 'Server startup repair WhatIf mutated ProgramData.' }

Remove-Item -LiteralPath $work -Recurse -Force
Write-Output 'Server startup repair syntax and non-mutating WhatIf probes passed.'
