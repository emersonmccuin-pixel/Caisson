// One-command staging lifecycle.
//
//   pnpm dev:staging           start API on :4141 + web on :5175 + agent host
//   pnpm dev:staging:stop      kill those processes
//
// What it does (on start):
//   1. Fast-forward DEV_WORKTREE to local `dev` branch tip (ff-only; reset --hard
//      only if working tree is clean; abort+report otherwise).
//   2. pnpm install in DEV_WORKTREE — only when pnpm-lock.yaml changed.
//   3. Safe DB snapshot: better-sqlite3 readonly .backup() from LIVE_DB → SANDBOX_DB.
//      Never a file copy — WAL mode would tear the snapshot.
//   4. Build apps/server/dist/server.mjs + packages/agent-host/dist/host.mjs in
//      DEV_WORKTREE (fast esbuild, both in parallel).
//   5. Spawn host child: node host.mjs --http-lock-file <lock> (PC_DATA_DIR=SANDBOX_DIR).
//      Wait for <SANDBOX_DIR>/agent-host/host.lock.json before continuing.
//   6. Start API child: node server.mjs (PORT=4141, PC_DATA_DIR=SANDBOX_DIR,
//      PC_BUILD_SHA, PC_BUILD_BRANCH; PC_ROOT deleted so dev controls engage).
//   7. Start web child: pnpm --filter @pc/web dev (PC_DEV_WEB_PORT=5175,
//      PC_DEV_API_PORT=4141). Poll Vite until up.
//
// Assumptions (Windows-specific):
//   • DEV_WORKTREE = E:\Claude Code Projects\Personal\PC-PTY-Chat-dev-instance
//   • LIVE_DB      = %APPDATA%\Caisson\pc.sqlite  (packaged app data)
//   • SANDBOX_DIR  = %APPDATA%\Caisson-dev-sandbox

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Paths ─────────────────────────────────────────────────────────────────────
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEV_WORKTREE = 'E:\\Claude Code Projects\\Personal\\PC-PTY-Chat-dev-instance';
const APPDATA = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming');
const LIVE_DB = join(APPDATA, 'Caisson', 'pc.sqlite');
const SANDBOX_DIR = join(APPDATA, 'Caisson-dev-sandbox');
const SANDBOX_DB = join(SANDBOX_DIR, 'pc.sqlite');
const API_PORT = 4141;
const WEB_PORT = 5175;
const PID_FILE = join(SANDBOX_DIR, '.staging-pids.json');

// Agent-host: lock file at <SANDBOX_DIR>/agent-host/host.lock.json — same path
// the API uses for discovery (agentHostLockFilePath in @pc/runtime).
const HOST_LOCK_FILE = join(SANDBOX_DIR, 'agent-host', 'host.lock.json');
// Host bundle built into the dev-instance worktree (same path dev-app.mjs uses).
const HOST_ENTRY = join(DEV_WORKTREE, 'packages', 'agent-host', 'dist', 'host.mjs');

const VITE_TIMEOUT_MS = 60_000;
const HOST_READY_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 500;

// ── Port reclaim ──────────────────────────────────────────────────────────────
/**
 * Kill every process currently listening on `port` (127.0.0.1 or 0.0.0.0).
 * Returns the list of PIDs that were killed.
 * Silently tolerates "no process found" and races to already-dead.
 *
 * win32 : netstat -ano → parse LISTENING rows → taskkill /F /T /PID
 * posix : lsof -ti tcp:<port> (fallback: fuser <port>/tcp) → kill -9
 */
