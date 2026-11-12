' Runs start-public.ps1 with NO window at all (used by the 5-minute watchdog task, scripts\register-autostart.ps1).
' powershell.exe -WindowStyle Hidden still flashes a console window for a moment on every run; wscript does not.
Set fso = CreateObject("Scripting.FileSystemObject")
script = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "start-public.ps1")
' 0 = hidden window, True = wait until it finishes (so the task's "already running" guard keeps working)
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """", 0, True
