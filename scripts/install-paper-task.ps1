[CmdletBinding()]
param(
  [string]$TaskName = 'BinanceQuantPaperDaily0900',
  [string]$NodePath = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot 'paper-trade-daily.mjs'
if (-not (Test-Path -LiteralPath $runner)) {
  throw "找不到模拟盘执行脚本：$runner"
}
if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $NodePath = (Get-Command node -ErrorAction Stop).Source
}
if (-not (Test-Path -LiteralPath $NodePath)) {
  throw "找不到 Node.js：$NodePath"
}

$action = New-ScheduledTaskAction `
  -Execute $NodePath `
  -Argument "`"$runner`" --notify" `
  -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.AddHours(9))
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -WakeToRun `
  -RunOnlyIfNetworkAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 2)
$principal = New-ScheduledTaskPrincipal `
  -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description 'QuantFlow模拟盘每日北京时间09:00结算盈亏并显示Windows通知' `
  -Force | Out-Null

Get-ScheduledTask -TaskName $TaskName
Get-ScheduledTaskInfo -TaskName $TaskName |
  Select-Object LastRunTime, LastTaskResult, NextRunTime, NumberOfMissedRuns
