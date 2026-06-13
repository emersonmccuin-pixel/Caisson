// Agent-host lock-file helpers for the Electron supervisor.
//
// ☠ Step 7: the one-shot spawn machinery that lived here
// (spawnPackagedAgentHostProcess / waitForPackagedAgentHostLock /
// waitForChildExit) is DELETED — @pc/supervisor owns spawn/watch/respawn and
// readiness waits now. What remains is the lock-file contract and the polite
// HTTP shutdown the supervisor's requestStop hook uses.
//
// DRIFT TWIN: PackagedAgentHostLockFile, packagedAgentHostLockFilePath, and
// protocolVersion 1 below are a hand-copy of packages/runtime/src/agent-host-lock-file.ts
// (AgentHostLockFile / agentHostLockFilePath / AGENT_HOST_PROTOCOL_VERSION). They
// are deliberately NOT imported from @pc/runtime — that would pull node-pty into
// the desktop main bundle. Any change to the lock-file shape, the
// 'agent-host'/'host.lock.json' path, or protocolVersion MUST be mirrored in that
// file by hand, or host discovery breaks.

import { execFile } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PackagedAgentHostLockFile {
  pid: number;
  hostId: string;
  port: number;
  startedAt: number;
  protocolVersion: 1;
}

export interface RequestPackagedAgentHostShutdownOptions {
  lockFilePath: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function packagedAgentHostLockFilePath(dataDir: string): string {
  return join(dataDir, 'agent-host', 'host.lock.json');
}

export function removePackagedAgentHostLockFile(lockFilePath: string): void {
  rmSync(lockFilePath, { force: true });
}

export function readPackagedAgentHostLockFile(
  lockFilePath: string,
): PackagedAgentHostLockFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockFilePath, 'utf8'));
  } catch {
    return null;
  }
  if (!isPackagedAgentHostLockFile(parsed)) return null;
  return parsed;
}

/** Ask the host to shut itself down (HTTP `shutdown host-exit`) so it can tear
 *  down its PTY children instead of orphaning them on a hard kill. */
export async function requestPackagedAgentHostShutdown(
  options: RequestPackagedAgentHostShutdownOptions,
): Promise<boolean> {
  const lock = readPackagedAgentHostLockFile(options.lockFilePath);
  if (!lock) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 2_000);
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(`http://127.0.0.1:${lock.port}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        command: { type: 'shutdown', mode: 'host-exit' },
      }),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Stale-host reaper ────────────────────────────────────────────────────────
// The host listens on a random port, so the boot port-conflict guard never
// sees an orphan (Electron hard-killed → before-quit never ran → host + its
// claude.exe children survive, invisible, forever). The lock file is the only
// pointer to it. preSpawn used to just delete that pointer; now it reaps:
// polite HTTP shutdown (host tears down its own PTY children), tree-kill
// fallback. Kill ONLY after the pid's command line proves it is the host that
// wrote THIS lock file — pid reuse must never kill a stranger ("verify
// cmdline before killing" project rule).

export type ReapAction =
  | 'no-lock'
  | 'already-dead'
  | 'graceful-exit'
  | 'tree-killed'
  | 'skipped-unverified'
  | 'kill-failed';

export interface ReapStaleAgentHostOptions {
  log?: (msg: string) => void;
  fetchImpl?: typeof fetch;
}

/** Find and stop an agent host left over from a previous run, then clear the
 *  lock file. Always removes the lock (the caller is about to spawn a fresh
 *  host that writes its own); never kills an unverified pid. */
export async function reapStaleAgentHost(
  lockFilePath: string,
  options: ReapStaleAgentHostOptions = {},
): Promise<{ action: ReapAction; pid?: number }> {
  const log = options.log ?? (() => {});
  const lock = readPackagedAgentHostLockFile(lockFilePath);
  if (!lock) {
    removePackagedAgentHostLockFile(lockFilePath);
    return { action: 'no-lock' };
  }

  const done = (action: ReapAction): { action: ReapAction; pid: number } => {
    removePackagedAgentHostLockFile(lockFilePath);
    return { action, pid: lock.pid };
  };

  if (!isProcessAlive(lock.pid)) return done('already-dead');

  const commandLine = await getCommandLine(lock.pid);
  if (!isOurAgentHostCommandLine(commandLine, lockFilePath)) {
    log(
      `[reap] stale lock pid ${lock.pid} is alive but its command line does not match this ` +
        `lock file (pid reuse?) — NOT killing. cmdline: ${commandLine.slice(0, 200) || '(unknown)'}`,
    );
    return done('skipped-unverified');
  }

  log(`[reap] stale agent host from a previous run is still alive (pid ${lock.pid}) — shutting it down`);
  const polite = await requestPackagedAgentHostShutdown({
    lockFilePath,
    fetchImpl: options.fetchImpl,
  });
  if (polite && (await waitForPidExit(lock.pid, 3_000))) {
    log(`[reap] stale agent host pid ${lock.pid} exited gracefully`);
    return done('graceful-exit');
  }

  await treeKill(lock.pid);
  if (await waitForPidExit(lock.pid, 2_000)) {
    log(`[reap] stale agent host pid ${lock.pid} tree-killed`);
    return done('tree-killed');
  }
  log(`[reap] stale agent host pid ${lock.pid} did not exit after tree-kill — continuing boot`);
  return done('kill-failed');
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but not ours; anything we can't signal we also can't kill.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function getCommandLine(pid: number): Promise<string> {
  try {
    if (process.platform === 'win32') {
      // Windows PowerShell 5.1 (always present), matching port-conflict.ts.
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`,
        ],
        { windowsHide: true, maxBuffer: 1024 * 1024 },
      );
      return stdout.trim();
    }
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'args=']);
    return stdout.trim();
  } catch {
    return '';
  }
}

/** The host child is spawned with `--http-lock-file <lockFilePath>` (see
 *  buildSupervisor in main.ts) — the lock path in the command line ties the
 *  process to THIS data dir, not a dev/staging twin. Separators and casing are
 *  normalized; never matches claude.exe or TS servers. */
function isOurAgentHostCommandLine(commandLine: string, lockFilePath: string): boolean {
  if (!commandLine) return false;
  if (/claude\.exe|tsserver|typingsInstaller/i.test(commandLine)) return false;
  const normalize = (s: string) => s.toLowerCase().replace(/\\/g, '/');
  return (
    commandLine.includes('--http-lock-file') &&
    normalize(commandLine).includes(normalize(lockFilePath))
  );
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isProcessAlive(pid);
}

async function treeKill(pid: number): Promise<void> {
  try {
    if (process.platform === 'win32') {
      // /T takes the host's claude.exe children (the orphan's agents) with it.
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // Best-effort; waitForPidExit decides the outcome.
  }
}

function isPackagedAgentHostLockFile(value: unknown): value is PackagedAgentHostLockFile {
  if (!value || typeof value !== 'object') return false;
  const lock = value as Partial<PackagedAgentHostLockFile>;
  return (
    typeof lock.pid === 'number' &&
    typeof lock.hostId === 'string' &&
    typeof lock.port === 'number' &&
    typeof lock.startedAt === 'number' &&
    lock.protocolVersion === 1
  );
}
