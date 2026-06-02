// Crash diagnostics — imported FIRST in index.ts so a fatal during boot is
// still captured. Outputs land in `<dataDir>/diagnostics/`:
//   • report.*.json    — Node diagnostic report (native stack, loaded shared
//                        libs, heap/uv stats) on fatal error / uncaught throw.
//                        Best chance of attributing a native crash to a
//                        specific addon (node-pty vs better-sqlite3).
//   • server-crashes.log — one line per uncaughtException / unhandledRejection.
//   • pty-lifecycle.log — written by the runtime; PC_DIAG_DIR points it here.
//
// Why this exists: the server died with exit 0xC0000374 (STATUS_HEAP_CORRUPTION,
// a native crash under node-pty spawn/kill churn) and the reason vanished into
// the dev terminal scrollback because nothing persisted it. See tasks 3–4.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { getDataDir } from '@pc/utils';

const dir = join(getDataDir(), 'diagnostics');
try {
  mkdirSync(dir, { recursive: true });
} catch {
  /* best-effort */
}

// Bridge to the runtime (which doesn't depend on @pc/utils) so its PTY
// lifecycle log lands beside these crash artifacts.
process.env.PC_DIAG_DIR = dir;

try {
  process.report.directory = dir;
  process.report.reportOnFatalError = true;
  process.report.reportOnUncaughtException = true;
} catch {
  /* process.report unavailable on this runtime — non-fatal */
}

const crashLog = join(dir, 'server-crashes.log');

function record(kind: string, detail: unknown): void {
  const body =
    detail instanceof Error ? (detail.stack ?? detail.message) : String(detail);
  try {
    appendFileSync(crashLog, `[${new Date().toISOString()}] ${kind}: ${body}\n`);
  } catch {
    /* best-effort */
  }
  // Keep it on stderr too so the dev supervisor's log capture sees it.
  console.error(`[pc][fatal] ${kind}: ${body}`);
}

process.on('uncaughtException', (err) => {
  record('uncaughtException', err);
  try {
    process.report.writeReport(err);
  } catch {
    /* report best-effort */
  }
  // Exit non-75 (a crash, not the 75 intentional-restart sentinel). The dev
  // supervisor auto-recovers a crash after a healthy boot (uptime >=
  // CRASH_HEALTHY_UPTIME_MS) up to MAX_CRASH_RESTARTS; rapid boot-time crashes
  // accumulate toward that cap and then the supervisor gives up
  // (apps/server/scripts/dev-supervisor.mjs).
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  record('unhandledRejection', reason);
  try {
    if (reason instanceof Error) process.report.writeReport(reason);
    else process.report.writeReport();
  } catch {
    /* report best-effort */
  }
  process.exit(1);
});
