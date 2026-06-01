// T1.1 — the one long-lived HostConnection (foundational-hardening keystone).
//
// Wraps a per-host-id `HttpAgentHostClient` behind a SINGLE conduit whose source
// of host identity is the lock file ONLY. `sendCommand` re-discovers + reconnects
// on a dead baseUrl (kills T1-A: dev-supervisor respawns the host on a NEW port →
// the next dispatch succeeds with no API restart). A persistent multiplexed
// emitter keeps external `onEvent` listeners alive across reconnects. A slow,
// backoff-gated heartbeat publishes `HostHealth` for the UI pill / Theme-2 watchdog.
//
// Built BESIDE the existing boot-reattach/sweep client (reconcile-first); deletes
// nothing this slice.

import {
  AGENT_HOST_PROTOCOL_VERSION,
  agentHostLockFilePath,
  discoverAgentHostEndpoint,
  type AgentHostCommand,
  type AgentHostCommandResponse,
  type AgentHostEndpoint,
  type AgentHostEvent,
  type AgentHostIdentity,
  type AgentHostRunSnapshot,
} from '@pc/runtime';
import type { HostHealthSnapshot } from '@pc/contracts';
import { getDataDir } from '@pc/utils';
import { readFileSync } from 'node:fs';

import { HttpAgentHostClient } from './agent-host-client.ts';
import type { AgentHostReattachClient } from './agent-host-reattach.ts';

export type HostHealth =
  | { state: 'connected'; hostId: string; pid: number; lastOkAt: number; since: number }
  | { state: 'reconnecting'; lastError: string; since: number }
  | { state: 'down'; lastError: string; since: number };

export interface HostConnection extends AgentHostReattachClient {
  currentIdentity(): AgentHostIdentity | null;
  health(): HostHealth;
  isConnected(): boolean;
  sendCommand(cmd: AgentHostCommand): Promise<AgentHostCommandResponse>;
  listRuns(): readonly AgentHostRunSnapshot[];
  refreshRuns(): Promise<readonly AgentHostRunSnapshot[]>;
  onEvent(listener: (e: AgentHostEvent) => void): () => void;
  onHealthChange(listener: (h: HostHealth) => void): () => void;
  close(): void;
}

export interface CreateHostConnectionOptions {
  dataDir?: string;
  requestTimeoutMs?: number;
  onProtocolError?: (error: Error) => void;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
  /** Override discovery (tests). Defaults to lock-file `discoverAgentHostEndpoint`. */
  discoverEndpoint?: () => AgentHostEndpoint | null;
  /** Read the raw lock JSON to distinguish a protocol-mismatch lock (→ `down`)
   *  from no lock at all (→ `reconnecting`). Defaults to reading the lock path. */
  readLockRaw?: () => string | null;
  heartbeatMs?: number;
}

/** Map the server-internal discriminated `HostHealth` to the wire snapshot. */
export function toHostHealthSnapshot(h: HostHealth): HostHealthSnapshot {
  if (h.state === 'connected') {
    return { state: 'connected', hostId: h.hostId, pid: h.pid, since: h.since };
  }
  return { state: h.state, hostId: null, pid: null, lastError: h.lastError, since: h.since };
}

const DEFAULT_HEARTBEAT_MS = 10_000;
const MAX_HEARTBEAT_MS = 30_000;

export function createHostConnection(
  options: CreateHostConnectionOptions = {},
): HostConnection {
  return new HostConnectionImpl(options);
}

class HostConnectionImpl implements HostConnection {
  private readonly dataDir: string;
  private readonly requestTimeoutMs: number | undefined;
  private readonly onProtocolError: ((error: Error) => void) | undefined;
  private readonly fetchImpl: CreateHostConnectionOptions['fetch'];
  private readonly now: () => number;
  private readonly isPidAlive: ((pid: number) => boolean) | undefined;
  private readonly discoverEndpoint: () => AgentHostEndpoint | null;
  private readonly readLockRaw: () => string | null;
  private readonly heartbeatMs: number;

  private inner: HttpAgentHostClient | null = null;
  private innerHostId: string | null = null;
  private innerUnsub: (() => void) | null = null;
  private identity: AgentHostIdentity | null = null;
  private lastSeq = 0;
  private lastRuns: readonly AgentHostRunSnapshot[] = [];

  private healthState: HostHealth;
  private closed = false;
  private connecting: Promise<void> | null = null;

  private readonly eventListeners = new Set<(e: AgentHostEvent) => void>();
  private readonly healthListeners = new Set<(h: HostHealth) => void>();

  private heartbeat: NodeJS.Timeout | null = null;
  private heartbeatBackoff: number;

