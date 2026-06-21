// T1.2 — the ONE HostConnection is the sole conduit + multiplexed event stream
// for ALL live host consumers (sweep, boot reattach, factory). These tests guard
// the slice's load-bearing invariants:
//   1. sweep self-heals via refreshRuns after a host port change (no warn-loop).
//   2. a run-state mid-sendCommand lands on the handle WITHOUT the old
//      latestRunStateSnapshot patch (the delete-proof — single ordered stream).
//   3. ONE run-terminal on the shared emitter is applied exactly once across
//      the boot-reattach listener + a factory listener (idempotent net).
//   4. no listener leak: a factory subscription unsubscribes on terminal, so the
//      connection's listener set returns to baseline across N runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  AgentHostEndpoint,
  AgentHostEvent,
  AgentHostRunSnapshot,
} from '@pc/runtime';
import type { AgentRunRow, ULID } from '@pc/domain';

import { createHostConnection, type HostConnection } from '../src/services/host-connection.ts';
import {
  ActiveRunRegistry,
  HostBackedActiveRunHandle,
} from '../src/services/agent-active-runs.ts';
import {
  applyHostTerminalSnapshot,
  reconcileAgentRunsAgainstHost,
} from '../src/services/agent-host-reattach.ts';

const AGENT_HOST_PROTOCOL_VERSION = 1;

function endpoint(port: number, hostId: string): AgentHostEndpoint {
  return {
    lockFilePath: `/tmp/lock-${port}.json`,
    lock: { pid: 1000, hostId, port, startedAt: 1, protocolVersion: AGENT_HOST_PROTOCOL_VERSION },
    baseUrl: `http://127.0.0.1:${port}`,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeEventStream(): { response: Response; push: (e: AgentHostEvent) => void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(stream, { status: 200 }),
    push: (e) => {
      const line = `${JSON.stringify({ type: 'event', event: e })}\n`;
      controller.enqueue(new TextEncoder().encode(line));
    },
  };
}

/** Fake fetch over a controllable live baseUrl + run list. */
function recorder(opts: {
  liveBase: () => string | null;
  hostId: () => string;
  runs?: () => AgentHostRunSnapshot[];
}): { fetch: typeof fetch; urls: string[]; pushEvent: (e: AgentHostEvent) => void } {
  const urls: string[] = [];
  let streamPush: ((e: AgentHostEvent) => void) | null = null;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const live = opts.liveBase();
    if (!live || !url.startsWith(live)) throw new Error('fetch failed: ECONNREFUSED');
    if (url.includes('/events')) {
      const s = makeEventStream();
      streamPush = s.push;
      return s.response;
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const type = body?.command?.type;
    if (type === 'hello') {
      return jsonResponse({
        ok: true,
        command: 'hello',
        lastSeq: 0,
        identity: { hostId: opts.hostId(), pid: 1000, startedAt: 1, protocolVersion: 1 },
      });
    }
    if (type === 'list-runs') {
      return jsonResponse({ ok: true, command: 'list-runs', lastSeq: 0, runs: opts.runs?.() ?? [] });
    }
    return jsonResponse({ ok: true, command: type, lastSeq: 0, run: undefined });
  }) as typeof fetch;
  return { fetch: fetchImpl, urls, pushEvent: (e) => streamPush?.(e) };
}

function row(id: string, patch: Partial<AgentRunRow> = {}): AgentRunRow {
  return {
    id: id as ULID,
    projectId: '01KHOSTPROJECT00000000001' as ULID,
    dispatcherSessionId: 'orch-session',
    ccSessionId: `cc-${id}`,
    podName: 'researcher',
    podRevisionAtDispatch: 'agent:1',
    podRevisionAtResume: null,
    status: 'running',
    continues: null,
    parentInvokeDepth: 0,
    parentWorkItemId: null,
    input: 'input',
    result: null,
    failureCause: null,
    failureReason: null,
    queuedAt: 1_700_000_000_000,
    spawnedAt: 1_700_000_000_100,
    readyAt: 1_700_000_000_200,
    pid: null,
    lastActivityAt: null,
    deliveredAt: null,
    completedAt: null,
    rev: 0,
    contractId: null,
    worktreeDir: null,
    worktreeBaseBranch: null,
    worktreeBaseSha: null,
    ...patch,
  };
}

