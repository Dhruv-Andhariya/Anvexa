# Starts the whole local stack and opens the public links (Cloudflare quick tunnels) - safe to run more than once.
#   1. Docker Desktop  2. Postgres / Redis / Mailpit  3. cloudflared tunnel -> careers site :3300, URL written to
#   CAREERS_SITE_URL in .env; when a code runner is set up (PISTON_URL in .env) a second tunnel -> candidate app
#   :3001 (DSA coding round), URL written to CANDIDATE_APP_URL  4. pnpm dev (API :4000, HR :3000, careers :3300,
#   candidate app :3001)  5. AI worker :8000
#   6. GD worker :8010 + AI moderator bot (workers/gd-agent)
# A quick tunnel gets a NEW random https://<words>.trycloudflare.com URL every time cloudflared starts, so Apply links
# in posts made before a restart point to the old URL. The API edits those posts at start (same post, new link);
# any it could not edit are flagged on the HR Publish page ("Update apply link in posts"). Assessment and DSA links
# already emailed stop working after such a restart.
# Logs: %LOCALAPPDATA%\hireflow\logs.  Run at Windows login: scripts\register-autostart.ps1

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
$logs = Join-Path $env:LOCALAPPDATA 'hireflow\logs'
New-Item -ItemType Directory -Force $logs | Out-Null
$log = Join-Path $logs 'start-public.log'
function Say($msg) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"; Add-Content $log $line; Write-Host $line }
function Listening($port) { [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) }
function WaitFor($what, $seconds, [scriptblock]$ready) {
  for ($i = 0; $i -lt $seconds; $i += 3) { if (& $ready) { Say "$what ready"; return $true }; Start-Sleep 3 }
  Say "ERROR: $what not ready after $seconds s"; return $false
}
function TunnelUrl($tunnelLog) {
  if (-not (Test-Path $tunnelLog)) { return $null }
  $m = Select-String -Path $tunnelLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches | Select-Object -Last 1
  if ($m) { $m.Matches[-1].Value } else { $null }
}
function EnvValue($key) {
  $line = Get-Content $envFile | Where-Object { $_ -match "^$key=" } | Select-Object -First 1
  if ($line) { ("$line" -replace "^$key=", '').Trim() } else { '' }
}
# Sets (or with $null removes) KEY=value in .env; $true when the file changed.
function SetEnv($key, $value) {
  $lines = @(Get-Content $envFile)
  $current = EnvValue $key
  if ($null -eq $value) {
    if (-not ($lines -match "^$key=")) { return $false }
    $lines = $lines | Where-Object { $_ -notmatch "^$key=" }
  } else {
    if ($current.TrimEnd('/') -eq $value -and ($lines -match "^$key=")) { return $false }
    if ($lines -match "^$key=") { $lines = $lines -replace "^$key=.*$", "$key=$value" } else { $lines += "$key=$value" }
  }
  [IO.File]::WriteAllLines($envFile, [string[]]$lines, (New-Object Text.UTF8Encoding $false)) # no BOM
  return $true
}
# The cloudflared process of one local port (each tunnel has its own process and log).
function TunnelProcess($port) {
  Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -match "localhost:$port\b" }
}
# A quick tunnel to a local port (reused while it still answers); returns its public URL or $null.
function Tunnel($port, $tunnelLog) {
  $url = $null
  if (TunnelProcess $port) {
    $url = TunnelUrl $tunnelLog
    # A quick tunnel that lost its connection is deleted by Cloudflare ("Tunnel not found") and never comes back.
    if ($url -and (Listening $port)) {
      try { Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 20 | Out-Null } catch {
        if (-not $_.Exception.Response) { Say "tunnel $url is dead - starting a new one"; $url = $null }
      }
    }
  }
  if ($url) { return $url }
  $old = TunnelProcess $port
  $old | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  # The old process holds the log open; until it has exited the log cannot be deleted, and its dead URL would be
  # read back as the "new" one.
  $old | ForEach-Object { Wait-Process -Id $_.ProcessId -Timeout 15 -ErrorAction SilentlyContinue }
  $cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
  if (-not $cloudflared) {
    $cloudflared = @("${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe", "$env:ProgramFiles\cloudflared\cloudflared.exe") |
      Where-Object { Test-Path $_ } | Select-Object -First 1
  }
  if (-not $cloudflared) { Say 'ERROR: cloudflared not found (winget install --id Cloudflare.cloudflared)'; return $null }
  Remove-Item $tunnelLog -ErrorAction SilentlyContinue
  if (Test-Path $tunnelLog) { Say "ERROR: could not delete $tunnelLog (old cloudflared still running?)"; return $null }
  Start-Process -WindowStyle Hidden $cloudflared -ArgumentList 'tunnel', '--no-autoupdate', '--url', "http://localhost:$port", '--logfile', "`"$tunnelLog`""
  if (-not (WaitFor "Cloudflare tunnel URL (:$port)" 60 { [bool](TunnelUrl $tunnelLog) })) { return $null }
  return TunnelUrl $tunnelLog
}
# Stops a dev server and the pnpm/turbo/nest/next processes that launched it, so `pnpm dev` can start clean.
function StopPort($port) {
  $conn = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $conn) { return }
  $top = $conn.OwningProcess
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$top"
  while ($p) {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"
    if (-not $parent -or $parent.CommandLine -notmatch 'pnpm|turbo|nest|next|node') { break }
    $top = $parent.ProcessId; $p = $parent
  }
  taskkill /PID $top /T /F *> $null
}

Say '--- starting HireFlow public stack ---'

# 1. Docker Desktop
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  $dockerExe = @("$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe", "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $dockerExe) { Say 'ERROR: Docker Desktop not found'; exit 1 }
  Start-Process $dockerExe
  if (-not (WaitFor 'Docker' 300 { docker info *> $null; $LASTEXITCODE -eq 0 })) { exit 1 }
}

# 2. Postgres, Redis, Mailpit
docker compose -f (Join-Path $root 'infra\docker\docker-compose.yml') up -d *>> $log
WaitFor 'Postgres' 120 { (docker exec hireflow-postgres-1 pg_isready -U hire -d hireflow 2>$null) -match 'accepting' } | Out-Null

# 3. Cloudflare quick tunnels (no account needed). They can start before the sites are up.
$publicUrl = Tunnel 3300 (Join-Path $logs 'cloudflared.log')
if (-not $publicUrl) { exit 1 }
Say "public URL: $publicUrl"
# Every Apply link the API builds starts with CAREERS_SITE_URL; the API reads it once at start, so restart on change.
$changed = SetEnv 'CAREERS_SITE_URL' $publicUrl
if ($changed) { Say 'CAREERS_SITE_URL updated in .env - the API will update the Apply link in existing posts when it starts' }

# DSA coding round: its invitations are emailed only while CANDIDATE_APP_URL is public, and only a working code runner
# makes the test fair (without one every submission fails and the student is graded 0 -> rejection email).
# Piston itself: infra/piston/start-piston.ps1 (docs/dsa-piston-hosting.md).
$dsaUrl = $null
if (EnvValue 'PISTON_URL') {
  $dsaUrl = Tunnel 3001 (Join-Path $logs 'cloudflared-dsa.log')
  if ($dsaUrl) { Say "DSA coding test URL: $dsaUrl" } else { Say 'ERROR: no tunnel for the DSA coding test - its invitations wait' }
} else {
  TunnelProcess 3001 | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Say 'PISTON_URL is not set in .env: DSA coding round invitations wait until a code runner is set up'
}
# localhost is never emailed, so without a tunnel coding invitations wait (round-engine link.ts)
if (SetEnv 'CANDIDATE_APP_URL' $(if ($dsaUrl) { $dsaUrl } else { 'http://localhost:3001' })) { $changed = $true; Say 'CANDIDATE_APP_URL updated in .env' }
if ($changed -and (Listening 4000)) { Say 'restarting dev servers for the new URL'; 4000, 3000, 3300, 3001 | ForEach-Object { StopPort $_ }; Start-Sleep 3 }

# 4. API + dashboards (pnpm is not on PATH on this laptop, so the pinned version runs through npx)
if (-not (Listening 4000) -or -not (Listening 3300) -or ($dsaUrl -and -not (Listening 3001))) {
  if (Listening 4000) { 4000, 3000, 3300, 3001 | ForEach-Object { StopPort $_ }; Start-Sleep 3 }
  # CAREERS_SITE_URL is the live tunnel here, so the API may rewrite old posts to it at start even when .env keeps
  # PUBLISHER_AUTO_REFRESH_LINKS=false (that guards plain `pnpm dev` with a localhost URL). The process env wins
  # over .env: process.loadEnvFile never overwrites a variable that is already set.
  Start-Process -WindowStyle Hidden -WorkingDirectory $root powershell.exe `
    -ArgumentList '-NoProfile', '-Command', "`$env:PUBLISHER_AUTO_REFRESH_LINKS='true'; npx -y pnpm@9.15.0 dev *> '$logs\dev.log'"
}
if (-not (WaitFor 'API + careers site' 300 { (Listening 4000) -and (Listening 3300) })) { exit 1 }
if ($dsaUrl) { WaitFor 'candidate app (DSA)' 300 { Listening 3001 } | Out-Null }

