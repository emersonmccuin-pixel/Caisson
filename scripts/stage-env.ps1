#requires -Version 7
<#
.SYNOPSIS
  Manage the Caisson staging stack (Caisson-Staging worktree, ports :5180 / :4150).

.DESCRIPTION
  Three subcommands:

    up -Branch <name>   Self-bootstrap + sync + build + boot. Idempotent.
                        Tears down any existing staging stack first, then:
                          1. Ensures the staging worktree (git worktree add once).
                          2. pnpm install once if node_modules is absent.
                          3. git fetch + reset --hard origin/dev + merge <branch>.
                             Fails loudly on conflict; aborts the merge cleanly.
                          4. Rebuilds server / agent-host / mcp / desktop-main bundles.
                          5. Boots Electron-supervised stack (api + agent-host) + Vite web.
                          6. Health-checks both; fails loudly if either does not come up.
                          7. Prints staging URL + what changed.

    down                Kill the staging stack. ALWAYS verifies process CommandLine
                        matches the staging signature before killing any PID.

    status              Report running/dead state, branch, ports.

  Staging worktree : E:\Claude Code Projects\Personal\Caisson-Staging  (staging branch)
  API port         : 4150   (Electron main supervises api + agent-host children)
  Web port         : 5180   (Vite dev server; Electron window loads this URL)
  Data / sandbox   : %APPDATA%\Caisson-staging-sandbox
  Pidfile          : %APPDATA%\Caisson-staging-sandbox\.stage-env.json
  Logs             : %APPDATA%\Caisson-staging-sandbox\diagnostics\

  Safe: NEVER kills a process unless its CommandLine matches the staging worktree
  path. Cannot collide with the main dev stack (:5173/:4040), the packaged
  per-user app (:4040), or any Claude Code session.

.PARAMETER Command
  up | down | status

.PARAMETER Branch
  Branch to merge on top of origin/dev when Command is up. Required for up.

.EXAMPLE
  .\stage-env.ps1 up -Branch my-feature-branch
  .\stage-env.ps1 status
  .\stage-env.ps1 down
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory, Position = 0)]
  [ValidateSet('up', 'down', 'status')]
  [string]$Command,

  [string]$Branch   # required for 'up'; ignored for 'down'/'status'
)

$ErrorActionPreference = 'Stop'

# ---- Constants ----------------------------------------------------------------
$REPO           = Split-Path -Parent $PSScriptRoot
$STAGING_DIR    = 'E:\Claude Code Projects\Personal\Caisson-Staging'
$STAGING_BRANCH = 'staging'
$APPDATA_BASE   = $env:APPDATA ?? [Environment]::GetFolderPath('ApplicationData')
$SANDBOX_DIR    = Join-Path $APPDATA_BASE 'Caisson-staging-sandbox'
$API_PORT       = 4150
$WEB_PORT       = 5180
$PIDFILE        = Join-Path $SANDBOX_DIR '.stage-env.json'
$HOST_LOCK      = Join-Path $SANDBOX_DIR 'agent-host\host.lock.json'
$LOG_DIR        = Join-Path $SANDBOX_DIR 'diagnostics'

# Regex that uniquely identifies this staging instance in a process CommandLine.
# The main dev stack uses a different path (...\PC-PTY-Chat); the packaged per-user
# app has no PC-PTY-Chat path in its children's cmdlines.
$STAGING_SIG    = [regex]::Escape($STAGING_DIR)

# ---- Process helpers ----------------------------------------------------------