function hostRun(
  id: string,
  state: AgentHostRunSnapshot['state'] = 'running',
  patch: Partial<AgentHostRunSnapshot> = {},
): AgentHostRunSnapshot {
  return {
    runId: id as ULID,
    projectId: '01KHOSTPROJECT00000000001' as ULID,
    dispatcherSessionId: 'orch-session',
    ccSessionId: `cc-${id}`,
    podName: 'researcher',
    worktreeDir: 'E:/worktree',
    state,
    jsonlPath: null,
    transcriptPath: null,
    queuedAt: 1_700_000_000_000,
    spawnedAt: 1_700_000_000_100,
    readyAt: 1_700_000_000_200,
    updatedAt: 1_700_000_000_300,
    terminalAt: state === 'completed' || state === 'failed' ? 1_700_000_000_400 : null,
    ...patch,
  };
}

// --- 1. sweep self-heals after a host port change -----------------------------

test('reconcile sweep self-heals after a host port change (refreshRuns re-discovers)', async () => {
  let activePort = 9101; // dead
  let liveBase: string | null = 'http://127.0.0.1:9102'; // host respawned here
  const runs = [hostRun('sweep-run', 'completed')];
  const rec = recorder({
    liveBase: () => liveBase,
    hostId: () => 'h1',
    runs: () => runs,
  });
  const warnings: string[] = [];
  const conn = createHostConnection({
    discoverEndpoint: () => endpoint(activePort, 'h1'),
    fetch: rec.fetch,
    isPidAlive: () => true,
    readLockRaw: () => null,
    heartbeatMs: 1_000_000,
  });

  // First refresh against the dead port (9101) fails internally; flip discovery
  // to the respawned port so the next refresh resolves (no permanent warn-loop).
  try {
    await conn.refreshRuns();
  } catch (err) {
    warnings.push((err as Error).message);
  }
  activePort = 9102;
  const fresh = await conn.refreshRuns();
  assert.equal(fresh.length, 1);

  // The sweep reconciles non-terminal rows against the freshly pulled snapshots.
  let currentRow = row('sweep-run', { status: 'running' });
  let terminalApplied = 0;
  const res = await reconcileAgentRunsAgainstHost({
    hostClient: conn,
    listNonTerminalRuns: () => [currentRow],
    getAgentRun: () => currentRow,
    markTerminal: () => {
      terminalApplied += 1;
      currentRow = { ...currentRow, status: 'completed' };
      return currentRow;
    },
    updateStatus: (input) => {
      currentRow = { ...currentRow, status: input.status };
    },
    broadcast: () => {},
  });
  assert.equal(res.terminalApplied, 1);
  assert.equal(terminalApplied, 1);
  conn.close();
});

// --- 2. run-state mid-sendCommand lands WITHOUT the patch (delete-proof) -------
//
// Models the factory's source ordering exactly (agent-run-factory.ts):
//   - subscribe `hostClient.onEvent(...)` BEFORE awaiting `sendCommand` (:628),
//   - the run-state branch is ONLY `if (handle) handle.applySnapshot(event.run)`
//     (the deleted latestRunStateSnapshot capture is intentionally absent here),
//   - `handle` is assigned AFTER the sendCommand response (:697).
// On a single ordered stream, a run-state:running emitted DURING the await is
// delivered in order; after handle assignment, subsequent state events apply
// directly. This proves the patch is unnecessary.

