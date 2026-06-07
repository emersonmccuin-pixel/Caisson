// One-command dev launcher — ONE RUNTIME edition (Step 7).
//
//   pnpm dev:app   (alias: pnpm dev)
//
// There is no "dev mode" of the app. The Electron app boots exactly one way —
// Electron main supervises the API child + agent-host child, both running the
// shipped BUNDLES (`node server.mjs` / `node host.mjs`). What this script adds
// is the tooling AROUND that one app:
//
//   1. one-shot bundle builds (server · agent-host · mcp) so the app's
//      children exist before first spawn
//   2. watchers — the same builds with esbuild --watch, so every save lands in
//      dist/ immediately. Loading the new code:
//        · server: POST http://127.0.0.1:4040/api/dev/restart  (exit 75 → the
//          supervisor respawns the API child; 409s while agents are live)
//        · host:   kill the host pid from data/agent-host/host.lock.json (the
//          supervisor respawns it with backoff)
//   3. Vite dev server (:5173, HMR) — the window loads it via PC_DESKTOP_URL
//   4. the Electron app itself — THE supervisor; this script supervises
//      nothing (☠ dev-supervisor.mjs is retired)
//
// The app can't tell this tooling apart from a packaged launch: only the
// INPUT values differ (entry paths → repo dist bundles, node binary → the
// system node so repo Node-ABI natives load, window URL → Vite, data dir →
// repo data/).
//
// Zero extra dependencies — just Node's child_process + fetch. Cross-platform
// via shell:true (resolves pnpm / pnpm.cmd on Windows).

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VITE_URL = 'http://127.0.0.1:5173';
const VITE_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

const children = [];
let shuttingDown = false;

/** Spawn a labelled child, inheriting stdio so logs interleave in this terminal. */
function run(label, command, options = {}) {
  const child = spawn(command, {
    shell: true,
    stdio: 'inherit',
    cwd: options.cwd ?? REPO,
    env: options.env ?? process.env,
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    // If any pillar process dies on its own, bring the whole stack down so the
    // dev isn't left with a half-running app.
    console.error(`\n[dev:app] "${label}" exited (code=${code} signal=${signal}) — shutting down.`);
    shutdown(code ?? 1);
  });
  children.push({ label, child });
  return child;
}

/** Run a one-shot command to completion; reject on a non-zero exit. */
function runToExit(label, command) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, { shell: true, stdio: 'inherit', cwd: REPO });
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`[dev:app] "${label}" failed (exit ${code})`));
    });
    child.on('error', reject);
  });
}

/** Poll Vite until it answers (or time out). */
async function waitForVite() {
  const deadline = Date.now() + VITE_TIMEOUT_MS;
  process.stdout.write('[dev:app] waiting for Vite on :5173 ');
  while (Date.now() < deadline) {
    try {
      const res = await fetch(VITE_URL, { method: 'HEAD' });
      if (res.ok || res.status === 404) {
        process.stdout.write(' up.\n');
        return true;
      }
    } catch {
      // not up yet
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  process.stdout.write('\n');
  return false;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error('[dev:app] stopping all dev processes…');
  for (const { child } of children) {
    if (child.exitCode === null && !child.killed) {
      // SIGINT lets Electron's before-quit stop its supervised children.
      child.kill('SIGINT');
    }
  }
  // Give children a moment to exit gracefully, then hard-exit.
  setTimeout(() => process.exit(code), 1_500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main() {
  // The host/server CLAUDE_CONFIG_DIR split: a shell launched by a Claude Code
  // session points CLAUDE_CONFIG_DIR at .claude-work; the agent host would
  // tail the wrong transcript folder and every run would false-fail. Scrub it
  // for the whole stack (same safety net as restart-stack.ps1).
  if (process.env.CLAUDE_CONFIG_DIR) {
    console.error(`[dev:app] clearing inherited CLAUDE_CONFIG_DIR (${process.env.CLAUDE_CONFIG_DIR})`);
    delete process.env.CLAUDE_CONFIG_DIR;
  }

  // PC_ROOT is the SINGLE "this is a packaged build" signal (server-root.ts +
  // dev-controls/constants.ts both key off its presence). A dev stack must
  // NEVER inherit a stray PC_ROOT — if it does, the server boots half-packaged
  // (dev-controls routes unregistered, wrong root) while the Vite UI still
  // renders dev affordances that poll the now-absent /api/dev/* routes →
  // 404 console-error storm (pc-pty-chat-272). dev:app is the ONE entrypoint
  // for every dev launch, so it owns the mode authoritatively: scrub PC_ROOT
  // for the whole child tree here. A proper dev stack runs with it unset (the
  // dev case in server-root.ts); the repo data dir is set explicitly via
  // PC_DATA_DIR below.
  if (process.env.PC_ROOT) {
    console.error(`[dev:app] clearing inherited PC_ROOT (${process.env.PC_ROOT}) — a dev stack must not run half-packaged`);
    delete process.env.PC_ROOT;
  }

  console.error('[dev:app] building bundles (server · agent-host · mcp)…');
  await Promise.all([
    runToExit('build:server', 'pnpm --filter @pc/server build'),
    runToExit('build:agent-host', 'pnpm --filter @pc/agent-host build'),
    runToExit('build:mcp', 'pnpm --filter @pc/mcp build'),
  ]);

  console.error('[dev:app] starting bundle watchers + web UI…');
  run('watch:server', `node "${join(REPO, 'apps', 'server', 'scripts', 'build.mjs')}" --watch`);
  run('watch:agent-host', `node "${join(REPO, 'packages', 'agent-host', 'scripts', 'build.mjs')}" --watch`);
  run('watch:mcp', `node "${join(REPO, 'packages', 'mcp', 'scripts', 'build.mjs')}" --watch`);
  run('web', 'pnpm --filter @pc/web dev');

  const ready = await waitForVite();
  if (shuttingDown) return;
  if (!ready) {
    console.error('[dev:app] Vite did not come up within 60s — opening the window anyway (it will retry on reload).');
  }

  console.error('[dev:app] launching the Caisson app (Electron supervises API + host)…');
  run('app', 'pnpm desktop:dev', {
    env: {
      ...process.env,
      // The inputs that point the ONE runtime at the repo's dev artifacts.
      PC_DESKTOP_URL: VITE_URL,
      PC_API_ENTRY: join(REPO, 'apps', 'server', 'dist', 'server.mjs'),
      PC_HOST_ENTRY: join(REPO, 'packages', 'agent-host', 'dist', 'host.mjs'),
      PC_CHILD_NODE: process.execPath, // system node — repo natives are Node-ABI
      PC_DATA_DIR: join(REPO, 'data'),
    },
  });
}

main().catch((err) => {
  console.error('[dev:app] launcher error:', err);
  shutdown(1);
});
