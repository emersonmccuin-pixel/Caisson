// Step-4 Slice 1 — persistent-interactive policy on the ONE run primitive.
//
// Guard tests per the scope doc: a persistent run is never idle-killed or
// wall-clock-killed (G3), takes the cap-exempt lane (G4), exposes
// interrupt/resize (G2/G6), tracks turn-level ready⇌busy (G1), and re-emits
// the tailer's source-cursor meta for the server replay writer (G7).
// Dispatched workers ('default' policy) keep today's behavior — the
// default-policy cases here pin that too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AgentRun, type AgentRunInput, type SpawnLike } from '../src/agent-run.ts';
import { AgentRunRegistry } from '../src/agent-run-registry.ts';
import type { SpawnState } from '../src/low-level-spawn.ts';
import type { ReadyTimestamps } from '../src/ready-gate.ts';
import type { SendResult } from '../src/send-protocol.ts';

class FakeSpawn extends EventEmitter implements SpawnLike {
  sends: string[] = [];
  interrupts = 0;
  resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;

  start(): void {}
  async awaitReady(): Promise<ReadyTimestamps> {
    return { spawnedAt: 1, bannerAt: 2, readyAt: 3 } as unknown as ReadyTimestamps;
  }
  async send(body: string): Promise<SendResult> {
    this.sends.push(body);
    return 'ok';
  }
  notifyMcpHandshake(): void {}
  interrupt(): void {
    this.interrupts++;
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }
  kill(): void {
    this.killed = true;
  }
  getState(): SpawnState {
    return 'running';
  }
  getJsonlPath(): string | null {
    return null;
  }
}

function makeRun(
  overrides: Partial<AgentRunInput> & { registry?: AgentRunRegistry } = {},
): { run: AgentRun; spawn: FakeSpawn; registry: AgentRunRegistry } {
  const spawn = new FakeSpawn();
  const registry = overrides.registry ?? new AgentRunRegistry({ maxConcurrent: 5 });
  const { registry: _drop, ...inputOverrides } = overrides;
  const run = new AgentRun(
    {
      agentRunId: 'run-1',
      ccProviderSessionId: 'cc-1',
      podDefinition: { name: 'orchestrator' },
      worktreePath: 'C:\\tmp\\wt',
      env: {},
      cancelGraceMs: 10, // keep end-of-test cancels from pinning the loop 5s
      ...inputOverrides,
    },
    { registry, spawnFactory: () => spawn },
  );
  return { run, spawn, registry };
}

function awaitState(run: AgentRun, state: string): Promise<void> {
  return new Promise((resolve) => {
    if (run.getState() === state) return resolve();
    run.on('state', (next: string) => {
      if (next === state) resolve();
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('default policy: idle timeout still reaps a silent run', async () => {
  const { run } = makeRun({ idleMs: 25 });
  run.start();
  await awaitState(run, 'running');
  await sleep(80);
  assert.equal(run.getState(), 'failed');
  assert.equal(run.getRecord().cause, 'idle-timeout');
});

test('persistent-interactive: never idle-killed', async () => {
  const { run } = makeRun({ policy: 'persistent-interactive', idleMs: 25 });
  run.start();
  await awaitState(run, 'running');
  await sleep(80);
  assert.equal(run.getState(), 'running');
});

test('persistent-interactive: no wall-clock ceiling', async () => {
  const { run } = makeRun({ policy: 'persistent-interactive', wallClockMs: 25 });
  run.start();
  await awaitState(run, 'running');
  await sleep(80);
  assert.equal(run.getState(), 'running');
});

test('persistent-interactive: cap-exempt — never consumes a worker slot', async () => {
  const registry = new AgentRunRegistry({ maxConcurrent: 1 });
  const chat = makeRun({ policy: 'persistent-interactive', registry });
  chat.run.start();
  await awaitState(chat.run, 'running');
  assert.equal(registry.getActiveCount(), 0);

  // A worker still admits immediately — the chat holds no slot.
  const worker = makeRun({ registry });
  worker.run.start();
  await awaitState(worker.run, 'running');
  assert.equal(registry.getActiveCount(), 1);

  // Chat cancel never frees (or corrupts) worker slot math.
  chat.run.cancel();
  await sleep(30);
  assert.equal(registry.getActiveCount(), 1);

  worker.run.cancel(); // clear the worker's pending idle/wall-clock timers
  await sleep(30);
});

test('interrupt + resize forward to the spawn', async () => {
  const { run, spawn } = makeRun({ policy: 'persistent-interactive' });
  run.start();
  await awaitState(run, 'running');
  run.interrupt();
  run.resize(120, 40);
  assert.equal(spawn.interrupts, 1);
  assert.deepEqual(spawn.resizes, [{ cols: 120, rows: 40 }]);
});

test('turn-state: ready at prompt, busy on send/user-row, ready on turn-end', async () => {
  const { run, spawn } = makeRun({ policy: 'persistent-interactive' });
  const transitions: string[] = [];
  run.on('turn-state', (s: string) => transitions.push(s));
  run.start();
  await awaitState(run, 'running');
  assert.equal(run.getTurnState(), 'ready');

  await run.send('hello');
  assert.equal(run.getTurnState(), 'busy');

  spawn.emit('jsonl-event', { kind: 'jsonl-turn-end', text: 'hi', stopReason: 'end_turn', row: {} });
  assert.equal(run.getTurnState(), 'ready');

  // A queued command popping in the JSONL (no send through us) opens a turn.
  spawn.emit('jsonl-event', { kind: 'jsonl-user', text: 'queued', row: {} });
  assert.equal(run.getTurnState(), 'busy');

  assert.deepEqual(transitions, ['ready', 'busy', 'ready', 'busy']);
});

test('turn-state: fresh dispatch with initialInput goes straight to busy', async () => {
  const { run } = makeRun({ initialInput: 'do the work' });
  run.start();
  await awaitState(run, 'running');
  await sleep(5); // let the initialInput send settle
  assert.equal(run.getTurnState(), 'busy');
  run.cancel(); // clear the default-policy idle/wall-clock timers
  await sleep(30);
});

test('jsonl meta (source cursor) is re-emitted for the replay writer', async () => {
  const { run, spawn } = makeRun({ policy: 'persistent-interactive' });
  const seen: Array<{ kind: unknown; meta: unknown }> = [];
  run.on('jsonl-event', (ev: { kind?: unknown }, meta?: unknown) => {
    seen.push({ kind: ev.kind, meta });
  });
  run.start();
  await awaitState(run, 'running');

  spawn.emit(
    'jsonl-event',
    { kind: 'jsonl-turn-end', text: 'hi', stopReason: 'end_turn', row: {} },
    { sourceCursor: 7 },
  );
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { kind: 'jsonl-turn-end', meta: { sourceCursor: 7 } });
});

test('record carries policy + turnState', async () => {
  const { run } = makeRun({ policy: 'persistent-interactive' });
  run.start();
  await awaitState(run, 'running');
  const record = run.getRecord();
  assert.equal(record.policy, 'persistent-interactive');
  assert.equal(record.turnState, 'ready');
});
