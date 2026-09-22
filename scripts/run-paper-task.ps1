[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$NodePath)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$runner = Join-Path $PSScriptRoot 'paper-trade-scheduled.mjs'
& $NodePath $runner --notify
exit $LASTEXITCODE
