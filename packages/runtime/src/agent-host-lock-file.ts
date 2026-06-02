// DRIFT TWIN: the lock-file shape, the 'agent-host'/'host.lock.json' path, and
// protocolVersion 1 are duplicated in apps/desktop/src/agent-host-process.ts
// (PackagedAgentHostLockFile / packagedAgentHostLockFilePath). The two are NOT
// shared via @pc/runtime on purpose — importing this package into the desktop
// main bundle would drag in node-pty. Any change to the shape, path, or
// protocolVersion here MUST be mirrored there by hand, or host discovery breaks.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { AgentHostIdentity } from './agent-host-protocol.ts';

export const AGENT_HOST_LOCK_DIR = 'agent-host';
export const AGENT_HOST_LOCK_FILE = 'host.lock.json';
export const AGENT_HOST_PROTOCOL_VERSION = 1 as const;

export interface AgentHostLockFile {
  pid: number;
  hostId: string;
  port: number;
  startedAt: number;
  protocolVersion: typeof AGENT_HOST_PROTOCOL_VERSION;
}

export interface AgentHostEndpoint {
  lockFilePath: string;
  lock: AgentHostLockFile;
  baseUrl: string;
}

export interface DiscoverAgentHostEndpointOptions {
  dataDir: string;
  readFile?: (path: string) => string;
  isPidAlive?: (pid: number) => boolean;
}

export function agentHostLockFilePath(dataDir: string): string {
  return resolve(dataDir, AGENT_HOST_LOCK_DIR, AGENT_HOST_LOCK_FILE);
}

export function agentHostLockFromIdentity(
  identity: AgentHostIdentity,
  port: number,
): AgentHostLockFile {
  return parseAgentHostLockFile({
    pid: identity.pid,
    hostId: identity.hostId,
    port,
    startedAt: identity.startedAt,
    protocolVersion: identity.protocolVersion,
  });
}

export function writeAgentHostLockFile(
  path: string,
  lock: AgentHostLockFile,
): void {
  const parsed = parseAgentHostLockFile(lock);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

export function removeAgentHostLockFile(path: string): void {
  rmSync(path, { force: true });
}

export function readAgentHostLockFile(path: string): AgentHostLockFile | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  try {
    return parseAgentHostLockFile(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function discoverAgentHostEndpoint(
  options: DiscoverAgentHostEndpointOptions,
): AgentHostEndpoint | null {
  const lockFilePath = agentHostLockFilePath(options.dataDir);
  const readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'));
  let raw: string;
  try {
    raw = readFile(lockFilePath);
  } catch {
    return null;
  }

  let lock: AgentHostLockFile;
  try {
    lock = parseAgentHostLockFile(JSON.parse(raw));
  } catch {
    return null;
  }

  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  if (!isPidAlive(lock.pid)) return null;

  return {
    lockFilePath,
    lock,
    baseUrl: `http://127.0.0.1:${lock.port}`,
  };
}

export function parseAgentHostLockFile(value: unknown): AgentHostLockFile {
  if (!value || typeof value !== 'object') {
    throw new Error('agent host lock file must be an object');
  }
  const lock = value as Partial<AgentHostLockFile>;
  const { pid, hostId, port, startedAt, protocolVersion } = lock;
  if (!Number.isInteger(pid) || typeof pid !== 'number' || pid <= 0) {
    throw new Error('agent host lock file pid must be a positive integer');
  }
  if (typeof hostId !== 'string' || hostId.trim().length === 0) {
    throw new Error('agent host lock file hostId must be a non-empty string');
  }
  if (!Number.isInteger(port) || typeof port !== 'number' || port < 1 || port > 65_535) {
    throw new Error('agent host lock file port must be in range 1..65535');
  }
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0) {
    throw new Error('agent host lock file startedAt must be a positive number');
  }
  if (protocolVersion !== AGENT_HOST_PROTOCOL_VERSION) {
    throw new Error('agent host lock file protocolVersion is unsupported');
  }

  return {
    pid,
    hostId,
    port,
    startedAt,
    protocolVersion,
  };
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