# NOTE: parameters are named $ProcId, never $Pid — $PID is a read-only
# automatic variable in PowerShell and binding a param to it throws
# "Cannot overwrite variable Pid because it is read-only or constant."
function Get-ProcCmdline([int]$ProcId) {
  try {
    return (Get-CimInstance Win32_Process -Filter "ProcessId=$ProcId" `
      -ErrorAction SilentlyContinue)?.CommandLine ?? ''
  } catch { return '' }
}

function Test-PidAlive([int]$ProcId) {
  return $ProcId -gt 0 -and ($null -ne (Get-Process -Id $ProcId -ErrorAction SilentlyContinue))
}

# Kill the process tree rooted at $ProcId only if its CommandLine matches $Sig.
# No-ops gracefully when the process is already dead.
function Invoke-KillIfSafe([int]$ProcId, [string]$Sig, [string]$Label) {
  if ($ProcId -le 0) { return }
  if (-not (Test-PidAlive $ProcId)) {
    Write-Host "  $Label pid $ProcId : already gone"
    return
  }
  $cmd = Get-ProcCmdline $ProcId
  if (-not ($cmd -match $Sig)) {
    Write-Warning "SKIPPED kill of $Label pid $ProcId -- command line does not match staging signature:`n  $cmd"
    return
  }
  Write-Host "  killing $Label (pid $ProcId)"
  & taskkill /F /T /PID $ProcId *> $null
}

function Read-Pidfile {
  if (-not (Test-Path $PIDFILE)) { return $null }
  try   { return Get-Content $PIDFILE -Raw | ConvertFrom-Json }
  catch { Write-Warning "Corrupted pidfile at $PIDFILE -- ignoring."; return $null }
}

function Write-Pidfile([int]$ElectronWrapperPid, [int]$ViteWrapperPid) {
  $null = New-Item -Path $SANDBOX_DIR -ItemType Directory -Force
  [ordered]@{
    electronWrapperPid = $ElectronWrapperPid
    viteWrapperPid     = $ViteWrapperPid
    apiPort            = $API_PORT
    webPort            = $WEB_PORT
    sandboxDir         = $SANDBOX_DIR
    stagingDir         = $STAGING_DIR
    startedAt          = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  } | ConvertTo-Json | Set-Content $PIDFILE -Encoding UTF8
}

# ---- Readiness polling --------------------------------------------------------

function Wait-ApiReady([int]$TimeoutSec = 90) {
  $url      = "http://127.0.0.1:$API_PORT/api/projects"
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  Write-Host -NoNewline "  polling API :$API_PORT "
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-RestMethod $url -TimeoutSec 3 -ErrorAction Stop
      if ($r) { Write-Host ' up.'; return $true }
    } catch { }
    Write-Host -NoNewline '.'
    Start-Sleep -Milliseconds 1500
  }
  Write-Host ''
  return $false
}

function Wait-ViteReady([int]$TimeoutSec = 90) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  Write-Host -NoNewline "  polling Vite :$WEB_PORT "
  while ((Get-Date) -lt $deadline) {
    if (Get-NetTCPConnection -LocalPort $WEB_PORT -State Listen -ErrorAction SilentlyContinue) {
      Write-Host ' up.'
      return $true
    }
    Write-Host -NoNewline '.'
    Start-Sleep -Milliseconds 1500
  }
  Write-Host ''
  return $false
}

# ---- Status display -----------------------------------------------------------

function Show-Status {
  $pids = Read-Pidfile
  if (-not $pids) {
    Write-Host '  staging : DOWN (no pidfile)'
    return
  }
  $eAlive = Test-PidAlive $pids.electronWrapperPid
  $vAlive = Test-PidAlive $pids.viteWrapperPid
  $state  = if ($eAlive -and $vAlive) { 'UP' } elseif ($eAlive -or $vAlive) { 'PARTIAL' } else { 'DOWN' }
  Write-Host "  staging  : $state"
  Write-Host "  Electron : pid $($pids.electronWrapperPid) $(if ($eAlive) {'ALIVE'} else {'DEAD'})"
  Write-Host "  Vite     : pid $($pids.viteWrapperPid) $(if ($vAlive) {'ALIVE'} else {'DEAD'})"
  Write-Host "  API      : http://127.0.0.1:$($pids.apiPort)"
  Write-Host "  Web      : http://127.0.0.1:$($pids.webPort)"
  if (Test-Path (Join-Path $STAGING_DIR '.git')) {
    try {
      $br  = & git -C $STAGING_DIR rev-parse --abbrev-ref HEAD 2>$null
      $sha = & git -C $STAGING_DIR rev-parse --short HEAD 2>$null
      Write-Host "  Branch   : $br @ $sha"
    } catch { }
  }
}

# ==============================================================================
# COMMAND: status
# ==============================================================================

if ($Command -eq 'status') {
  Write-Host '== Caisson Staging status =='
  Show-Status
  return
}

# ==============================================================================
# COMMAND: down
# ==============================================================================

