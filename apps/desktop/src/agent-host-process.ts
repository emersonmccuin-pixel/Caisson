// DRIFT TWIN: PackagedAgentHostLockFile, packagedAgentHostLockFilePath, and
// protocolVersion 1 below are a hand-copy of packages/runtime/src/agent-host-lock-file.ts
// (AgentHostLockFile / agentHostLockFilePath / AGENT_HOST_PROTOCOL_VERSION). They
// are deliberately NOT imported from @pc/runtime — that would pull node-pty into
// the desktop main bundle. Any change to the lock-file shape, the
// 'agent-host'/'host.lock.json' path, or protocolVersion MUST be mirrored in that
// file by hand, or host discovery breaks.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface PackagedAgentHostLockFile {
  pid: number;
  hostId: string;
  port: number;
  startedAt: number;
  protocolVersion: 1;
}

export interface PackagedAgentHostSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ['ignore', 'pipe', 'pipe'];
  shell: false;
  lockFilePath: string;
}

export interface BuildPackagedAgentHostSpawnSpecOptions {
  pcRoot: string;
  dataDir: string;
  execPath: string;
  env?: NodeJS.ProcessEnv;
}

export interface SpawnPackagedAgentHostProcessOptions
  extends BuildPackagedAgentHostSpawnSpecOptions {
  spawnImpl?: typeof spawn;
}

export interface WaitForPackagedAgentHostLockOptions {
  lockFilePath: string;
  startedAt: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  statFile?: (path: string) => { mtimeMs: number };
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface RequestPackagedAgentHostShutdownOptions {
  lockFilePath: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function packagedAgentHostLockFilePath(dataDir: string): string {
  return join(dataDir, 'agent-host', 'host.lock.json');
}

export function buildPackagedAgentHostSpawnSpec(
  options: BuildPackagedAgentHostSpawnSpecOptions,
): PackagedAgentHostSpawnSpec {
  const lockFilePath = packagedAgentHostLockFilePath(options.dataDir);
  return {
    command: options.execPath,
    args: [
      join(options.pcRoot, 'agent-host.mjs'),
      '--http-lock-file',
      lockFilePath,
    ],
    cwd: options.pcRoot,
    env: {
      ...(options.env ?? process.env),
      ELECTRON_RUN_AS_NODE: '1',
      PC_ROOT: options.pcRoot,
      PC_DATA_DIR: options.dataDir,
      PC_AGENT_HOST_LOCK_FILE: lockFilePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    lockFilePath,
  };
}

export function spawnPackagedAgentHostProcess(
  options: SpawnPackagedAgentHostProcessOptions,
): { child: ChildProcess; spec: PackagedAgentHostSpawnSpec } {
  const spec = buildPackagedAgentHostSpawnSpec(options);
  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: spec.stdio,
    shell: spec.shell,
  });
  return { child, spec };
}

export function removePackagedAgentHostLockFile(lockFilePath: string): void {
  rmSync(lockFilePath, { force: true });
}

export async function waitForPackagedAgentHostLock(
  options: WaitForPackagedAgentHostLockOptions,
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const statFile = options.statFile ?? ((path) => statSync(path));
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;

  while (now() < deadline) {
    try {
      if (statFile(options.lockFilePath).mtimeMs >= options.startedAt) {
        return true;
      }
    } catch {
      /* lock file not written yet */
    }
    await sleep(pollIntervalMs);
  }
  return false;
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

export function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once('exit', onExit);
  });
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
