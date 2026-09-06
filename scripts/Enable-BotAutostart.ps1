# Opcional. Deja el vigilante de Telegram escuchando desde que inicias sesion.
# No arranca Pocket Terminal por su cuenta: solo espera tus ordenes en el bot.
$ErrorActionPreference = 'Stop'
# Sin barra de progreso: dentro del panel repinta la pantalla y la ensucia.
$ProgressPreference = 'SilentlyContinue'
$projectPath = Split-Path $PSScriptRoot -Parent
$telegramConfig = Join-Path $projectPath '.pocket-terminal\telegram.json'
if (-not (Test-Path $telegramConfig)) {
    throw 'Configura Telegram primero: npm run telegram'
}
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { throw 'No encuentro node.exe en el PATH.' }
$nodeVersion = & $node.Source --version
if ($nodeVersion -notlike 'v24.*') { Write-Warning "El node.exe del PATH es $nodeVersion; este proyecto espera Node 24." }
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
# wscript arranca el proceso sin ventana de consola; node.exe la mostraria.
# La ruta de node va fijada al registrar la tarea: el Programador de tareas no
# pasa siempre el mismo PATH que una ventana normal, y alli node.exe puede
# resolver a otra version instalada.
$vbs = Join-Path $projectPath 'scripts\bot-hidden.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '" "' + $node.Source + '"') -WorkingDirectory $projectPath
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
# Repetir cada 5 minutos: si el vigilante se cae estando fuera de casa, vuelve
# solo. El propio bot comprueba si ya hay otro corriendo y se retira si lo hay.
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)).Repetition
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Unregister-ScheduledTask -TaskName 'PocketTerminalBot' -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName 'PocketTerminalBot' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Escucha el bot de Telegram para arrancar Pocket Terminal' | Out-Null
Write-Host 'Listo. El vigilante arrancara al iniciar tu sesion de Windows.'
Write-Host 'Para arrancarlo ahora: Start-ScheduledTask -TaskName PocketTerminalBot'
Write-Host 'Desde el movil, escribe /ayuda a tu bot.'