if ($Command -eq 'down') {
  Write-Host '== Tearing down Caisson Staging =='

  $pids = Read-Pidfile
  if (-not $pids) {
    Write-Host '  No pidfile -- staging already down (or never started).'
    return
  }

  # Polite agent-host shutdown so it can tear down its live PTY children cleanly
  if (Test-Path $HOST_LOCK) {
    try {
      $lock = Get-Content $HOST_LOCK -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
      if ($lock?.port) {
        Write-Host '  Requesting polite agent-host shutdown...'
        Invoke-RestMethod "http://127.0.0.1:$($lock.port)/command" `
          -Method POST -ContentType 'application/json' `
          -Body '{"command":{"type":"shutdown","mode":"host-exit"}}' `
          -TimeoutSec 3 -ErrorAction SilentlyContinue | Out-Null
        Start-Sleep -Milliseconds 1000
      }
    } catch { }
  }

  # Kill Electron wrapper tree (cmd.exe + electron.exe + api child + host child)
  Invoke-KillIfSafe $pids.electronWrapperPid $STAGING_SIG 'Electron wrapper'

  # Kill Vite wrapper tree (cmd.exe + node vite)
  Invoke-KillIfSafe $pids.viteWrapperPid $STAGING_SIG 'Vite wrapper'

  # Belt-and-suspenders: reclaim staging ports if a matching process still holds them
  # (covers cases where the process outlived its wrapper PID)
  foreach ($port in @($API_PORT, $WEB_PORT)) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
      $ownerPid = $conn[0].OwningProcess
      $ownerCmd = Get-ProcCmdline $ownerPid
      if ($ownerCmd -match $STAGING_SIG) {
        Write-Host "  belt-and-suspenders: reclaiming :$port (pid $ownerPid)"
        & taskkill /F /T /PID $ownerPid *> $null
      }
      # Never touch a port-owner that does not match the staging signature
    }
  }

  Remove-Item $PIDFILE   -Force -ErrorAction SilentlyContinue
  Remove-Item $HOST_LOCK -Force -ErrorAction SilentlyContinue
  Write-Host '  Staging down.'
  return
}

# ==============================================================================
# COMMAND: up
# ==============================================================================

if ([string]::IsNullOrWhiteSpace($Branch)) {
  Write-Error "'up' requires -Branch <name>  e.g.:  .\stage-env.ps1 up -Branch my-feature-branch"
}

Write-Host "== Caisson Staging: up -Branch $Branch =="

# ---- Step 0: Clear any existing staging stack (makes up idempotent) ----------

$existingPids = Read-Pidfile
if ($existingPids) {
  Write-Host "`n-- Clearing existing staging stack (idempotent reset) --"
  Invoke-KillIfSafe $existingPids.electronWrapperPid $STAGING_SIG 'Electron wrapper'
  Invoke-KillIfSafe $existingPids.viteWrapperPid     $STAGING_SIG 'Vite wrapper'
  Remove-Item $PIDFILE   -Force -ErrorAction SilentlyContinue
  Remove-Item $HOST_LOCK -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2   # give OS a moment to release ports
}

# ---- Step 1: Ensure staging worktree -----------------------------------------

Write-Host "`n-- Step 1: Staging worktree ($STAGING_DIR) --"

if (-not (Test-Path (Join-Path $STAGING_DIR '.git'))) {
  Write-Host "  Worktree absent -- creating on branch '$STAGING_BRANCH'..."

  # Create the staging branch from origin/dev (or local dev as fallback)
  $branchExists = & git -C $REPO branch --list $STAGING_BRANCH 2>$null
  if (-not $branchExists) {
    $devRef = & git -C $REPO rev-parse origin/dev 2>$null
    if ($LASTEXITCODE -ne 0) { $devRef = & git -C $REPO rev-parse dev 2>$null }
    if ($LASTEXITCODE -ne 0) { Write-Error "Cannot resolve dev/origin/dev in repo" }
    & git -C $REPO branch $STAGING_BRANCH $devRef
    if ($LASTEXITCODE -ne 0) { Write-Error "Failed to create branch '$STAGING_BRANCH'" }
  }

  & git -C $REPO worktree add $STAGING_DIR $STAGING_BRANCH
  if ($LASTEXITCODE -ne 0) { Write-Error 'git worktree add failed -- see error above' }
  Write-Host '  Worktree created.'
} else {
  Write-Host '  Worktree exists.'
}

# First-bootstrap: install deps when node_modules is absent (one-time cost ~1 min)
if (-not (Test-Path (Join-Path $STAGING_DIR 'node_modules'))) {
  Write-Host '  node_modules absent -- running pnpm install (first bootstrap; may take a minute)...'
  & pnpm install --dir $STAGING_DIR
  if ($LASTEXITCODE -ne 0) { Write-Error 'pnpm install failed in staging worktree' }
  Write-Host '  pnpm install done.'
} else {
  Write-Host '  node_modules present -- skipping install.'
}

# ---- Step 2: Git sync --------------------------------------------------------

Write-Host "`n-- Step 2: Git sync (origin/dev + $Branch) --"

Write-Host '  Fetching...'
$null = & git -C $STAGING_DIR fetch --quiet origin 2>&1
if ($LASTEXITCODE -ne 0) { Write-Warning '  git fetch failed (offline?) -- continuing with local refs.' }

Write-Host '  Resetting to origin/dev (clean base)...'
$null = & git -C $STAGING_DIR reset --hard origin/dev 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Warning '  origin/dev unavailable -- falling back to local dev branch.'
  $null = & git -C $STAGING_DIR reset --hard dev 2>&1
  if ($LASTEXITCODE -ne 0) { Write-Error 'Cannot reset staging to dev baseline' }
}

Write-Host "  Merging $Branch onto dev baseline..."
$mergeOutput = & git -C $STAGING_DIR merge --no-edit $Branch 2>&1
if ($LASTEXITCODE -ne 0) {
  # Capture conflicting file list BEFORE aborting the merge
  $unmerged = & git -C $STAGING_DIR diff --name-only --diff-filter=U 2>$null
  & git -C $STAGING_DIR merge --abort 2>$null

  $conflictBlock = if ($unmerged) {
    ($unmerged | ForEach-Object { "  $_" }) -join "`n"
  } else {
    '  (no explicit conflict markers; see merge output below)'
  }
  $mergeDetail = ($mergeOutput | Where-Object { $_ -match 'CONFLICT|error|fatal' }) -join "`n"

  Write-Error @"

MERGE CONFLICT -- staging reset cleanly.

Branch '$Branch' cannot merge onto origin/dev.
Conflicting files:
$conflictBlock

Merge output:
$mergeDetail

Fix conflicts in '$Branch' and push before re-running  stage-env.ps1 up.
Staging worktree: $STAGING_DIR
"@
}

$stagingSha    = & git -C $STAGING_DIR rev-parse --short HEAD 2>$null
$stagingBranch = & git -C $STAGING_DIR rev-parse --abbrev-ref HEAD 2>$null
Write-Host "  Staging is now: $stagingBranch @ $stagingSha"

# Capture the diff stat + commit log for the test report printed at the end
$changeStat = & git -C $STAGING_DIR diff --stat "origin/dev..HEAD" 2>$null
$commitLog  = & git -C $STAGING_DIR log --oneline "origin/dev..HEAD" 2>$null

# ---- Step 3: Build bundles ---------------------------------------------------

Write-Host "`n-- Step 3: Building bundles --"
$null = New-Item -Path $LOG_DIR -ItemType Directory -Force

Write-Host '  server...'
& node (Join-Path $STAGING_DIR 'apps\server\scripts\build.mjs')
if ($LASTEXITCODE -ne 0) { Write-Error 'Server bundle build failed' }

Write-Host '  agent-host...'
& node (Join-Path $STAGING_DIR 'packages\agent-host\scripts\build.mjs')
if ($LASTEXITCODE -ne 0) { Write-Error 'Agent-host bundle build failed' }

Write-Host '  mcp...'
& pnpm --dir $STAGING_DIR --filter '@pc/mcp' build
if ($LASTEXITCODE -ne 0) { Write-Error 'MCP bundle build failed' }

Write-Host '  desktop main (Electron entry)...'
& pnpm --dir $STAGING_DIR --filter '@pc/desktop' build:main
if ($LASTEXITCODE -ne 0) { Write-Error 'Electron main bundle build failed' }

Write-Host '  All bundles built.'

# ---- Step 4: Resolve electron.exe + boot stack -------------------------------

Write-Host "`n-- Step 4: Booting staging stack --"

# Resolve electron.exe via Node module resolution anchored to apps/desktop/package.json
# in the staging worktree. pnpm shares a global store so the same electron version
# resolves to the same exe regardless of which worktree anchors the lookup.
$electronExe = & node -e "const r=require('module').createRequire(process.argv[1]+'/apps/desktop/package.json');process.stdout.write(r('electron'))" $STAGING_DIR 2>$null
if ($LASTEXITCODE -ne 0 -or -not $electronExe -or -not (Test-Path $electronExe)) {
  # Hard-fail: Write-Error is non-terminating and would fall through into an
  # endless health poll against a stack that never booted.
  throw "Cannot resolve electron.exe from staging worktree (resolved: '$electronExe'). Confirm pnpm install succeeded and electron's binary was downloaded."
}
$desktopDir = Join-Path $STAGING_DIR 'apps\desktop'
Write-Host "  electron.exe : $electronExe"

# Ensure sandbox + lock dirs; remove any stale host lock from a prior run
$null = New-Item -Path $LOG_DIR -ItemType Directory -Force
$null = New-Item -Path (Split-Path $HOST_LOCK -Parent) -ItemType Directory -Force
Remove-Item $HOST_LOCK -Force -ErrorAction SilentlyContinue

# ---- Step 5: Launch Electron + Vite ------------------------------------------
# Temporarily set env vars inherited by child processes.
# Mirrors what scripts/dev-app.mjs injects for pnpm desktop:dev.
# Save + restore so the caller's shell is not polluted.

$savedEnv = @{
  PORT              = $env:PORT
  PC_DATA_DIR       = $env:PC_DATA_DIR
  PC_API_ENTRY      = $env:PC_API_ENTRY
  PC_HOST_ENTRY     = $env:PC_HOST_ENTRY
  PC_CHILD_NODE     = $env:PC_CHILD_NODE
  PC_DESKTOP_URL    = $env:PC_DESKTOP_URL
  PC_DESKTOP_DEV    = $env:PC_DESKTOP_DEV
  PC_ROOT           = $env:PC_ROOT
  CLAUDE_CONFIG_DIR = $env:CLAUDE_CONFIG_DIR
  PC_DEV_WEB_PORT   = $env:PC_DEV_WEB_PORT
  PC_DEV_API_PORT   = $env:PC_DEV_API_PORT
  # When this script runs from inside an agent/orchestrator shell, Caisson has
  # spawned that process as an electron-as-node child, so ELECTRON_RUN_AS_NODE=1
  # leaks in. If inherited, the staging electron.exe runs as plain Node and
  # `require('electron').app` is undefined → "Cannot read properties of
  # undefined (reading 'setName')". Clear it before launch; restore after.
  ELECTRON_RUN_AS_NODE = $env:ELECTRON_RUN_AS_NODE
}

$electronProc = $null
$viteProc     = $null

try {
  $nodeExe = (Get-Command node -ErrorAction Stop).Source

  # Electron-side env vars (consumed by resolveStackConfig() in apps/desktop/src/main.ts).
  # PC_ROOT absent = dev-controls enabled. Same pattern as dev-app.mjs.
  $env:PORT           = $API_PORT
  $env:PC_DATA_DIR    = $SANDBOX_DIR
  $env:PC_API_ENTRY   = Join-Path $STAGING_DIR 'apps\server\dist\server.mjs'
  $env:PC_HOST_ENTRY  = Join-Path $STAGING_DIR 'packages\agent-host\dist\host.mjs'
  $env:PC_CHILD_NODE  = $nodeExe
  $env:PC_DESKTOP_URL = "http://127.0.0.1:$WEB_PORT"
  $env:PC_DESKTOP_DEV = '1'
  Remove-Item Env:PC_ROOT              -ErrorAction SilentlyContinue
  Remove-Item Env:CLAUDE_CONFIG_DIR    -ErrorAction SilentlyContinue
  # Critical: a leaked ELECTRON_RUN_AS_NODE makes electron.exe behave as Node.
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

  # Launch Electron DIRECTLY (no cmd.exe wrapper). The electron.exe path lives
  # under "E:\Claude Code Projects\..." which contains spaces; routing it through
  # `cmd.exe /c "<exe>" "<arg>"` makes cmd treat "E:\Claude" as the command and
  # die with "'E:\Claude' is not recognized". Start-Process -FilePath handles the
  # spaced path correctly, and electron.exe's own CommandLine still embeds
  # $desktopDir (the staging path) so verify-before-kill matches. electron.exe is
  # a GUI-subsystem app: it survives this script exiting and shows no console.
  Write-Host '  Launching Electron (supervises api + agent-host)...'
  $electronProc = Start-Process -FilePath $electronExe `
    -ArgumentList "`"$desktopDir`"" `
    -WorkingDirectory $desktopDir `
    -RedirectStandardOutput (Join-Path $LOG_DIR 'electron.log') `
    -RedirectStandardError  (Join-Path $LOG_DIR 'electron.err') `
    -PassThru

  Write-Host "  Electron pid : $($electronProc.Id)"

  # Vite-side env vars (consumed by apps/web/vite.config.ts).
  $env:PC_DEV_WEB_PORT = $WEB_PORT
  $env:PC_DEV_API_PORT = $API_PORT

  # Launch Vite. The cmd.exe CommandLine embeds $STAGING_DIR so
  # verify-before-kill can identify it.
  $viteLaunchCmd = "pnpm --dir `"$STAGING_DIR`" --filter @pc/web dev"
  Write-Host "  Launching Vite (web :$WEB_PORT)..."
  $viteProc = Start-Process 'cmd.exe' `
    -ArgumentList '/c', $viteLaunchCmd `
    -WorkingDirectory $STAGING_DIR `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LOG_DIR 'vite.log') `
    -RedirectStandardError  (Join-Path $LOG_DIR 'vite.err') `
    -PassThru

  Write-Host "  Vite wrapper pid     : $($viteProc.Id)"

} finally {
  # Always restore the caller's environment (even on error)
  foreach ($key in $savedEnv.Keys) {
    $val = $savedEnv[$key]
    if ($null -eq $val) { Remove-Item "Env:$key" -ErrorAction SilentlyContinue }
    else                 { Set-Item   "Env:$key"  $val }
  }
}

# Write pidfile immediately so down/status work even if health-check later fails
Write-Pidfile $electronProc.Id $viteProc.Id

# ---- Step 6: Health check ----------------------------------------------------

Write-Host "`n-- Step 6: Health check --"

$apiUp  = Wait-ApiReady  -TimeoutSec 120
$viteUp = Wait-ViteReady -TimeoutSec 90

if (-not $apiUp) {
  Write-Warning @"

API did not come up within timeout. Tail the logs:
  $LOG_DIR\electron.log
  $LOG_DIR\electron.err

Run  .\stage-env.ps1 down  to clean up, then investigate and retry.
"@
  exit 1
}

if (-not $viteUp) {
  Write-Warning "Vite has not bound :$WEB_PORT yet. It may still be starting. Check $LOG_DIR\vite.log"
}

# ---- Step 7: Report ----------------------------------------------------------

Write-Host ''
Write-Host '== Caisson Staging is UP ==' -ForegroundColor Green
Write-Host ''
Write-Host "  Web URL  :  http://localhost:$WEB_PORT   <- open this to test" -ForegroundColor Cyan
Write-Host "  API      :  http://localhost:$API_PORT"
Write-Host "  Branch   :  $stagingBranch @ $stagingSha  (dev + $Branch)"
Write-Host "  Data     :  $SANDBOX_DIR"
Write-Host "  Logs     :  $LOG_DIR"
Write-Host ''

if ($commitLog) {
  Write-Host '-- Commits in this branch (not yet in dev) --'
  $commitLog | ForEach-Object { Write-Host "  $_" }
  Write-Host ''
}

if ($changeStat) {
  Write-Host '-- Files changed (diff origin/dev..HEAD) --'
  Write-Host $changeStat
  Write-Host ''
}

Write-Host '  .\stage-env.ps1 status   check state at any time'
Write-Host '  .\stage-env.ps1 down     tear down when done'