# 5. AI worker (JD generation); the apply link works without it
if (-not (Listening 8000) -and (Get-Command uv -ErrorAction SilentlyContinue)) {
  Start-Process -WindowStyle Hidden -WorkingDirectory (Join-Path $root 'workers\ai-worker') powershell.exe `
    -ArgumentList '-NoProfile', '-Command', "uv run python -m ai_worker *> '$logs\ai-worker.log'"
}

# 6. GD worker (M18 group discussion): Whisper + evaluation API on :8010, and the AI moderator bot (LiveKit agent).
#    Both are free and local; the GD itself (room, timer, banner) runs without them, only voice and results wait.
$gdAgent = Join-Path $root 'workers\gd-agent'
if ((Test-Path $gdAgent) -and (Get-Command uv -ErrorAction SilentlyContinue)) {
  if (-not (Listening 8010)) {
    Start-Process -WindowStyle Hidden -WorkingDirectory $gdAgent powershell.exe `
      -ArgumentList '-NoProfile', '-Command', "uv run python -m gd_agent api *> '$logs\gd-worker.log'"
  }
  $moderator = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match 'gd_agent moderator' }
  if (-not $moderator) {
    Start-Process -WindowStyle Hidden -WorkingDirectory $gdAgent powershell.exe `
      -ArgumentList '-NoProfile', '-Command', "uv run python -m gd_agent moderator start *> '$logs\gd-moderator.log'"
  }
}

WaitFor "public link $publicUrl" 120 {
  try { (Invoke-WebRequest "$publicUrl" -UseBasicParsing -TimeoutSec 20).StatusCode -eq 200 } catch { $false }
} | Out-Null
Say "Apply links now start with: $publicUrl"
if ($dsaUrl) {
  WaitFor "DSA coding test $dsaUrl" 120 {
    try { (Invoke-WebRequest "$dsaUrl" -UseBasicParsing -TimeoutSec 20).StatusCode -lt 500 } catch { [bool]$_.Exception.Response }
  } | Out-Null
  Say "DSA coding test links now start with: $dsaUrl/dsa/"
}
Say '--- done ---'
