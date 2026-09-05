$ErrorActionPreference = 'Stop'
# Sin barra de progreso: dentro del panel repinta la pantalla y la ensucia.
$ProgressPreference = 'SilentlyContinue'
Stop-ScheduledTask -TaskName 'PocketTerminalBot' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'PocketTerminalBot' -Confirm:$false
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like '*scripts\bot.mjs*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host 'Vigilante de Telegram eliminado y detenido.'
