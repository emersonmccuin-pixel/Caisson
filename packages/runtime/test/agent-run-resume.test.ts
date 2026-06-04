// M7 live-fire fix — the resume path delivers the answer with a POSITIVE
// receipt (the answer's JSONL user row), and the pre-pause spawn is killed
// (interactive CC does NOT exit when paused — the old comment's assumption).
//
// Live evidence (2026-06-04, 2/2 repro): echo-ack passed but CC discarded the
// composer during its --resume replay repaint → no user row, empty composer,
// run wedged 'running' forever; pc_kill_agent_run left the pre-pause
// claude.exe alive (two processes on one session).

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
  killed = false;
  quietCalls: Array<{ quietMs: number; maxWaitMs: number }> = [];
  /** Per-send hook — lets a test emit (or withhold) the receipt row. */
  onSend: ((body: string, sendIndex: number, self: FakeSpawn) => void) | null = null;

  start(): void {}
  async awaitReady(): Promise<ReadyTimestamps> {
    return { spawnedAt: 1, bannerAt: 2, readyAt: 3 } as unknown as ReadyTimestamps;
  }
  async awaitOutputQuiet(quietMs: number, maxWaitMs: number): Promise<boolean> {
    this.quietCalls.push({ quietMs, maxWaitMs });
    return true;
  }
  async send(body: string): Promise<SendResult> {
    this.sends.push(body);
    this.onSend?.(body, this.sends.length, this);
    return 'ok';
  }
  emitUser(cursor?: number): void {
    this.emit(
      'jsonl-event',
      { kind: 'jsonl-user' },
      cursor === undefined ? undefined : { sourceCursor: cursor },
    );
  }
  notifyMcpHandshake(): void {}
  interrupt(): void {}
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

/** Registry-backed run whose factory hands out a fresh FakeSpawn per spawn
 *  phase (fresh dispatch, then resume). */
function makeRun(overrides: Partial<AgentRunInput> = {}): {
  run: AgentRun;
  spawns: FakeSpawn[];
} {
  const spawns: FakeSpawn[] = [];
  const registry = new AgentRunRegistry({ maxConcurrent: 5 });
  const run = new AgentRun(
    {
      agentRunId: 'run-resume',
      ccProviderSessionId: 'cc-resume',
      podDefinition: { name: 'code-writer' },
      worktreePath: 'C:\\tmp\\wt',
      env: {},
      cancelGraceMs: 10,
      resumeReceiptTimeoutMs: 60, // keep retry loops fast in tests
      resumeQuietMaxWaitMs: 20,
      ...overrides,
    },
    {
      registry,
      spawnFactory: () => {
        const s = new FakeSpawn();
        spawns.push(s);
        return s;
      },
    },
  );
  return { run, spawns };
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

test('resume kills the pre-pause spawn and delivers the answer with a JSONL receipt', async () => {
  const { run, spawns } = makeRun();
  run.start();
  await awaitState(run, 'running');
  run._markPaused('ask-1');
  assert.equal(run.getState(), 'paused');

  run._resumeWithAnswer('the answer');
  await sleep(10);
  const [original, resume] = [spawns[0]!, spawns[1]!];
  assert.equal(original.killed, true, 'pre-pause claude.exe must be killed at resume');

  // First send → receipt lands → running, exactly one send.
  resume.emitUser(100);
  await awaitState(run, 'running');
  assert.deepEqual(resume.sends, ['the answer']);
  assert.equal(resume.quietCalls.length, 1, 'send is quiet-gated');
  assert.equal(resume.quietCalls[0]!.quietMs, 1500);

  run.cancel();
  await sleep(30);
});

test('eaten resume send is re-sent until the receipt lands', async () => {
  const { run, spawns } = makeRun();
  run.start();
  await awaitState(run, 'running');
  run._markPaused('ask-1');
  run._resumeWithAnswer('the answer');
  // The resume spawn is minted synchronously inside _resumeWithAnswer; hook
  // it before its first send fires (the send awaits the quiet gate first).
  const resume = spawns[1]!;
  // Withhold the receipt for send #1 (the eaten send); land it on send #2.
  resume.onSend = (_body, sendIndex, self) => {
    if (sendIndex === 2) setImmediate(() => self.emitUser(101));
  };
  // 'running' lands before the send loop — poll for the re-send outcome
  // (attempt 1 burns its 60ms receipt window first).
  const deadline = Date.now() + 2_000;
  while (resume.sends.length < 2 && Date.now() < deadline) await sleep(10);
  assert.equal(resume.sends.length, 2, 'one re-send after the eaten first');
  await sleep(20); // let the receipt settle
  assert.notEqual(run.getState(), 'failed');

  run.cancel();
  await sleep(30);
});

test('a resume answer that NEVER lands is a typed send-failed, not a silent wedge', async () => {
  const { run, spawns } = makeRun();
  run.start();
  await awaitState(run, 'running');
  run._markPaused('ask-1');
  run._resumeWithAnswer('the answer');

  await awaitState(run, 'failed');
  assert.equal(run.getRecord().cause, 'send-failed');
  assert.equal(spawns[1]!.sends.length, 3, 'all attempts consumed');
});

test('a replayed historical user row does not satisfy the receipt (cursor floor)', async () => {
  const { run, spawns } = makeRun();
  run.start();
  await awaitState(run, 'running');
  // Establish a cursor floor from the original turn's rows.
  spawns[0]!.emitUser(7);
  run._markPaused('ask-1');
  run._resumeWithAnswer('the answer');
  const resume = spawns[1]!;
  resume.onSend = (_body, sendIndex, self) => {
    if (sendIndex === 1) {
      // Tailer replays the ORIGINAL brief (cursor ≤ floor). If the floor is
      // broken this satisfies attempt 1 and NO re-send ever happens; with a
      // correct floor attempt 1 times out and attempt 2 fires.
      setImmediate(() => self.emitUser(7));
    }
    if (sendIndex === 2) setImmediate(() => self.emitUser(12));
  };
  const deadline = Date.now() + 2_000;
  while (resume.sends.length < 2 && Date.now() < deadline) await sleep(10);
  assert.equal(
    resume.sends.length,
    2,
    'replayed row satisfied attempt 1 — the cursor floor is broken',
  );
  await sleep(20);
  assert.notEqual(run.getState(), 'failed');

  run.cancel();
  await sleep(30);
});

test("the killed pre-pause spawn's exit event does not misfire the run terminal", async () => {
  const { run, spawns } = makeRun();
  run.start();
  await awaitState(run, 'running');
  run._markPaused('ask-1');
  run._resumeWithAnswer('the answer');
  await sleep(5);

  // The kill from _resumeWithAnswer surfaces as the OLD spawn's exit while
  // the resume is mid-flight. Identity guard must ignore it.
  spawns[0]!.emit('exit', 0, null);
  assert.notEqual(run.getState(), 'failed');

  spawns[1]!.emitUser(50);
  await awaitState(run, 'running');

  run.cancel();
  await sleep(30);
});
