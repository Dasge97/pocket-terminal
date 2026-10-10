# Instalador para el panel KitDani. No pregunta nada: registra la tarea
# PocketTerminalBot (como Enable-BotAutostart.ps1) y arranca el vigilante ya.
# Falla con un mensaje claro si Telegram no esta configurado todavia.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
& (Join-Path $PSScriptRoot 'Enable-BotAutostart.ps1')
Start-ScheduledTask -TaskName 'PocketTerminalBot'
Write-Host 'Vigilante de Telegram arrancado.'
