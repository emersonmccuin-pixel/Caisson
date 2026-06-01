// T1.1 — HostConnection: lock-file-only identity, sendCommand reconnect on a
// dead baseUrl (kills T1-A), host-id-change re-hello/re-subscribe, persistent
// onEvent across reconnect, protocol-mismatch → down, health state machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AgentHostEndpoint, AgentHostEvent } from '@pc/runtime';

import { createHostConnection, type HostHealth } from '../src/services/host-connection.ts';

const AGENT_HOST_PROTOCOL_VERSION = 1;

function endpoint(port: number, hostId: string): AgentHostEndpoint {
  return {
    lockFilePath: `/tmp/lock-${port}.json`,
    lock: { pid: 1000, hostId, port, startedAt: 1, protocolVersion: AGENT_HOST_PROTOCOL_VERSION },
    baseUrl: `http://127.0.0.1:${port}`,
  };
}

function helloResponse(hostId: string) {
  return {
    ok: true,
    command: 'hello',
    lastSeq: 0,
    identity: { hostId, pid: 1000, startedAt: 1, protocolVersion: 1 },
  };
}

function listRunsResponse() {
  return { ok: true, command: 'list-runs', lastSeq: 0, runs: [] };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** An /events stream that stays open until aborted (so we can push events). */
function makeEventStream(): {
  response: Response;
  push: (e: AgentHostEvent) => void;
} {
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

interface Recorder {
  fetch: typeof fetch;
  urls: string[];
  setHostId(id: string): void;
  pushEvent(e: AgentHostEvent): void;
}

/** Fake fetch: any POST /command → hello/list-runs/echo; GET /events → open stream.
 *  `liveBase` controls which baseUrl is "alive"; others throw ECONNREFUSED. */
function recorder(opts: {
  liveBase: () => string | null;
  hostId: () => string;
}): Recorder {
  const urls: string[] = [];
  let streamPush: ((e: AgentHostEvent) => void) | null = null;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const live = opts.liveBase();
    if (!live || !url.startsWith(live)) {
      const err = new Error('fetch failed: ECONNREFUSED');
      throw err;
    }
    if (url.includes('/events')) {
      const s = makeEventStream();
      streamPush = s.push;
      return s.response;
    }
    // /command — inspect the body to answer hello vs list-runs vs echo.
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const type = body?.command?.type;
    if (type === 'hello') return jsonResponse(helloResponse(opts.hostId()));
    if (type === 'list-runs') return jsonResponse(listRunsResponse());
    return jsonResponse({ ok: true, command: type, lastSeq: 0, run: undefined });
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    urls,
    setHostId() {},
    pushEvent: (e) => streamPush?.(e),
  };
}

test('reconnect-on-new-port: sendCommand re-discovers + retries once (T1-A)', async () => {
  let activePort = 5001;
  let liveBase = 'http://127.0.0.1:5002'; // host already respawned on the NEW port
  const rec = recorder({ liveBase: () => liveBase, hostId: () => 'h1' });

  const conn = createHostConnection({
    discoverEndpoint: () => endpoint(activePort, 'h1'),
    fetch: rec.fetch,
    isPidAlive: () => true,
    readLockRaw: () => null,
    heartbeatMs: 1_000_000, // disable heartbeat interference
  });

  // First connect happens against port 5001 (dead) → fails; flip discovery to
  // 5002 (alive) so the reconnect retry resolves.
  activePort = 5002;
  const res = await conn.sendCommand({ type: 'list-runs' });
  assert.equal(res.ok, true);
  // A fetch hit the live base (5002).
  assert.ok(rec.urls.some((u) => u.startsWith('http://127.0.0.1:5002')));
  conn.close();
});

test('host-id-change: re-hello + /events resubscribe carries lastSeq + refreshRuns', async () => {
  let port = 6001;
  let hostId = 'hA';
  const live = () => `http://127.0.0.1:${port}`;
  const rec = recorder({ liveBase: live, hostId: () => hostId });
  const conn = createHostConnection({
    discoverEndpoint: () => endpoint(port, hostId),
    fetch: rec.fetch,
    isPidAlive: () => true,
    readLockRaw: () => null,
    heartbeatMs: 1_000_000,
  });

  await conn.sendCommand({ type: 'list-runs' }); // connects to hA
  assert.equal(conn.currentIdentity()?.hostId, 'hA');

  // simulate an event so lastSeq advances
  rec.pushEvent({ seq: 7, type: 'run-state', run: {} as never } as AgentHostEvent);
  await new Promise((r) => setTimeout(r, 10));

  // host respawns with a NEW id on a new port
  port = 6002;
  hostId = 'hB';
  await conn.refreshRuns().catch(() => {});
  // force a reconnect via a fresh command (old inner is still pointed at 6001)
  port = 6002;
  // discovery now returns hB; a command triggers reconnect to the new host
  // (the inner against 6001 is dead since liveBase moved to 6002).
  await conn.sendCommand({ type: 'list-runs' });
  assert.equal(conn.currentIdentity()?.hostId, 'hB');
  // an /events request to the new host carried the tracked lastSeq (7)
  assert.ok(
    rec.urls.some((u) => u.startsWith('http://127.0.0.1:6002') && u.includes('/events?after=7')),
    `expected /events?after=7 on new host; saw ${JSON.stringify(rec.urls)}`,
  );
  conn.close();
});

test('protocol mismatch → down + throw, no dispatch', async () => {
  const transitions: HostHealth['state'][] = [];
  const conn = createHostConnection({
    discoverEndpoint: () => null,
    readLockRaw: () => JSON.stringify({ pid: 1, hostId: 'h', port: 1, startedAt: 1, protocolVersion: 999 }),
    fetch: (async () => {
      throw new Error('should never dispatch into a protocol-mismatch host');
    }) as typeof fetch,
    isPidAlive: () => true,
    heartbeatMs: 1_000_000,
  });
  conn.onHealthChange((h) => transitions.push(h.state));
  await assert.rejects(() => conn.sendCommand({ type: 'list-runs' }));
  assert.equal(conn.health().state, 'down');
  assert.ok(transitions.includes('down'));
  conn.close();
});

test('persistent onEvent survives a host-id-change reconnect', async () => {
  let port = 7001;
  let hostId = 'hA';
  const rec = recorder({ liveBase: () => `http://127.0.0.1:${port}`, hostId: () => hostId });
  const conn = createHostConnection({
    discoverEndpoint: () => endpoint(port, hostId),
    fetch: rec.fetch,
    isPidAlive: () => true,
    readLockRaw: () => null,
    heartbeatMs: 1_000_000,
  });

  const seen: number[] = [];
  conn.onEvent((e) => seen.push(e.seq));

  await conn.sendCommand({ type: 'list-runs' }); // connect hA
  // reconnect to hB
  port = 7002;
  hostId = 'hB';
  await conn.sendCommand({ type: 'list-runs' });
  rec.pushEvent({ seq: 99, type: 'run-state', run: {} as never } as AgentHostEvent);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(seen.includes(99), `listener should fire on the new inner client; saw ${seen}`);
  conn.close();
});

test('health state machine: connected → reconnecting → connected, one emit each', async () => {
  let liveBase: string | null = 'http://127.0.0.1:8001';
  let port = 8001;
  const rec = recorder({ liveBase: () => liveBase, hostId: () => 'h1' });
  const conn = createHostConnection({
    discoverEndpoint: () => endpoint(port, 'h1'),
    fetch: rec.fetch,
    isPidAlive: () => true,
    readLockRaw: () => null,
    heartbeatMs: 1_000_000,
  });
  const states: HostHealth['state'][] = [];
  conn.onHealthChange((h) => states.push(h.state));

  await conn.sendCommand({ type: 'list-runs' }); // connected
  assert.equal(conn.health().state, 'connected');

  // host dies on 8001, respawns on 8002 (same id)
  liveBase = 'http://127.0.0.1:8002';
  port = 8002;
  await conn.sendCommand({ type: 'list-runs' }); // reconnecting → connected
  assert.equal(conn.health().state, 'connected');

  // first emit is connected, then reconnecting, then connected again
  assert.deepEqual(states, ['connected', 'reconnecting', 'connected']);
  conn.close();
});