  constructor(options: CreateHostConnectionOptions) {
    this.dataDir = options.dataDir ?? getDataDir();
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.onProtocolError = options.onProtocolError;
    this.fetchImpl = options.fetch;
    this.now = options.now ?? Date.now;
    this.isPidAlive = options.isPidAlive;
    this.discoverEndpoint =
      options.discoverEndpoint ??
      (() =>
        discoverAgentHostEndpoint({
          dataDir: this.dataDir,
          ...(this.isPidAlive ? { isPidAlive: this.isPidAlive } : {}),
        }));
    this.readLockRaw =
      options.readLockRaw ??
      (() => {
        try {
          return readFileSync(agentHostLockFilePath(this.dataDir), 'utf8');
        } catch {
          return null;
        }
      });
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.heartbeatBackoff = this.heartbeatMs;
    this.healthState = { state: 'reconnecting', lastError: 'not yet connected', since: this.now() };
    this.scheduleHeartbeat();
  }

  // --- public surface -------------------------------------------------------

  currentIdentity(): AgentHostIdentity | null {
    return this.identity;
  }

  health(): HostHealth {
    return this.healthState;
  }

  isConnected(): boolean {
    return this.healthState.state === 'connected';
  }

  listRuns(): readonly AgentHostRunSnapshot[] {
    return this.inner ? this.inner.listRuns() : this.lastRuns;
  }

  async refreshRuns(): Promise<readonly AgentHostRunSnapshot[]> {
    await this.ensureConnected();
    if (!this.inner) return this.lastRuns;
    const runs = await this.inner.refreshRuns();
    this.lastRuns = runs;
    return runs;
  }

  async sendCommand(cmd: AgentHostCommand): Promise<AgentHostCommandResponse> {
    if (this.closed) throw new Error('host connection is closed');

    if (this.inner) {
      try {
        const res = await this.inner.sendCommand(cmd);
        this.markConnected();
        return res;
      } catch (err) {
        if (!isConnectionError(err)) throw err;
        // fall through to re-discover + retry ONCE
      }
    }

    await this.reconnect(this.inner ? 'dispatch failed on dead baseUrl' : 'no active host client');
    if (!this.inner) {
      throw downError(this.healthState);
    }
    const res = await this.inner.sendCommand(cmd);
    this.markConnected();
    return res;
  }

  onEvent(listener: (e: AgentHostEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onHealthChange(listener: (h: HostHealth) => void): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearTimeout(this.heartbeat);
    this.heartbeat = null;
    this.teardownInner();
    this.eventListeners.clear();
    this.healthListeners.clear();
  }

  // --- internals ------------------------------------------------------------

  /** Connect lazily if no inner client; never throws — leaves health=down/reconnecting. */
  private async ensureConnected(): Promise<void> {
    if (this.inner || this.closed) return;
    await this.reconnect('no active host client').catch(() => {});
  }

  /** Re-discover via the lock file, swap the inner client (rebuild on host-id
   *  change), retry path. Sets health. Dedupes concurrent calls. */
  private reconnect(reason: string): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.doReconnect(reason).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doReconnect(reason: string): Promise<void> {
    if (this.closed) return;
    this.setReconnecting(reason);

    // Protocol-mismatch lock is terminal `down` — never build a client against it.
    const mismatch = this.detectProtocolMismatch();
    if (mismatch) {
      this.teardownInner();
      this.setDown(mismatch);
      return;
    }

    const endpoint = this.discoverEndpoint();
    if (!endpoint) {
      // No live lock (pid dead / absent) — stay reconnecting; the host may respawn.
      this.teardownInner();
      this.setReconnecting('no live agent-host lock');
      return;
    }

    // Same host-id and an existing client → just swap baseUrl is impossible
    // (baseUrl is frozen in HttpAgentHostClient), so always rebuild against the
    // discovered endpoint. The persistent emitter survives the swap.
    this.teardownInner();
    const client = new HttpAgentHostClient(endpoint, {
      ...(this.requestTimeoutMs !== undefined ? { requestTimeoutMs: this.requestTimeoutMs } : {}),
      ...(this.onProtocolError ? { onProtocolError: this.onProtocolError } : {}),
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
    });

    try {
      const identity = await client.hello();
      // Seed the new inner stream from the connection's tracked lastSeq so the
      // /events?after= resubscribe avoids replaying the whole backlog.
      seedLastSeq(client, this.lastSeq);
      this.innerUnsub = client.onEvent((e) => this.onInnerEvent(e));
      client.startEventStream();
      const runs = await client.refreshRuns();
      this.lastRuns = runs;
      this.inner = client;
      this.innerHostId = endpoint.lock.hostId;
      this.identity = identity;
      this.markConnected();
    } catch (err) {
      client.close();
      this.setReconnecting(toError(err).message);
    }
  }

  private onInnerEvent(e: AgentHostEvent): void {
    if (typeof e.seq === 'number' && e.seq > this.lastSeq) this.lastSeq = e.seq;
    for (const l of this.eventListeners) l(e);
  }

  private teardownInner(): void {
    this.innerUnsub?.();
    this.innerUnsub = null;
    this.inner?.close();
    this.inner = null;
    this.innerHostId = null;
  }

  /** Returns a message if a lock exists but its protocolVersion is unsupported. */
  private detectProtocolMismatch(): string | null {
    const raw = this.readLockRaw();
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null; // malformed → treat as no lock (reconnecting), not terminal
    }
    const pv = (parsed as { protocolVersion?: unknown } | null)?.protocolVersion;
    if (typeof pv === 'number' && pv !== AGENT_HOST_PROTOCOL_VERSION) {
      return `agent-host protocol mismatch: lock v${pv} != supported v${AGENT_HOST_PROTOCOL_VERSION}`;
    }
    return null;
  }

