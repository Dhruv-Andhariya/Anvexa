# Serves the stack for the PUBLIC links (called by start-public.ps1). The three web apps run as PRODUCTION builds
# (next build + next start): a development server sends ~10 MB of unminified JavaScript per page and compiles each
# page on its first visit, which over a quick tunnel takes about a minute - students saw "site can't be reached".
# The API keeps running in watch mode. If a web build fails, everything falls back to `pnpm dev` (slow, but working).
# Logs: %LOCALAPPDATA%\hireflow\logs (dev.log = API, web-<app>.log = each site, build.log = the builds).

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $env:LOCALAPPDATA 'hireflow\logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$pnpm = 'npx -y pnpm@9.15.0'
$env:PUBLISHER_AUTO_REFRESH_LINKS = 'true'
Set-Location $root

function Hidden($command, $log) {
  Start-Process -WindowStyle Hidden -WorkingDirectory $root powershell.exe -ArgumentList '-NoProfile', '-Command', "`$env:PUBLISHER_AUTO_REFRESH_LINKS='true'; $command *> '$log'"
}

$apps = @(@{ name = 'careers-site'; port = 3300 }, @{ name = 'candidate-app'; port = 3001 }, @{ name = 'hr-dashboard'; port = 3000 })
$filters = ($apps | ForEach-Object { "--filter=$($_.name)" }) -join ' '
Invoke-Expression "$pnpm turbo run build $filters" *> (Join-Path $logs 'build.log')
$built = $LASTEXITCODE -eq 0

if (-not $built) {
  Add-Content (Join-Path $logs 'build.log') 'BUILD FAILED - falling back to pnpm dev for every app'
  Hidden "$pnpm dev" (Join-Path $logs 'dev.log')
  exit 0
}

Hidden "$pnpm --filter api dev" (Join-Path $logs 'dev.log')
foreach ($a in $apps) {
  Hidden "$pnpm --filter $($a.name) exec next start -p $($a.port)" (Join-Path $logs "web-$($a.name).log")
}