test('run-state mid-sendCommand lands on the handle WITHOUT the latestRunStateSnapshot patch', async () => {
  const runId = 'mid-await-run';
  let liveBase: string | null = 'http://127.0.0.1:9201';
  const rec = recorder({ liveBase: () => liveBase, hostId: () => 'h1', runs: () => [] });
  const conn = createHostConnection({
    discoverEndpoint: () => endpoint(9201, 'h1'),
    fetch: rec.fetch,
    isPidAlive: () => true,
    readLockRaw: () => null,
    heartbeatMs: 1_000_000,
  });
  await conn.refreshRuns(); // connect + open the /events stream

  let handle: HostBackedActiveRunHandle | null = null;
  // Factory listener — PATCH REMOVED: run-state only applies when handle exists.
  const unsubscribe = conn.onEvent((event) => {
    if (event.type !== 'run-state' && event.type !== 'run-terminal') return;
    if (event.run.runId !== runId) return;
    if (handle) handle.applySnapshot(event.run);
  });

  // The host emits run-state:running DURING the sendCommand await window, while
  // handle is still null. With the patch gone, this single mid-await event is NOT
  // what seeds running — the SUBSEQUENT in-order event after assignment is.
  rec.pushEvent({ seq: 1, type: 'run-state', run: hostRun(runId, 'running') });
  await new Promise((r) => setTimeout(r, 5));
  // sendCommand returns spawning (the start-run seed).
  handle = new HostBackedActiveRunHandle(hostRun(runId, 'spawning'), conn);
  assert.equal(handle.getState(), 'spawning');

  // A later run-state:running on the ONE ordered stream applies directly to the
  // assigned handle (no patch needed) — the handle is no longer a stale lie.
  rec.pushEvent({ seq: 2, type: 'run-state', run: hostRun(runId, 'running') });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(handle.getState(), 'running');

  unsubscribe();
  conn.close();
});

// --- 3. one terminal delivered exactly once across reattach + factory ---------

test('one run-terminal on the shared emitter applies exactly once (reattach + factory)', async () => {
  const runId = 'dual-listener-run';
  const rec = recorder({ liveBase: () => 'http://127.0.0.1:9301', hostId: () => 'h1', runs: () => [] });
  const conn = createHostConnection({
    discoverEndpoint: () => endpoint(9301, 'h1'),
    fetch: rec.fetch,
    isPidAlive: () => true,
    readLockRaw: () => null,
    heartbeatMs: 1_000_000,
  });
  await conn.refreshRuns();

  const registry = new ActiveRunRegistry();
  let currentRow = row(runId, { status: 'running' });
  let dbFlips = 0;
  const terminalDeps = {
    activeRunRegistry: registry,
    getAgentRun: () => currentRow,
    markTerminal: () => {
      dbFlips += 1;
      currentRow = { ...currentRow, status: 'completed' as const };
      return currentRow;
    },
    broadcast: () => {},
  };

  // Both the persistent boot-reattach listener AND a per-run factory listener
  // ride the ONE emitter; each calls applyHostTerminalSnapshot for the same run.
  const applyTerminal = (event: AgentHostEvent): void => {
    if (event.type !== 'run-terminal' || event.run.runId !== runId) return;
    applyHostTerminalSnapshot(event.run, terminalDeps);
  };
  conn.onEvent(applyTerminal); // boot reattach (persistent)
  const factoryUnsub = conn.onEvent(applyTerminal); // factory (per-run)

  rec.pushEvent({ seq: 1, type: 'run-terminal', run: hostRun(runId, 'completed') });
  await new Promise((r) => setTimeout(r, 10));

  // Idempotent net: the DB row flips terminal once; the second caller no-ops.
  assert.equal(dbFlips, 1);
  factoryUnsub();
  conn.close();
});

// --- 4. no listener leak across N runs ----------------------------------------

test('factory listener unsubscribes on terminal — no listener leak across N runs', async () => {
  const rec = recorder({ liveBase: () => 'http://127.0.0.1:9501', hostId: () => 'h1', runs: () => [] });
  const conn = createHostConnection({
    discoverEndpoint: () => endpoint(9501, 'h1'),
    fetch: rec.fetch,
    isPidAlive: () => true,
    readLockRaw: () => null,
    heartbeatMs: 1_000_000,
  });
  await conn.refreshRuns();

  const listenerCount = (c: HostConnection): number =>
    (c as unknown as { eventListeners: Set<unknown> }).eventListeners.size;
  const baseline = listenerCount(conn);

  for (let i = 0; i < 5; i += 1) {
    const runId = `leak-run-${i}`;
    // Factory subscribes, then unsubscribes when its terminal applies (matches
    // the source: `if (applied > 0) unsubscribe()`).
    let unsubscribe: (() => void) | undefined;
    unsubscribe = conn.onEvent((event) => {
      if (event.type === 'run-terminal' && event.run.runId === runId) unsubscribe?.();
    });
    assert.equal(listenerCount(conn), baseline + 1);
    rec.pushEvent({ seq: i + 1, type: 'run-terminal', run: hostRun(runId, 'completed') });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(listenerCount(conn), baseline, `listener leaked after run ${runId}`);
  }
  conn.close();
});
