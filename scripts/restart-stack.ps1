#requires -Version 7
<#
.SYNOPSIS
  Force-restart the Caisson dev:app stack (server + Vite + Electron + agent host) cleanly.

.DESCRIPTION
  Encodes the correct, reliable restart procedure (discovered the hard way) so it
  doesn't have to be re-derived each time:
    1. Kill the dev:app COORDINATOR tree first (scripts/dev-app.mjs) via taskkill /T,
       so the server's manual-restart supervisor can't respawn the server mid-kill.
       The coordinator tree is: pnpm dev -> supervisor -> server -> agent host; Vite; Electron.
    2. Defensively free ports 4040 (server) / 5173 (Vite) / 8788 (channel).
    3. Kill repo Electron + the agent host (host re-spawns fresh under the new dev:app,
       so the new server discovers its new port — avoids the stale-host-endpoint bug).
    4. Wait until the ports are free.
    5. Relaunch `pnpm dev:app` detached (logs -> data/dev-app.log[.err]).
    6. Poll readiness (server 4040 + Vite 5173 + host lock) and print a summary.

  Windows-only (the dogfood platform). Force by default — no confirm. If a parallel
  session is running its own stack, this WILL take it down.

.PARAMETER Check    Report what's running and exit. No kill, no launch.
.PARAMETER NoLaunch Kill + free ports, but do not relaunch.
.PARAMETER SkipKill Skip the kill phase; just relaunch + wait (stack already down).
#>
[CmdletBinding()]
param(
  [switch]$Check,
  [switch]$NoLaunch,
  [switch]$SkipKill
)

$ErrorActionPreference = 'Stop'
$repo     = Split-Path -Parent $PSScriptRoot   # scripts/.. = repo root
$ports    = 4040, 5173, 8788
$hostLock = Join-Path $repo 'data/agent-host/host.lock.json'
$logFile  = Join-Path $repo 'data/dev-app.log'

function Get-Coordinators {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'dev-app\.mjs' }
}
function Get-PortOwners {
  $ids = @()
  foreach ($p in $ports) {
    $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    if ($c) { $ids += $c.OwningProcess }
  }
  $ids | Sort-Object -Unique
}
function Get-HostPid {
  if (Test-Path $hostLock) {
    try { return (Get-Content $hostLock -Raw | ConvertFrom-Json).pid } catch { return $null }
  }
  return $null
}
function Get-RepoElectron {
  $escaped = [regex]::Escape($repo)
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match $escaped -or $_.ExecutablePath -match $escaped } |
    Select-Object -ExpandProperty ProcessId
}
function Test-PortsFree {
  foreach ($p in $ports) {
    if (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) { return $false }
  }
  return $true
}
function Show-State {
  foreach ($p in $ports) {
    $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    if ($c) { Write-Host "  port $p  LISTENING (pid $($c[0].OwningProcess))" }
    else    { Write-Host "  port $p  free" }
  }
  $coord = @(Get-Coordinators)
  Write-Host "  coordinator(s): $(if ($coord) { ($coord.ProcessId -join ', ') } else { 'none' })"
  $hp = Get-HostPid
  if ($hp -and (Get-Process -Id $hp -ErrorAction SilentlyContinue)) { Write-Host "  host: pid $hp ALIVE" }
  else { Write-Host "  host: down" }
  Write-Host "  repo electron procs: $(@(Get-RepoElectron).Count)"
}

Write-Host "== Caisson dev:app stack =="
Write-Host "Current state:"
Show-State

if ($Check) { return }

if (-not $SkipKill) {
  Write-Host "`n== Killing dev:app tree (force) =="
  foreach ($c in @(Get-Coordinators)) {
    Write-Host "  taskkill /F /T coordinator pid $($c.ProcessId)"
    & taskkill /F /T /PID $c.ProcessId *> $null
  }
  Start-Sleep -Milliseconds 800
  foreach ($id in (Get-PortOwners)) {
    try { Stop-Process -Id $id -Force -ErrorAction Stop; Write-Host "  killed port-owner pid $id" } catch {}
  }
  foreach ($id in (Get-RepoElectron)) {
    try { Stop-Process -Id $id -Force -ErrorAction Stop; Write-Host "  killed electron pid $id" } catch {}
  }
  $hp = Get-HostPid
  if ($hp) { & taskkill /F /T /PID $hp *> $null; Write-Host "  killed agent host pid $hp" }

  $deadline = (Get-Date).AddSeconds(20)
  while (-not (Test-PortsFree) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if (Test-PortsFree) { Write-Host "  ports free." }
  else { Write-Warning "ports still occupied after 20s:"; Show-State }
}

if ($NoLaunch) { Write-Host "`n-NoLaunch set; not relaunching."; return }

Write-Host "`n== Relaunching pnpm dev:app (detached; logs -> $logFile) =="
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'pnpm dev:app' `
  -WorkingDirectory $repo -WindowStyle Hidden `
  -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"

Write-Host "== Waiting for readiness (server 4040 + Vite 5173 + host) =="
$deadline = (Get-Date).AddSeconds(120)
$serverUp = $false; $viteUp = $false; $hostUp = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  if (-not $serverUp) {
    try { if ((Invoke-RestMethod 'http://localhost:4040/api/projects' -TimeoutSec 3).projects) { $serverUp = $true } } catch {}
  }
  if (-not $viteUp -and (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue)) { $viteUp = $true }
  $hp = Get-HostPid
  if ($hp -and (Get-Process -Id $hp -ErrorAction SilentlyContinue)) { $hostUp = $true }
  if ($serverUp -and $viteUp -and $hostUp) { break }
}

Write-Host "`n== Result =="
Show-State
if ($serverUp -and $viteUp) {
  Write-Host "STACK UP." -ForegroundColor Green
  if (-not $hostUp) { Write-Warning "host not confirmed yet — it may still be spawning (check data/agent-host/host.lock.json)." }
} else {
  Write-Warning "Stack not fully ready in 120s. Tail $logFile and $logFile.err for errors."
  exit 1
}