function reclaimPort(port) {
  /** @type {number[]} */
  const killed = [];

  if (process.platform === 'win32') {
    const r = spawnSync('netstat -ano', { shell: true, encoding: 'utf-8' });
    const re = new RegExp(`(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0):${port}\\s`);
    for (const line of (r.stdout ?? '').split('\n')) {
      if (!line.includes('LISTENING')) continue;
      if (!re.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[parts.length - 1], 10);
      // Guard against obviously-invalid PIDs (System Idle = 0, System = 4)
      if (!isNaN(pid) && pid > 4) {
        spawnSync(`taskkill /F /T /PID ${pid}`, { shell: true, stdio: 'ignore' });
        killed.push(pid);
      }
    }
  } else {
    // Try lsof; fall back to fuser
    let rawPids = '';
    const lsof = spawnSync(`lsof -ti tcp:${port}`, { shell: true, encoding: 'utf-8' });
    if ((lsof.status ?? 1) === 0) {
      rawPids = (lsof.stdout ?? '').trim();
    } else {
      const fuser = spawnSync(`fuser ${port}/tcp 2>/dev/null`, { shell: true, encoding: 'utf-8' });
      rawPids = (fuser.stdout ?? '').trim();
    }
    for (const token of rawPids.split(/\s+/).filter(Boolean)) {
      const pid = parseInt(token, 10);
      if (isNaN(pid) || pid <= 0) continue;
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
      killed.push(pid);
    }
  }

  return killed;
}

/** Kill a single PID (cross-platform). Silently tolerates already-dead. */
function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync(`taskkill /F /T /PID ${pid}`, { shell: true, stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch { /* already dead */ }
}

/**
 * Startup preflight — run BEFORE spawning API/web/host children.
 * 1. Reclaim API_PORT + WEB_PORT (kill any holders).
 * 2. Kill PIDs recorded in a stale PID_FILE (belt-and-suspenders).
 * 3. Remove stale host lock file so a prior-run's lock never confuses discovery.
 * 4. Delete stale PID_FILE.
 */
async function preflight() {
  console.log('[staging] preflight: reclaiming ports and clearing stale state…');
  let anyReclaimed = false;

  for (const port of [API_PORT, WEB_PORT]) {
    const killed = reclaimPort(port);
    for (const pid of killed) {
      console.log(`[staging] reclaimed :${port} (pid ${pid})`);
      anyReclaimed = true;
    }
  }

  if (existsSync(PID_FILE)) {
    let pids;
    try {
      pids = JSON.parse(readFileSync(PID_FILE, 'utf-8'));
    } catch { /* corrupted — just delete it */ }

    if (pids) {
      for (const pid of [pids.apiPid, pids.webPid, pids.hostPid]) {
        killPid(pid);
      }
      anyReclaimed = true;
    }

    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    console.log('[staging] stale pidfile cleared.');
  }

  // Remove any stale host lock so the API never discovers a dead-run host.
  if (existsSync(HOST_LOCK_FILE)) {
    try { unlinkSync(HOST_LOCK_FILE); } catch { /* ignore */ }
    console.log('[staging] stale host lock cleared.');
    anyReclaimed = true;
  }

  if (!anyReclaimed) {
    console.log('[staging] ports clear');
  }
}

// ── Process registry ──────────────────────────────────────────────────────────
/** @type {{ label: string; child: import('node:child_process').ChildProcess }[]} */
const children = [];
let shuttingDown = false;

/** Spawn a labelled child with inherited stdio (logs interleave in this terminal). */
function run(label, command, options = {}) {
  const child = spawn(command, {
    shell: true,
    stdio: 'inherit',
    cwd: options.cwd ?? DEV_WORKTREE,
    env: options.env ?? process.env,
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`\n[staging] "${label}" exited (code=${code} signal=${signal}) — shutting down.`);
    shutdown(code ?? 1);
  });
  children.push({ label, child });
  return child;
}

/** Run a one-shot command; reject on non-zero exit. */
function runToExit(label, command, options = {}) {
  return new Promise((res, rej) => {
    const child = spawn(command, {
      shell: true,
      stdio: 'inherit',
      cwd: options.cwd ?? DEV_WORKTREE,
      env: options.env ?? process.env,
    });
    child.on('exit', (code) => {
      if (code === 0) res();
      else rej(new Error(`[staging] "${label}" failed (exit ${code})`));
    });
    child.on('error', rej);
  });
}

