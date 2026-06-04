// Shared readiness/teardown waits for supervised children. Node-builtins only.
//
// These are the two gates dev-supervisor.mjs proved out:
//   - waitForPortsFree  — preSpawn gate: don't bind until the dying process
//     releases the port (EADDRINUSE race on respawn).
//   - waitForFreshFile  — onReady gate: the agent host publishes a lock file;
//     "fresh" = mtime at/after the spawn timestamp (a stale lock from a dead
//     host must not count as ready).

import { statSync } from 'node:fs';
import { createConnection } from 'node:net';

export interface WaitDeps {
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
}

function resolveDeps(deps?: WaitDeps): Required<WaitDeps> {
  return {
    now: deps?.now ?? Date.now,
    delay: deps?.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

export interface PortProbeOptions {
  host?: string;
  probeTimeoutMs?: number;
  connectImpl?: typeof createConnection;
}

/** True if something is listening on the port (connect succeeds). */
export function portInUse(port: number, options?: PortProbeOptions): Promise<boolean> {
  const connect = options?.connectImpl ?? createConnection;
  return new Promise((resolve) => {
    const sock = connect({ port, host: options?.host ?? '127.0.0.1' });
    const finish = (inUse: boolean): void => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(inUse);
    };
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false)); // refused = free
    setTimeout(() => finish(false), options?.probeTimeoutMs ?? 250);
  });
}

export interface WaitForPortsFreeOptions extends PortProbeOptions {
  timeoutMs?: number;
  probeIntervalMs?: number;
  deps?: WaitDeps;
  /** Abort early (e.g. shutdown began). */
  shouldAbort?: () => boolean;
  portInUseImpl?: typeof portInUse;
}

/** Wait until none of the ports accept a connection. False = timed out (caller
 *  spawns anyway; the child's own EADDRINUSE handling decides). */
export async function waitForPortsFree(
  ports: number[],
  options?: WaitForPortsFreeOptions,
): Promise<boolean> {
  const { now, delay } = resolveDeps(options?.deps);
  const probe = options?.portInUseImpl ?? portInUse;
  const deadline = now() + (options?.timeoutMs ?? 12_000);
  while (now() < deadline && !options?.shouldAbort?.()) {
    const busy = (await Promise.all(ports.map((p) => probe(p, options)))).some(Boolean);
    if (!busy) return true;
    await delay(options?.probeIntervalMs ?? 300);
  }
  return false;
}

export interface WaitForPortsBoundOptions extends PortProbeOptions {
  timeoutMs?: number;
  probeIntervalMs?: number;
  deps?: WaitDeps;
  shouldAbort?: () => boolean;
  portInUseImpl?: typeof portInUse;
}

/** Wait until every port accepts a connection — the API child's readiness
 *  gate (don't load the window against a dead port). False = timed out. */
export async function waitForPortsBound(
  ports: number[],
  options?: WaitForPortsBoundOptions,
): Promise<boolean> {
  const { now, delay } = resolveDeps(options?.deps);
  const probe = options?.portInUseImpl ?? portInUse;
  const deadline = now() + (options?.timeoutMs ?? 30_000);
  while (now() < deadline && !options?.shouldAbort?.()) {
    const bound = (await Promise.all(ports.map((p) => probe(p, options)))).every(Boolean);
    if (bound) return true;
    await delay(options?.probeIntervalMs ?? 300);
  }
  return false;
}

export interface WaitForFreshFileOptions {
  /** The file counts only if its mtime is at/after this timestamp. */
  notBefore: number;
  timeoutMs?: number;
  probeIntervalMs?: number;
  deps?: WaitDeps;
  shouldAbort?: () => boolean;
  statImpl?: (path: string) => { mtimeMs: number };
}

/** Wait for a file to exist with mtime >= notBefore (e.g. the agent host's
 *  lock file published by THIS spawn, not a stale one). False = timed out. */
export async function waitForFreshFile(
  path: string,
  options: WaitForFreshFileOptions,
): Promise<boolean> {
  const { now, delay } = resolveDeps(options.deps);
  const stat = options.statImpl ?? ((p: string) => statSync(p));
  const deadline = now() + (options.timeoutMs ?? 5_000);
  while (now() < deadline && !options.shouldAbort?.()) {
    try {
      if (stat(path).mtimeMs >= options.notBefore) return true;
    } catch {
      /* not written yet */
    }
    await delay(options.probeIntervalMs ?? 100);
  }
  return false;
}
