# Optional. Registers a task only for the current user's interactive logon.
$ErrorActionPreference = 'Stop'
$projectPath = Split-Path $PSScriptRoot -Parent
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $nodePath -Argument ('"' + (Join-Path $projectPath 'server\index.mjs') + '"') -WorkingDirectory $projectPath
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'PocketTerminal' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Terminal personal de Windows para el movil' | Out-Null
Write-Host 'Pocket Terminal arrancara al iniciar tu sesion de Windows. No antes de iniciar sesion.'
Write-Host 'Para iniciarlo ahora: Start-ScheduledTask -TaskName PocketTerminal'
