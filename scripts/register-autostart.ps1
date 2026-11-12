# Keeps the Anvexa public link alive without anyone watching (Task Scheduler, no admin needed):
#   - at Windows login, and
#   - every 5 minutes (watchdog): scripts\start-public.ps1 reuses a live tunnel (nothing changes, ~10 s), and replaces
#     a dead one (laptop slept, internet dropped). Then CAREERS_SITE_URL is updated, the API restarts, and it emails
#     the AI screening link again - with the new address - to every student whose earlier link stopped working.
# Remove again:  Unregister-ScheduledTask -TaskName 'ANVEXA public apply link' -Confirm:$false

# Through wscript + start-public-hidden.vbs: powershell.exe itself flashes a console window every 5 minutes.
$script = Join-Path $PSScriptRoot 'start-public-hidden.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //NoLogo `"$script`""
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
# Laptop on battery must still run it; a run still busy when the next one is due is not started twice.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName 'ANVEXA public apply link' -Action $action -Trigger @($atLogon, $every5) -Settings $settings `
  -Description 'Starts Docker, the Anvexa apps and the Cloudflare tunnel at login, and every 5 minutes replaces a dead tunnel (students then get the new link by email).' -Force | Out-Null
"Registered: ANVEXA public apply link (at login + every 5 minutes)"
