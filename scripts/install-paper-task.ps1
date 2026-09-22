[CmdletBinding()]
param(
  [string]$TaskName = 'BinanceQuantPaperDaily0900',
  [string]$NodePath = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot 'run-paper-task.ps1'
if (-not (Test-Path -LiteralPath $runner)) {
  throw "Paper task runner not found: $runner"
}
if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $NodePath = (Get-Command node -ErrorAction Stop).Source
}
if (-not (Test-Path -LiteralPath $NodePath)) {
  throw "Node.js not found: $NodePath"
}

$action = New-ScheduledTaskAction `
  -Execute (Join-Path $PSHOME 'powershell.exe') `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -NodePath `"$NodePath`"" `
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
  -Description 'QuantFlow paper settlement at 09:00 Beijing time with Windows notification' `
  -Force | Out-Null

# Check for missed settlements once daily at 10:00. The recovery task does not
# wake the computer or add login/minute-level triggers.
$recoveryTaskName = "${TaskName}CatchUp"
$recoveryTrigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.AddHours(10))
$recoverySettings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
  -MultipleInstances IgnoreNew
Register-ScheduledTask `
  -TaskName $recoveryTaskName `
  -Action $action `
  -Trigger $recoveryTrigger `
  -Settings $recoverySettings `
  -Principal $principal `
  -Description 'QuantFlow paper recovery: once daily at 10:00; skips settled cycles and records failures' `
  -Force | Out-Null

Get-ScheduledTask -TaskName $TaskName, $recoveryTaskName
foreach ($registeredName in @($TaskName, $recoveryTaskName)) {
  Get-ScheduledTaskInfo -TaskName $registeredName |
    Select-Object TaskName, LastRunTime, LastTaskResult, NextRunTime, NumberOfMissedRuns
}
