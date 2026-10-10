# Desinstalador para el panel KitDani. No pregunta nada y no falla si la tarea
# ya no existe: quita la tarea PocketTerminalBot y para el vigilante.
# No toca Pocket Terminal si esta en marcha: el servidor y el tunel van aparte.
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
Stop-ScheduledTask -TaskName 'PocketTerminalBot'
Unregister-ScheduledTask -TaskName 'PocketTerminalBot' -Confirm:$false
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like '*scripts\bot.mjs*' -or $_.CommandLine -like '*scripts/bot.mjs*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Host 'Vigilante de Telegram eliminado y detenido.'
exit 0