/** Run a sync command and return trimmed stdout; throw on non-zero. */
function runSyncOutput(command, options = {}) {
  const r = spawnSync(command, {
    shell: true,
    encoding: 'utf-8',
    cwd: options.cwd ?? DEV_WORKTREE,
  });
  if (r.status !== 0) {
    throw new Error(
      `[staging] sync command failed (${r.status}): ${command}\n${r.stderr ?? ''}`,
    );
  }
  return (r.stdout ?? '').trim();
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error('[staging] stopping all processes…');
  for (const { child } of children) {
    if (child.exitCode === null && !child.killed) {
      if (process.platform === 'win32') {
        spawnSync(`taskkill /F /T /PID ${child.pid}`, { shell: true, stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    }
  }
  setTimeout(() => process.exit(code), 1_500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// ── Stop command ──────────────────────────────────────────────────────────────
async function stopStaging() {
  if (!existsSync(PID_FILE)) {
    console.log('[staging] no pidfile — nothing to stop');
    return;
  }
  let pids;
  try {
    pids = JSON.parse(readFileSync(PID_FILE, 'utf-8'));
  } catch {
    console.error('[staging] corrupted pidfile — removing');
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    return;
  }

  // Attempt a polite HTTP shutdown on the host so it can tear down its PTY
  // children before we hard-kill — mirrors what the Electron supervisor does.
  if (pids.hostPid) {
    console.log(`[staging] requesting host shutdown (pid ${pids.hostPid})…`);
    await requestHostShutdown();
    // Give it a moment to exit on its own.
    await new Promise((r) => setTimeout(r, 1_000));
  }

  console.log(
    `[staging] killing api (pid ${pids.apiPid}), web (pid ${pids.webPid}), ` +
    `host (pid ${pids.hostPid ?? 'none'})…`,
  );
  for (const pid of [pids.apiPid, pids.webPid, pids.hostPid]) {
    killPid(pid);
  }

  // Reclaim by port so orphans not in the pidfile are also cleaned up.
  for (const port of [API_PORT, WEB_PORT]) {
    const killed = reclaimPort(port);
    for (const pid of killed) {
      console.log(`[staging] reclaimed :${port} (pid ${pid})`);
    }
  }

  // Clean up stale host lock.
  try { unlinkSync(HOST_LOCK_FILE); } catch { /* ignore */ }

  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  console.log('[staging] stopped.');
}

// ── Phase A — git sync ────────────────────────────────────────────────────────
async function syncDevWorktree() {
  if (!existsSync(DEV_WORKTREE)) {
    throw new Error(`[staging] DEV_WORKTREE not found: ${DEV_WORKTREE}`);
  }

  // Lockfile hash before sync — used to detect whether install is needed.
  const lockfilePath = join(DEV_WORKTREE, 'pnpm-lock.yaml');
  const lockfileBefore = existsSync(lockfilePath)
    ? readFileSync(lockfilePath)
    : Buffer.alloc(0);

  // Resolve the local dev branch tip SHA.
  const devSha = runSyncOutput('git rev-parse dev', { cwd: REPO });
  console.log(`[staging] dev tip: ${devSha}`);

  // Fetch remote so FETCH_HEAD is fresh (but we don't need it — we sync to
  // the LOCAL dev branch which is what the user controls).
  try {
    runSyncOutput('git fetch --quiet', { cwd: DEV_WORKTREE });
  } catch {
    console.warn('[staging] fetch failed (offline?) — continuing with local dev tip');
  }

  // Try fast-forward only.
  let synced = false;
  try {
    runSyncOutput(`git merge --ff-only ${devSha}`, { cwd: DEV_WORKTREE });
    synced = true;
  } catch {
    // ff blocked — check if the working tree content matches HEAD exactly.
    let diffOutput = '';
    try {
      diffOutput = runSyncOutput('git diff HEAD', { cwd: DEV_WORKTREE });
    } catch { /* ignore diff errors */ }

    if (diffOutput === '') {
      console.warn('[staging] ff-only blocked but working tree is clean — resetting to dev tip');
      runSyncOutput(`git reset --hard ${devSha}`, { cwd: DEV_WORKTREE });
      synced = true;
    } else {
      console.error('[staging] ABORT: ff-only failed and working tree has uncommitted changes.');
      console.error('[staging] Resolve the dev-instance worktree manually, then retry.');
      console.error(`[staging] Worktree: ${DEV_WORKTREE}`);
      process.exit(1);
    }
  }

  if (synced) {
    const head = runSyncOutput('git rev-parse --short HEAD', { cwd: DEV_WORKTREE });
    console.log(`[staging] dev-instance synced to ${head}`);
  }

  const lockfileAfter = existsSync(lockfilePath)
    ? readFileSync(lockfilePath)
    : Buffer.alloc(0);

  return !lockfileBefore.equals(lockfileAfter);
}

// ── Phase B — conditional deps install ───────────────────────────────────────
async function installDeps(lockfileChanged) {
  if (!lockfileChanged) {
    console.log('[staging] lockfile unchanged — skipping pnpm install');
    return;
  }
  console.log('[staging] lockfile changed — running pnpm install…');
  await runToExit('pnpm install', 'pnpm install', { cwd: DEV_WORKTREE });
}

// ── Phase C — safe DB snapshot ────────────────────────────────────────────────
async function snapshotDb() {
  if (!existsSync(LIVE_DB)) {
    console.warn(`[staging] live DB not found at ${LIVE_DB} — skipping snapshot`);
    return;
  }

  console.log(`[staging] snapshotting ${LIVE_DB} → ${SANDBOX_DB}…`);
  mkdirSync(SANDBOX_DIR, { recursive: true });

  // Resolve better-sqlite3 from apps/server (declared dep there).
  // This path resolution walks pnpm's symlink graph from the server package.
  const _require = createRequire(join(REPO, 'apps', 'server', 'package.json'));
  const Database = _require('better-sqlite3');

  // Open readonly — no lock on the WAL, no interference with the packaged app.
  const src = new Database(LIVE_DB, { readonly: true });
  await src.backup(SANDBOX_DB);
  src.close();

  console.log('[staging] snapshot done.');
}

// ── Phase D — build server + host bundles ────────────────────────────────────
async function buildBundles() {
  console.log('[staging] building server + agent-host bundles in dev-instance…');
  const serverBuildScript = join(DEV_WORKTREE, 'apps', 'server', 'scripts', 'build.mjs');
  const hostBuildScript = join(DEV_WORKTREE, 'packages', 'agent-host', 'scripts', 'build.mjs');
  // Build both in parallel — independent esbuild invocations.
  await Promise.all([
    runToExit('build:server', `node "${serverBuildScript}"`, { cwd: DEV_WORKTREE }),
    runToExit('build:agent-host', `node "${hostBuildScript}"`, { cwd: DEV_WORKTREE }),
  ]);
}

// ── Agent-host readiness + shutdown ──────────────────────────────────────────

/**
 * Poll HOST_LOCK_FILE until it appears and has a fresh mtime (>= notBefore).
 * Returns the parsed lock object ({ pid, port, hostId, ... }) or null on timeout.
 * Mirrors the desktop supervisor's waitForFreshFile + lock-file validation.
 */
async function waitForHostLock(notBefore) {
  const deadline = Date.now() + HOST_READY_TIMEOUT_MS;
  process.stdout.write(`[staging] waiting for host lock `);
  while (Date.now() < deadline) {
    if (existsSync(HOST_LOCK_FILE)) {
      try {
        const st = statSync(HOST_LOCK_FILE);
        if (st.mtimeMs >= notBefore) {
          const parsed = JSON.parse(readFileSync(HOST_LOCK_FILE, 'utf-8'));
          if (
            parsed &&
            typeof parsed.pid === 'number' &&
            typeof parsed.port === 'number' &&
            parsed.protocolVersion === 1
          ) {
            process.stdout.write(` up (pid ${parsed.pid} :${parsed.port}).\n`);
            return parsed;
          }
        }
      } catch { /* lock not fully written yet */ }
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  process.stdout.write('\n');
  return null;
}

/**
 * Ask the agent host to shut itself down via HTTP POST /command
 * (shutdown host-exit). This lets it tear down live PTY children cleanly
 * instead of orphaning them. Falls back silently if the host is already gone.
 * Mirrors requestPackagedAgentHostShutdown in apps/desktop/src/agent-host-process.ts.
 */
async function requestHostShutdown() {
  if (!existsSync(HOST_LOCK_FILE)) return false;
  let lock;
  try {
    lock = JSON.parse(readFileSync(HOST_LOCK_FILE, 'utf-8'));
  } catch { return false; }
  if (!lock?.port) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const res = await fetch(`http://127.0.0.1:${lock.port}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: { type: 'shutdown', mode: 'host-exit' } }),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ── Phase E — start processes ─────────────────────────────────────────────────
async function waitForApi() {
  const url = `http://127.0.0.1:${API_PORT}/api/dev/status`;
  const deadline = Date.now() + 30_000;
  process.stdout.write(`[staging] waiting for API on :${API_PORT} `);
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        process.stdout.write(' up.\n');
        return true;
      }
    } catch { /* not up yet */ }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  process.stdout.write('\n');
  return false;
}

async function waitForVite() {
  const url = `http://127.0.0.1:${WEB_PORT}`;
  const deadline = Date.now() + VITE_TIMEOUT_MS;
  process.stdout.write(`[staging] waiting for Vite on :${WEB_PORT} `);
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { method: 'HEAD' });
      if (r.ok || r.status === 404) {
        process.stdout.write(' up.\n');
        return true;
      }
    } catch { /* not up yet */ }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  process.stdout.write('\n');
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Check for --stop flag
  if (process.argv.includes('--stop')) {
    await stopStaging();
    return;
  }

  // Scrub inherited CLAUDE_CONFIG_DIR (same safety net as dev-app.mjs).
  if (process.env['CLAUDE_CONFIG_DIR']) {
    console.error(`[staging] clearing inherited CLAUDE_CONFIG_DIR (${process.env['CLAUDE_CONFIG_DIR']})`);
    delete process.env['CLAUDE_CONFIG_DIR'];
  }

  // Preflight — reclaim ports + clear stale pidfile + stale host lock
  await preflight();

  // Phase A — sync dev-instance to local dev tip
  console.log('[staging] syncing dev-instance worktree…');
  const lockfileChanged = await syncDevWorktree();

  // Phase B — deps install (conditional)
  await installDeps(lockfileChanged);

  // Phase C — safe DB snapshot
  await snapshotDb();

  // Phase D — build server + agent-host bundles
  await buildBundles();

  // Capture build marker from the synced worktree
  const buildSha = runSyncOutput('git rev-parse --short HEAD', { cwd: DEV_WORKTREE });
  const buildBranch = runSyncOutput('git rev-parse --abbrev-ref HEAD', { cwd: DEV_WORKTREE });
  console.log(`[staging] build marker: ${buildBranch} @ ${buildSha}`);

  // Phase E.1 — start agent host
  // Env mirrors what the Electron supervisor sets (main.ts buildSupervisor):
  //   PC_DATA_DIR    → sandbox dir so lock lands at <SANDBOX_DIR>/agent-host/host.lock.json
  //   PC_AGENT_HOST_LOCK_FILE → explicit lock path (also consumed via --http-lock-file arg)
  //   PORT           → staging API port (context for the host, not a bind port for it)
  //   PC_ROOT absent → dev-controls enabled (same as API)
  // No ELECTRON_RUN_AS_NODE — we're spawning with the system node binary.
  const hostEnv = { ...process.env };
  delete hostEnv['PC_ROOT'];
  hostEnv['PC_DATA_DIR'] = SANDBOX_DIR;
  hostEnv['PORT'] = String(API_PORT);
  hostEnv['PC_AGENT_HOST_LOCK_FILE'] = HOST_LOCK_FILE;

  // Ensure the lock dir exists before spawning (the host also creates it, but
  // belt-and-suspenders so a race doesn't confuse statSync in waitForHostLock).
  mkdirSync(dirname(HOST_LOCK_FILE), { recursive: true });

  const hostSpawnedAt = Date.now();
  console.log(`[staging] spawning agent host: ${HOST_ENTRY}`);
  const hostChild = run(
    'host',
    `node --report-on-fatalerror "${HOST_ENTRY}" --http-lock-file "${HOST_LOCK_FILE}"`,
    { cwd: DEV_WORKTREE, env: hostEnv },
  );

  const hostLock = await waitForHostLock(hostSpawnedAt);
  if (shuttingDown) return;
  if (!hostLock) {
    console.error('[staging] agent host did not write its lock file within timeout — aborting.');
    shutdown(1);
    return;
  }

  // Phase E.2 — start API
  const serverBundle = join(DEV_WORKTREE, 'apps', 'server', 'dist', 'server.mjs');
  const apiEnv = { ...process.env };
  delete apiEnv['PC_ROOT']; // packaged-mode signal; absent → dev controls engage
  apiEnv['PORT'] = String(API_PORT);
  apiEnv['PC_DATA_DIR'] = SANDBOX_DIR;
  apiEnv['PC_BUILD_SHA'] = buildSha;
  apiEnv['PC_BUILD_BRANCH'] = buildBranch;

  const apiChild = run('api', `node "${serverBundle}"`, { cwd: DEV_WORKTREE, env: apiEnv });

  const apiUp = await waitForApi();
  if (shuttingDown) return;
  if (!apiUp) {
    console.error('[staging] API did not come up within 30s — aborting.');
    shutdown(1);
    return;
  }

  // Phase E.3 — start web
  const webEnv = { ...process.env };
  webEnv['PC_DEV_WEB_PORT'] = String(WEB_PORT);
  webEnv['PC_DEV_API_PORT'] = String(API_PORT);

  const webChild = run('web', 'pnpm --filter @pc/web dev', { cwd: DEV_WORKTREE, env: webEnv });

  const webUp = await waitForVite();
  if (shuttingDown) return;
  if (!webUp) {
    console.error('[staging] Vite did not come up within 60s — opening the URL anyway.');
  }

  // Write pidfile so dev:staging:stop can find all three processes.
  mkdirSync(SANDBOX_DIR, { recursive: true });
  writeFileSync(
    PID_FILE,
    JSON.stringify({
      apiPid: apiChild.pid,
      webPid: webChild.pid,
      hostPid: hostChild.pid,
    }),
  );

  console.error(`\n[staging] ready.`);
  console.error(`  API  : http://127.0.0.1:${API_PORT}`);
  console.error(`  Web  : http://127.0.0.1:${WEB_PORT}`);
  console.error(`  Host : pid ${hostLock.pid}  port :${hostLock.port}  lock ${HOST_LOCK_FILE}`);
  console.error(`  Build: ${buildBranch} @ ${buildSha}`);
  console.error(`  Data : ${SANDBOX_DIR}`);
  console.error('\nCtrl+C to stop.\n');
}

main().catch((err) => {
  console.error('[staging] fatal error:', err);
  shutdown(1);
});
