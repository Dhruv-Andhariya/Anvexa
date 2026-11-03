<#
  Starts (or repairs) the Piston code runner used by the DSA assessment. Safe to run more than once.

    powershell -ExecutionPolicy Bypass -File infra\piston\start-piston.ps1            # start / repair, then smoke-test
    powershell -ExecutionPolicy Bypass -File infra\piston\start-piston.ps1 -Recreate  # rebuild the container with the current piston.env

  What it guarantees (and refuses to continue without):
    * Piston is published on 127.0.0.1 ONLY. It has no login, so it must never be reachable from the network.
    * It sits on Docker's default network, NOT on HireFlow's (hireflow_default), so it cannot see the databases.
    * Packages live in a named Docker volume, not in a folder on C:\.
    * Python, Java and C++ are installed, and a real program in each language runs in the sandbox.
  Needs: Docker Desktop (WSL2 backend, which provides cgroup v2). Docs: docs\dsa-piston-hosting.md
#>
param(
  [switch]$Recreate,
  [switch]$SkipSmokeTest
)

$ErrorActionPreference = 'Stop'
$Name    = 'hireflow-piston'
$Volume  = 'hireflow_piston_data'
# Pinned to an exact image digest, so a later upstream change cannot alter the sandbox unnoticed.
$Image   = 'ghcr.io/engineer-man/piston@sha256:2f66b7456189c4d713aa986d98eccd0b6ee16d26c7ec5f21b30e942756fd127a'
$Port    = 2000
$Url     = "http://127.0.0.1:$Port"
$EnvFile = Join-Path $PSScriptRoot 'piston.env'
$Packages = @(@('python', '3.12.0'), @('java', '15.0.2'), @('gcc', '10.2.0'))

function Say($m)  { Write-Host ("{0}  {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }
function Fail($m) { Write-Host ("{0}  ERROR: {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -ForegroundColor Red; exit 1 }
function Docker-Up { docker info *> $null; return ($LASTEXITCODE -eq 0) }
function Wait-For($what, $seconds, [scriptblock]$ready) {
  for ($i = 0; $i -lt $seconds; $i += 3) { if (& $ready) { return $true }; Start-Sleep 3 }
  Fail "$what not ready after $seconds s"
}

if (-not (Test-Path $EnvFile)) { Fail "settings file missing: $EnvFile" }

# 1. Docker Desktop
if (-not (Docker-Up)) {
  $exe = @("$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe", "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $exe) { Fail 'Docker Desktop is not running and was not found. Install or start it.' }
  Say 'starting Docker Desktop ...'
  Start-Process $exe
  Wait-For 'Docker' 300 { Docker-Up } | Out-Null
}
Say 'Docker is running'

# 2. The container
$exists = (docker ps -a --filter "name=^/$Name$" --format '{{.Names}}') -eq $Name
if ($exists -and $Recreate) { Say 'removing the old container (the package volume is kept)'; docker rm -f $Name *> $null; $exists = $false }
if (-not $exists) {
  Say 'creating the Piston container (first run pulls ~1.4 GB) ...'
  docker run -d --name $Name --privileged --restart unless-stopped `
    -p "127.0.0.1:${Port}:2000" -v "${Volume}:/piston" --env-file $EnvFile $Image *> $null
  if ($LASTEXITCODE -ne 0) { Fail 'docker run failed' }
} elseif ((docker inspect -f '{{.State.Running}}' $Name) -ne 'true') {
  Say 'starting the existing container'
  docker start $Name *> $null
}

# 3. Wait for the API
Wait-For 'the Piston API' 90 { try { (Invoke-RestMethod "$Url/api/v2/runtimes" -TimeoutSec 5) -ne $null } catch { $false } } | Out-Null
Say "Piston API answers on $Url"

# 4. Safety checks
$published = (docker port $Name) -join ' '
if ($published -notmatch '127\.0\.0\.1:' -or $published -match '0\.0\.0\.0:|\[::\]:') { Fail "Piston is published beyond localhost ($published). Run again with -Recreate." }
$nets = (docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' $Name)
if ($nets -match 'hireflow_default') { Fail 'Piston is attached to the HireFlow network. Run again with -Recreate.' }
Say "published only on localhost ($published); networks: $nets"

# 5. Languages
# Ask Piston's own package list (the `gcc` package provides the runtimes called `c` and `c++`).
$offered = @(Invoke-RestMethod "$Url/api/v2/packages" -TimeoutSec 60)
foreach ($p in $Packages) {
  $have = $offered | Where-Object { $_.language -eq $p[0] -and $_.language_version -eq $p[1] -and $_.installed }
  if ($have) { Say "$($p[0]) $($p[1]) already installed"; continue }
  Say "installing $($p[0]) $($p[1]) (a few minutes) ..."
  $body = @{ language = $p[0]; version = $p[1] } | ConvertTo-Json
  try { Invoke-RestMethod -Uri "$Url/api/v2/packages" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 900 | Out-Null }
  catch { Fail "installing $($p[0]) failed: $($_.Exception.Message)" }
}

# 6. A real program in each language, inside the sandbox
if (-not $SkipSmokeTest) {
  $tests = @(
    @{ lang = 'python'; file = 'main.py';   code = 'print(sum(map(int, input().split())))' },
    @{ lang = 'java';   file = 'Main.java'; code = 'public class Main { public static void main(String[] a) { java.util.Scanner s = new java.util.Scanner(System.in); System.out.println(s.nextInt() + s.nextInt()); } }' },
    @{ lang = 'c++';    file = 'main.cpp';  code = "#include <iostream>`nint main(){ int a,b; std::cin>>a>>b; std::cout<<a+b<<std::endl; }" }
  )
  foreach ($t in $tests) {
    $body = @{ language = $t.lang; version = '*'; files = @(@{ name = $t.file; content = $t.code }); stdin = "2 3`n" } | ConvertTo-Json -Depth 5
    $r = Invoke-RestMethod -Uri "$Url/api/v2/execute" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 120
    if (($r.run.stdout + '').Trim() -ne '5') { Fail "smoke test failed for $($t.lang): $($r | ConvertTo-Json -Depth 4 -Compress)" }
    Say "smoke test passed: $($t.lang) -> 5"
  }
}
Say "Piston is ready. Backend setting: PISTON_URL=$Url (the default)."
