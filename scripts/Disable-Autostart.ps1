$ErrorActionPreference = 'Stop'
Stop-ScheduledTask -TaskName 'PocketTerminal' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'PocketTerminal' -Confirm:$false
Write-Host 'Inicio automatico eliminado. Las terminales del proceso detenido se han cerrado.'
