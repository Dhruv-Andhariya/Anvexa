# Runs scripts\start-public.ps1 hidden every time this Windows user logs in (Task Scheduler, no admin needed).
# Remove again:  Unregister-ScheduledTask -TaskName 'HireFlow public apply link' -Confirm:$false

$script = Join-Path $PSScriptRoot 'start-public.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
# Laptop on battery must still start it; no time limit (the script exits once everything is up).
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'HireFlow public apply link' -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Starts Docker, the HireFlow apps and the Cloudflare tunnel apply link at login.' -Force | Out-Null
"Registered: HireFlow public apply link (runs at login)"
