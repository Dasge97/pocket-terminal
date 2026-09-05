' Arranca el vigilante de Telegram sin ventana de consola.
' Lo usa la tarea programada PocketTerminalBot.
' Argumento 1: ruta completa de node.exe. La tarea la fija al registrarse, para
' no depender del PATH que el Programador de tareas acabe pasando al proceso.
Dim shell, fso, base, nodePath
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
If WScript.Arguments.Count > 0 Then
  nodePath = WScript.Arguments(0)
Else
  nodePath = "node.exe"
End If
shell.CurrentDirectory = base
shell.Run """" & nodePath & """ """ & base & "\scripts\bot.mjs""", 0, False
