// Step-4 Slice 2 — OrchestratorHostSession: the orchestrator chat as an
// Engine-owned persistent-interactive run.
//
// Covers the swap's survival contracts against a fake host port:
//   - dispatch carries policy + mode + spawn shaping
//   - state mapping run-state → spawning/ready/busy (+ turn-end)
//   - replay log re-persisted from the wire, cursor-deduped (G7)
//   - ADOPT a still-live host run after an API restart (no double-spawn)
//   - host-respawn → FD-18 spawning + re-dispatch with --resume (G5)
//   - close() cancels; `settled` resolves on the host terminal
//   - interrupt / resize / write-raw forward as host commands

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppendConversationEventInput } from '@pc/db';

import type {
  AgentHostCommand,
  AgentHostCommandResponse,
  AgentHostEvent,
  AgentHostRunSnapshot,
} from '@pc/runtime';

import {
  OrchestratorHostSession,
  asOrchestratorHostPort,
  type OrchestratorHostPort,
} from '../src/services/orchestrator-host-session.ts';

type RunPatch = Partial<AgentHostRunSnapshot>;

/** Distributive Omit — `Omit<Union, 'seq'>` collapses the union otherwise. */
type HostEventPayload = AgentHostEvent extends infer E
  ? E extends AgentHostEvent
    ? Omit<E, 'seq'>
    : never
  : never;

class FakeHostPort implements OrchestratorHostPort {
  commands: AgentHostCommand[] = [];
  roster: AgentHostRunSnapshot[] = [];
  private listeners = new Set<(e: AgentHostEvent) => void>();
  private seq = 0;
  /** Override per-command responses; default = ok with a snapshot. */
  respond: (cmd: AgentHostCommand) => AgentHostCommandResponse | null = () => null;

  async sendCommand(cmd: AgentHostCommand): Promise<AgentHostCommandResponse> {
    this.commands.push(cmd);
    const custom = this.respond(cmd);
    if (custom) return custom;
    if (cmd.type === 'start-run') {
      const run = snapshotFor(cmd.request.runId, {
        ccSessionId: cmd.request.ccSessionId,
        state: 'spawning',
        policy: cmd.request.policy,
      });
      this.roster.push(run);
      return { ok: true, command: 'start-run', run, lastSeq: ++this.seq };
    }
    if (cmd.type === 'cancel') {
      return {
        ok: true,
        command: 'cancel',
        run: snapshotFor(cmd.runId, { state: 'running' }),
        lastSeq: ++this.seq,
      };
    }
    if (
      cmd.type === 'send' ||
      cmd.type === 'interrupt' ||
      cmd.type === 'resize' ||
      cmd.type === 'write-raw'
    ) {
      return {
        ok: true,
        command: cmd.type,
        run: snapshotFor(cmd.runId, { state: 'running' }),
        lastSeq: ++this.seq,
      };
    }
    if (cmd.type === 'notify-mcp-handshake') {
      return { ok: true, command: 'notify-mcp-handshake', lastSeq: ++this.seq };
    }
    throw new Error(`fake host: unhandled command ${cmd.type}`);
  }

  listRuns(): readonly AgentHostRunSnapshot[] {
    return this.roster;
  }

  async refreshRuns(): Promise<readonly AgentHostRunSnapshot[]> {
    return this.roster;
  }

