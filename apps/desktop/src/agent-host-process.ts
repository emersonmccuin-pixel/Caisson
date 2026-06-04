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

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

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