  // --- health state machine -------------------------------------------------

  private markConnected(): void {
    const id = this.identity;
    if (!id) return;
    const now = this.now();
    if (this.healthState.state === 'connected' && this.healthState.hostId === id.hostId) {
      this.healthState = { ...this.healthState, lastOkAt: now };
      return; // no transition — don't re-emit
    }
    this.heartbeatBackoff = this.heartbeatMs;
    this.transition({ state: 'connected', hostId: id.hostId, pid: id.pid, lastOkAt: now, since: now });
  }

  private setReconnecting(lastError: string): void {
    if (this.healthState.state === 'reconnecting') return;
    this.transition({ state: 'reconnecting', lastError, since: this.now() });
  }

  private setDown(lastError: string): void {
    if (this.healthState.state === 'down' && this.healthState.lastError === lastError) return;
    this.transition({ state: 'down', lastError, since: this.now() });
  }

  private transition(next: HostHealth): void {
    this.healthState = next;
    for (const l of this.healthListeners) l(next);
  }

  // --- heartbeat (backoff-gated; never forces a reconnect) ------------------

  private scheduleHeartbeat(): void {
    if (this.closed) return;
    const delay = this.isConnected() ? this.heartbeatMs : this.heartbeatBackoff;
    this.heartbeat = setTimeout(() => {
      void this.runHeartbeat();
    }, delay);
    this.heartbeat.unref?.();
  }

  private async runHeartbeat(): Promise<void> {
    if (this.closed) return;
    try {
      const mismatch = this.detectProtocolMismatch();
      if (mismatch) {
        this.teardownInner();
        this.setDown(mismatch);
      } else {
        const endpoint = this.discoverEndpoint();
        if (!endpoint) {
          // No live lock: if we thought we were connected, fall to reconnecting.
          if (this.isConnected()) {
            this.teardownInner();
            this.setReconnecting('agent-host lock disappeared');
          }
        } else if (!this.inner || this.innerHostId !== endpoint.lock.hostId) {
          // A new host appeared (or we have none) — connect lazily.
          await this.reconnect('heartbeat saw a new agent-host lock').catch(() => {});
        }
      }
    } finally {
      // Widen the poll while not connected so a dead host is not hammered.
      if (!this.isConnected()) {
        this.heartbeatBackoff = Math.min(this.heartbeatBackoff * 2, MAX_HEARTBEAT_MS);
      }
      this.scheduleHeartbeat();
    }
  }
}

function seedLastSeq(client: HttpAgentHostClient, lastSeq: number): void {
  // `lastSeq` is private on HttpAgentHostClient; seed it so the new /events
  // stream resubscribes from the connection's high-water (avoids full replay).
  (client as unknown as { lastSeq: number }).lastSeq = lastSeq;
}

function isConnectionError(err: unknown): boolean {
  const e = toError(err);
  const msg = e.message.toLowerCase();
  return (
    e.name === 'AbortError' ||
    msg.includes('fetch failed') ||
    msg.includes('econnrefused') ||
    msg.includes('connect') ||
    msg.includes('timed out') ||
    msg.includes('socket') ||
    msg.includes('network') ||
    msg.includes('http 5') ||
    msg.includes('agent host returned http')
  );
}

function downError(health: HostHealth): Error {
  const detail = 'lastError' in health ? health.lastError : 'host unavailable';
  return new Error(`agent host unavailable (${health.state}): ${detail}`);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