  onEvent(listener: (e: AgentHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitEvent(event: HostEventPayload): void {
    const e = { seq: ++this.seq, ...event } as AgentHostEvent;
    for (const l of this.listeners) l(e);
  }

  commandsOf<T extends AgentHostCommand['type']>(type: T): Extract<AgentHostCommand, { type: T }>[] {
    return this.commands.filter((c) => c.type === type) as Extract<AgentHostCommand, { type: T }>[];
  }
}

function snapshotFor(runId: string, patch: RunPatch = {}): AgentHostRunSnapshot {
  return {
    runId: runId as AgentHostRunSnapshot['runId'],
    projectId: '01PRJ' as AgentHostRunSnapshot['projectId'],
    dispatcherSessionId: 'pc-session-1',
    ccSessionId: 'cc-uuid-1',
    podName: 'orchestrator',
    worktreeDir: 'C:\\proj',
    state: 'running',
    policy: 'persistent-interactive',
    turnState: 'ready',
    jsonlPath: null,
    transcriptPath: null,
    queuedAt: 1,
    spawnedAt: 2,
    readyAt: 3,
    updatedAt: 4,
    terminalAt: null,
    ...patch,
  };
}

let runSeq = 0;

/** M3b — in-memory conversation_events double (rows per session; mirrors the
 *  repo's replay-state derivation: MAX(seq)+1 / MAX(source_cursor)). */
class FakeReplayStore {
  rows: (AppendConversationEventInput & { id: string })[] = [];
  append = (input: AppendConversationEventInput) => {
    this.rows.push({ ...input, id: `${input.sessionId}:${input.seq}` });
    return this.rows[this.rows.length - 1] as never;
  };
  state = (sessionId: string) => {
    const mine = this.rows.filter((r) => r.sessionId === sessionId);
    const maxSeq = mine.reduce((m, r) => Math.max(m, r.seq), 0);
    const maxCursor = mine.reduce((m, r) => Math.max(m, r.sourceCursor ?? 0), 0);
    return { nextSeq: maxSeq + 1, maxCursor };
  };
}

function makeSession(
  port: FakeHostPort,
  overrides: Partial<ConstructorParameters<typeof OrchestratorHostSession>[0]> = {},
  store = new FakeReplayStore(),
): { session: OrchestratorHostSession; dir: string; store: FakeReplayStore } {
  const dir = mkdtempSync(join(tmpdir(), 'orch-host-'));
  const session = new OrchestratorHostSession(
    {
      pcSessionId: 'pc-session-1',
      providerSessionId: 'cc-uuid-1',
      projectId: '01PRJ' as never,
      podDefinition: { name: 'pc:orchestrator', logicalName: 'orchestrator' },
      worktreePath: 'C:\\proj',
      env: {},
      mode: 'fresh',
      jsonlPath: join(dir, 'cc.jsonl'),
      transcriptPath: join(dir, 'transcript.log'),
      ...overrides,
    },
    {
      hostClient: port,
      mintRunId: () => `run-${++runSeq}`,
      transcriptPollMs: 50,
      awaitBeforeTimeoutMs: 200,
      appendReplayEvent: store.append,
      replayState: store.state,
    },
  );
  return { session, dir, store };
}

const tick = () => new Promise((r) => setImmediate(r));
async function settleTicks(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}

test('dispatches start-run with persistent-interactive policy + spawn shaping', async () => {
  const port = new FakeHostPort();
  const { session } = makeSession(port, {
    model: 'opus',
    requireReadySignal: true,
    requireMcpHandshake: true,
    cols: 120,
    rows: 30,
  });
  session.start();
  await settleTicks();

  const starts = port.commandsOf('start-run');
  assert.equal(starts.length, 1);
  const req = starts[0]!.request;
  assert.equal(req.policy, 'persistent-interactive');
  assert.equal(req.mode, 'fresh');
  assert.equal(req.ccSessionId, 'cc-uuid-1');
  assert.equal(req.model, 'opus');
  assert.equal(req.requireReadySignal, true);
  assert.equal(req.cols, 120);
  assert.equal(session.getState(), 'spawning');
  session.kill();
});

test('run-state maps to ready/busy and emits turn-end on busy→ready', async () => {
  const port = new FakeHostPort();
  const { session } = makeSession(port);
  const states: string[] = [];
  let turnEnds = 0;
  session.on('state', (s: string) => states.push(s));
  session.on('turn-end', () => turnEnds++);
  session.start();
  await settleTicks();

  const runId = port.commandsOf('start-run')[0]!.request.runId;
  port.emitEvent({ type: 'run-state', run: snapshotFor(runId, { turnState: 'ready' }) });
  assert.equal(session.getState(), 'ready');
  port.emitEvent({ type: 'run-state', run: snapshotFor(runId, { turnState: 'busy' }) });
  assert.equal(session.getState(), 'busy');
  port.emitEvent({ type: 'run-state', run: snapshotFor(runId, { turnState: 'ready' }) });
  assert.equal(session.getState(), 'ready');
  assert.equal(turnEnds, 1);
  assert.deepEqual(states, ['ready', 'busy', 'ready']);
  session.kill();
});

test('send routes to the host; jsonl events persist replay meta + dedup by cursor', async () => {
  const port = new FakeHostPort();
  const { session, store } = makeSession(port);
  const seen: Array<{ ev: unknown; replay: { seq: number } }> = [];
  session.on('jsonl-event', (ev: unknown, replay: { seq: number }) => seen.push({ ev, replay }));
  session.start();
  await settleTicks();
  const runId = port.commandsOf('start-run')[0]!.request.runId;
  port.emitEvent({ type: 'run-state', run: snapshotFor(runId, { turnState: 'ready' }) });

  assert.equal(await session.send('hello'), 'ok');
  assert.equal(port.commandsOf('send').length, 1);

  port.emitEvent({
    type: 'run-jsonl',
    runId,
    event: { kind: 'jsonl-user', text: 'hello', row: {} },
    cursor: 5,
    kind: 'jsonl-user',
    source: 'claude-jsonl',
  });
  // ONE provider row expands into usage + turn-end SHARING a cursor — both
  // must flow (live-fire bug 2026-06-04: a live-advancing dedup threshold ate
  // the turn-end, so the chat's reply text never reached the UI).
  port.emitEvent({
    type: 'run-jsonl',
    runId,
    event: { kind: 'jsonl-usage', inputTokens: 1, row: {} },
    cursor: 6,
    kind: 'jsonl-usage',
    source: 'claude-jsonl',
  });
  port.emitEvent({
    type: 'run-jsonl',
    runId,
    event: { kind: 'jsonl-turn-end', text: 'hi', row: {} },
    cursor: 6,
    kind: 'jsonl-turn-end',
    source: 'claude-jsonl',
  });

  assert.equal(seen.length, 3, 'equal-cursor live siblings must all flow');
  assert.equal(seen[0]!.replay.seq, 1);
  assert.equal(seen[2]!.replay.seq, 3);

  // M3b — rows land in the conversation_events store (was: file lines).
  assert.equal(store.rows.length, 3);
  const first = store.rows[0]!;
  assert.equal(first.type, 'jsonl');
  assert.equal(first.sessionId, 'pc-session-1');
  assert.equal(first.kind, 'jsonl-user');
  assert.equal(first.sourceCursor, 5);
  assert.equal(first.id, 'pc-session-1:1');
  const last = store.rows[2]!;
  assert.equal(last.kind, 'jsonl-turn-end');
  session.kill();
});

test('pre-restart frames replayed from the host buffer are deduped by the construct-time floor', async () => {
  const port = new FakeHostPort();
  const { session, dir, store } = makeSession(port);
  session.start();
  await settleTicks();
  const runId = port.commandsOf('start-run')[0]!.request.runId;
  // First lifetime persists cursors 1..7.
  for (let c = 1; c <= 7; c++) {
    port.emitEvent({
      type: 'run-jsonl',
      runId,
      event: { kind: 'jsonl-user', text: `t${c}`, row: {} },
      cursor: c,
      kind: 'jsonl-user',
      source: 'claude-jsonl',
    });
  }
  session.kill();

  // "API restart": a NEW adapter over the same replay store adopts the run and
  // the host buffer replays cursors 5..9 — only 8 and 9 are new.
  port.commands = [];
  port.roster = [snapshotFor(runId, { ccSessionId: 'cc-uuid-1' })];
  const second = new OrchestratorHostSession(
    {
      pcSessionId: 'pc-session-1',
      providerSessionId: 'cc-uuid-1',
      projectId: '01PRJ' as never,
      podDefinition: { name: 'pc:orchestrator' },
      worktreePath: 'C:\\proj',
      env: {},
      mode: 'resume',
      jsonlPath: join(dir, 'cc.jsonl'),
      transcriptPath: join(dir, 'transcript.log'),
    },
    {
      hostClient: port,
      mintRunId: () => 'run-second',
      transcriptPollMs: 50,
      awaitBeforeTimeoutMs: 100,
      appendReplayEvent: store.append,
      replayState: store.state,
    },
  );
  const seen: unknown[] = [];
  second.on('jsonl-event', (ev: unknown) => seen.push(ev));
  second.start();
  await settleTicks();

  for (let c = 5; c <= 9; c++) {
    port.emitEvent({
      type: 'run-jsonl',
      runId,
      event: { kind: 'jsonl-user', text: `t${c}`, row: {} },
      cursor: c,
      kind: 'jsonl-user',
      source: 'claude-jsonl',
    });
  }
  assert.equal(seen.length, 2, 'only post-floor cursors flow');
  assert.equal(store.rows.length, 9, '7 originals + 2 new, no duplicates');
  // Second lifetime resumed seq from the store: 8 and 9, no collisions.
  assert.deepEqual(store.rows.slice(7).map((r) => r.seq), [8, 9]);
  second.kill();
});

test('adopts a still-live host run after an API restart (no double spawn)', async () => {
  const port = new FakeHostPort();
  port.roster = [snapshotFor('run-existing', { ccSessionId: 'cc-uuid-1', turnState: 'ready' })];
  const { session } = makeSession(port);
  session.start();
  await settleTicks();

  assert.equal(port.commandsOf('start-run').length, 0, 'must not double-spawn');
  assert.equal(session.getState(), 'ready');
  assert.equal(session.getSnapshot().spawnAttemptId, 'run-existing');
  session.kill();
});

test('host respawn → FD-18 spawning + re-dispatch with --resume past the replay cursor', async () => {
  const port = new FakeHostPort();
  const { session } = makeSession(port);
  const states: string[] = [];
  session.on('state', (s: string) => states.push(s));
  session.start();
  await settleTicks();
  const firstRunId = port.commandsOf('start-run')[0]!.request.runId;
  port.emitEvent({ type: 'run-state', run: snapshotFor(firstRunId, { turnState: 'ready' }) });
  port.emitEvent({
    type: 'run-jsonl',
    runId: firstRunId,
    event: { kind: 'jsonl-turn-end', text: 'hi', row: {} },
    cursor: 42,
    kind: 'jsonl-turn-end',
    source: 'claude-jsonl',
  });

  // First host identity, then a NEW host (respawn) whose roster lost our run.
  port.emitEvent({
    type: 'host-ready',
    identity: { hostId: 'host-A', pid: 1, startedAt: 1, protocolVersion: 1 },
  });
  port.roster = [];
  port.emitEvent({
    type: 'host-ready',
    identity: { hostId: 'host-B', pid: 2, startedAt: 2, protocolVersion: 1 },
  });
  await settleTicks();

  const starts = port.commandsOf('start-run');
  assert.equal(starts.length, 2, 'expected a recovery re-dispatch');
  const recovery = starts[1]!.request;
  assert.equal(recovery.mode, 'resume');
  assert.equal(recovery.ccSessionId, 'cc-uuid-1');
  assert.ok((recovery.jsonlStartLine ?? 0) >= 42, 'resume must skip persisted lines');
  assert.equal(recovery.requireMcpHandshake, false);
  assert.ok(states.includes('spawning'), 'FD-18 loading state must broadcast');
  session.kill();
});

test('terminal failed → failed state + reason; settled resolves', async () => {
  const port = new FakeHostPort();
  const { session } = makeSession(port);
  let failedReason: string | null = null;
  session.on('failed', (r: string) => (failedReason = r));
  session.start();
  await settleTicks();
  const runId = port.commandsOf('start-run')[0]!.request.runId;

  port.emitEvent({
    type: 'run-terminal',
    run: snapshotFor(runId, {
      state: 'failed',
      terminalAt: 9,
      terminalResult: {
        status: 'failed',
        result: null,
        failureCause: 'spawn-stuck',
        failureReason: 'claude.exe never became ready',
      },
    }),
  });
  assert.equal(session.getState(), 'failed');
  assert.equal(failedReason, 'claude.exe never became ready');
  await session.settled; // must resolve
});

test('close() cancels the run; settled resolves on the host terminal', async () => {
  const port = new FakeHostPort();
  const { session } = makeSession(port);
  session.start();
  await settleTicks();
  const runId = port.commandsOf('start-run')[0]!.request.runId;
  port.emitEvent({ type: 'run-state', run: snapshotFor(runId, { turnState: 'ready' }) });

  let exited = 0;
  session.on('exited', () => exited++);
  session.close();
  assert.equal(session.getState(), 'exited');
  assert.equal(exited, 1);
  await settleTicks();
  assert.equal(port.commandsOf('cancel').length, 1);

  port.emitEvent({
    type: 'run-terminal',
    run: snapshotFor(runId, {
      state: 'cancelled',
      terminalAt: 9,
      terminalResult: { status: 'cancelled', result: null, failureCause: 'cancelled', failureReason: null },
    }),
  });
  await session.settled; // resolves via the host terminal
});

test('interrupt / resize / write-raw forward as host commands', async () => {
  const port = new FakeHostPort();
  const { session } = makeSession(port);
  session.start();
  await settleTicks();
  const runId = port.commandsOf('start-run')[0]!.request.runId;
  port.emitEvent({ type: 'run-state', run: snapshotFor(runId, { turnState: 'ready' }) });

  session.interrupt();
  session.resize(132, 43);
  assert.equal(session.writeRaw('\x1b[A'), true);
  await settleTicks();

  assert.equal(port.commandsOf('interrupt').length, 1);
  const resize = port.commandsOf('resize')[0]!;
  assert.equal(resize.cols, 132);
  assert.equal(resize.rows, 43);
  const raw = port.commandsOf('write-raw')[0]!;
  assert.equal(raw.data, '\x1b[A');
  session.kill();
});

test('start-run failure → typed failed state (no alternate spawn)', async () => {
  const port = new FakeHostPort();
  port.respond = (cmd) =>
    cmd.type === 'start-run'
      ? { ok: false, command: 'start-run', code: 'host-shutting-down', error: 'host is shutting down', lastSeq: 1 }
      : null;
  const { session } = makeSession(port);
  session.start();
  await settleTicks();
  assert.equal(session.getState(), 'failed');
  assert.match(session.getSnapshot().failureReason ?? '', /shutting down/);
  await session.settled;
});

test('asOrchestratorHostPort narrows only full clients', () => {
  const port = new FakeHostPort();
  assert.equal(asOrchestratorHostPort(port), port);
  assert.equal(asOrchestratorHostPort(null), null);
  assert.equal(asOrchestratorHostPort({ sendCommand: () => {} }), null);
});
