// The P9/FD-17 stall ladder. Fully deps-injected, no DB: covers computeIdleMs,
// the emit-once `stalled` badge (rung 1: warn + un-stall + set-prune), and the
// verify-alive → orchestrator mailbox notify (rung 2: emit-once per episode,
// episode reset on activity, restart-stable idempotency key, never a kill).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AgentRunRow, AgentRunStatus, ULID } from '@pc/domain';
import type { EnqueueMailboxMessageInput } from '@pc/db';

import { computeIdleMs } from '../src/services/agent-run-idle.ts';
import { sweepStallWarn } from '../src/services/agent-run-stall-warn.ts';

function row(patch: Partial<AgentRunRow> = {}): AgentRunRow {
  return {
    id: 'run-1' as ULID,
    projectId: 'proj-1' as ULID,
    dispatcherSessionId: 'disp-1',
    ccSessionId: 'cc-1',
    podName: 'planner',
    podRevisionAtDispatch: null,
    podRevisionAtResume: null,
    status: 'running' as AgentRunStatus,
    continues: null,
    parentInvokeDepth: 0,
    parentWorkItemId: null,
    input: 'go',
    result: null,
    failureCause: null,
    failureReason: null,
    queuedAt: 1000,
    spawnedAt: 2000,
    readyAt: 3000,
    pid: null,
    lastActivityAt: 5000,
    deliveredAt: null,
    contractId: null,
    completedAt: null,
    rev: 0,
    ...patch,
  };
}

const WARN = 60_000;
const NOTIFY = 120_000;

test('computeIdleMs takes the latest sign of life incl. jsonl mtime', () => {
  const r = row({ lastActivityAt: 5000, readyAt: 3000, queuedAt: 1000 });
  // jsonl mtime newer than every row timestamp → it wins.
  assert.equal(computeIdleMs(r, { now: 20_000, jsonlMtime: 9000 }), 11_000);
  // null mtime → falls back to lastActivityAt (the max row timestamp).
  assert.equal(computeIdleMs(r, { now: 20_000, jsonlMtime: null }), 15_000);
});

test('computeIdleMs: ptyActivityAt beats stale jsonlMtime and row timestamps', () => {
  // Scenario: long thinking turn. JSONL mtime is stale (CC hasn't flushed),
  // but the PTY is actively repainting the spinner. ptyActivityAt is fresh.
  const r = row({ lastActivityAt: 1000, readyAt: 2000, queuedAt: 500 });
  const freshPtyAt = 19_500; // PTY chunk arrived 500ms ago
  assert.equal(
    computeIdleMs(r, { now: 20_000, jsonlMtime: 2000, ptyActivityAt: freshPtyAt }),
    500,
    'fresh PTY activity drives the idle calculation',
  );
  // No PTY signal → falls back to jsonlMtime / row.
  assert.equal(
    computeIdleMs(r, { now: 20_000, jsonlMtime: 2000, ptyActivityAt: null }),
    18_000,
  );
});

interface Emit {
  runId: string;
  reason: 'stalled' | 'reconciled';
}

function harness(
  rows: AgentRunRow[],
  opts: { now: number; mtime?: number | null; ptyAt?: number | null },
) {
  const emits: Emit[] = [];
  const enqueued: EnqueueMailboxMessageInput[] = [];
  const stalledRuns = new Set<string>();
  const notifiedRuns = new Set<string>();
  const run = (over: { now?: number; mtime?: number | null; ptyAt?: number | null } = {}) =>
    sweepStallWarn({
      stalledRuns,
      notifiedRuns,
      mailboxEnqueue: (input) => enqueued.push(input as EnqueueMailboxMessageInput),
      now: () => over.now ?? opts.now,
      warnMs: WARN,
      notifyMs: NOTIFY,
      listNonTerminalRuns: () => rows,
      resolveJsonlPath: () => '/x.jsonl',
      jsonlMtime: () => (over.mtime !== undefined ? over.mtime : (opts.mtime ?? null)),
      lastAction: () => ({ kind: 'jsonl-tool-call', text: 'Read file.ts' }),
      announceSignal: (input) => emits.push({ runId: input.runId, reason: input.reason }),
      ptyActivityAt: () =>
        over.ptyAt !== undefined ? over.ptyAt : (opts.ptyAt ?? null),
    });
  return { emits, enqueued, stalledRuns, notifiedRuns, run };
}

// ── rung 1: the badge ─────────────────────────────────────────────────────────

test('quiet running run warns once, no re-emit on the next tick', () => {
  const rows = [row({ lastActivityAt: 1000 })];
  const h = harness(rows, { now: 1000 + WARN + 5000 });

  const r1 = h.run();
  assert.deepEqual(r1, { checked: 1, warned: 1, cleared: 0, notified: 0 });
  assert.deepEqual(h.emits, [{ runId: 'run-1', reason: 'stalled' }]);
  assert.ok(h.stalledRuns.has('run-1'));

  const r2 = h.run();
  assert.deepEqual(r2, { checked: 1, warned: 0, cleared: 0, notified: 0 });
  assert.equal(h.emits.length, 1, 'no second stalled frame');
});

test('un-stall: activity resumes → reconciled frame, dropped from the set', () => {
  const rows = [row({ lastActivityAt: 1000 })];
  const h = harness(rows, { now: 1000 + WARN + 5000 });
  h.run();
  assert.ok(h.stalledRuns.has('run-1'));

  // Activity resumes (fresh mtime) — idle drops under WARN.
  const res = h.run({ mtime: 1000 + WARN + 4000 });
  assert.deepEqual(res, { checked: 1, warned: 0, cleared: 1, notified: 0 });
  assert.equal(h.emits.at(-1)?.reason, 'reconciled');
  assert.ok(!h.stalledRuns.has('run-1'));
});

test('paused and queued runs are never badged', () => {
  const rows = [
    row({ id: 'p' as ULID, status: 'paused', lastActivityAt: 0 }),
    row({ id: 'q' as ULID, status: 'queued', lastActivityAt: 0 }),
  ];
  const h = harness(rows, { now: 10 * WARN });
  const res = h.run();
  assert.deepEqual(res, { checked: 0, warned: 0, cleared: 0, notified: 0 });
  assert.equal(h.emits.length, 0);
});

test('a stalled run that leaves the running set is pruned from the tracking sets', () => {
  const rows = [row({ lastActivityAt: 1000 })];
  const h = harness(rows, { now: 1000 + NOTIFY + 5000 });
  h.run();
  assert.ok(h.stalledRuns.has('run-1'));
  assert.ok(h.notifiedRuns.has('run-1'));

  // Next tick the run is gone (terminal → excluded from non-terminal list).
  rows.length = 0;
  const res = h.run();
  assert.deepEqual(res, { checked: 0, warned: 0, cleared: 0, notified: 0 });
  assert.ok(!h.stalledRuns.has('run-1'), 'badge set pruned');
  assert.ok(!h.notifiedRuns.has('run-1'), 'notify set pruned');
});

// ── rung 2: verify-alive → orchestrator notify ───────────────────────────────

test('past the notify window: ONE agent-stalled mailbox to the active orchestrator', () => {
  // The episode floor is the MAX life sign — pin every row timestamp at/below
  // lastActivityAt so the idempotency-key assertion is exact.
  const last = 3000;
  const now = last + NOTIFY + 5000;
  const rows = [row({ lastActivityAt: last })];
  const h = harness(rows, { now });

  const r1 = h.run();
  assert.equal(r1.notified, 1);
  assert.equal(h.enqueued.length, 1);

  const msg = h.enqueued[0].message;
  assert.equal(msg.kind, 'agent-stalled');
  assert.equal(msg.sourceId, 'run-1');
  assert.match(msg.subject ?? '', /planner/);
  assert.match(msg.body, /NOT been killed/);
  assert.match(msg.body, /jsonl-tool-call/, 'verify-alive read rides the body');
  // Restart-stable episode key: embeds the last-activity floor.
  assert.equal(msg.idempotencyKey, `agent-stalled:run-1:${last}`);

  const rcpt = h.enqueued[0].recipients[0];
  assert.equal(rcpt.addressKind, 'active-orchestrator');
  assert.equal(rcpt.channel, 'orchestrator-turn');

  // Tick again — same episode, no second mailbox.
  const r2 = h.run();
  assert.equal(r2.notified, 0);
  assert.equal(h.enqueued.length, 1, 'emit-once per episode');
});

test('episode reset: life → quiet again notifies AGAIN with a new key', () => {
  const rows = [row({ lastActivityAt: 1000 })];
  const h = harness(rows, { now: 1000 + NOTIFY + 5000 });
  h.run();
  assert.equal(h.enqueued.length, 1);

  // Sign of life (fresh mtime under WARN) — clears badge AND notify latch.
  const lifeAt = 1000 + NOTIFY + 5000;
  h.run({ now: lifeAt + 1000, mtime: lifeAt });
  assert.ok(!h.notifiedRuns.has('run-1'), 'notify latch cleared on activity');

  // Quiet again past the notify window — a NEW episode notifies.
  const r3 = h.run({ now: lifeAt + NOTIFY + 5000, mtime: lifeAt });
  assert.equal(r3.notified, 1);
  assert.equal(h.enqueued.length, 2);
  assert.equal(h.enqueued[1].message.idempotencyKey, `agent-stalled:run-1:${lifeAt}`);
  assert.notEqual(
    h.enqueued[0].message.idempotencyKey,
    h.enqueued[1].message.idempotencyKey,
    'new episode, new key',
  );
});

test('no mailbox port wired → badge-only, never throws', () => {
  const rows = [row({ lastActivityAt: 1000 })];
  const emits: Emit[] = [];
  const res = sweepStallWarn({
    stalledRuns: new Set<string>(),
    now: () => 1000 + NOTIFY + 5000,
    warnMs: WARN,
    notifyMs: NOTIFY,
    listNonTerminalRuns: () => rows,
    resolveJsonlPath: () => '/x.jsonl',
    jsonlMtime: () => null,
    announceSignal: (input) => emits.push({ runId: input.runId, reason: input.reason }),
  });
  assert.deepEqual(res, { checked: 1, warned: 1, cleared: 0, notified: 0 });
});

// ── PTY-activity signal: false-stall prevention ────────────────────────────────

test('stale JSONL mtime + recent PTY activity → NOT stalled (thinking-turn guard)', () => {
  // Scenario: agent is deep in a thinking turn. The JSONL transcript mtime is
  // stale (CC buffers until turn-end), but the PTY spinner is actively
  // repainting — run-chunk events are flowing. The ptyActivityAt signal is
  // fresh, so idleMs is tiny and the sweep must NOT badge the run.
  const startedAt = 1000;
  const now = startedAt + WARN + 30_000; // well past the 3-min warn threshold
  const ptyAt = now - 5_000;             // PTY chunk 5 s ago (fresh)

  const rows = [row({ lastActivityAt: startedAt, readyAt: startedAt })];
  const h = harness(rows, { now, mtime: startedAt, ptyAt });

  const res = h.run();
  assert.deepEqual(res, { checked: 1, warned: 0, cleared: 0, notified: 0 },
    'recent PTY activity suppresses the stall badge');
  assert.equal(h.emits.length, 0, 'no stalled frame emitted');
});

test('stale JSONL mtime + stale PTY activity → stalled (truly idle run)', () => {
  // Scenario: agent is genuinely wedged. Both the JSONL mtime and the PTY
  // activity are old — no PTY output has arrived for more than WARN_MS.
  const startedAt = 1000;
  const ptyAt = startedAt + 2_000; // PTY last active right after start
  const now = startedAt + WARN + 30_000; // now well past warn

  const rows = [row({ lastActivityAt: startedAt, readyAt: startedAt })];
  const h = harness(rows, { now, mtime: startedAt, ptyAt });

  const res = h.run();
  assert.deepEqual(res, { checked: 1, warned: 1, cleared: 0, notified: 0 },
    'stale PTY + stale JSONL → stall badge fires');
  assert.equal(h.emits[0]?.reason, 'stalled');
});

test('PTY activity un-stalls a previously stalled run', () => {
  // Run goes quiet → badge fires. Then PTY chunks resume → reconciled frame.
  const startedAt = 1000;
  const now1 = startedAt + WARN + 30_000;
  const rows = [row({ lastActivityAt: startedAt })];

  // First sweep: quiet → stalled.
  const h = harness(rows, { now: now1, mtime: startedAt, ptyAt: startedAt });
  h.run();
  assert.ok(h.stalledRuns.has('run-1'), 'stalled after first sweep');

  // PTY activity resumes — chunk arrived just before the sweep.
  const ptyNow = now1 + 1_000;
  const res = h.run({ now: ptyNow, ptyAt: ptyNow - 2_000 });
  assert.deepEqual(res, { checked: 1, warned: 0, cleared: 1, notified: 0 });
  assert.equal(h.emits.at(-1)?.reason, 'reconciled');
  assert.ok(!h.stalledRuns.has('run-1'), 'badge cleared when PTY resumes');
});

test('no ptyActivityAt dep wired → falls back to JSONL mtime (backward compat)', () => {
  // When the dep is absent the sweep behaves identically to the pre-fix code.
  const rows = [row({ lastActivityAt: 1000 })];
  const emits: Emit[] = [];
  const res = sweepStallWarn({
    stalledRuns: new Set<string>(),
    now: () => 1000 + WARN + 5000,
    warnMs: WARN,
    notifyMs: NOTIFY,
    listNonTerminalRuns: () => rows,
    resolveJsonlPath: () => '/x.jsonl',
    jsonlMtime: () => null,
    // ptyActivityAt intentionally absent
    announceSignal: (input) => emits.push({ runId: input.runId, reason: input.reason }),
  });
  assert.deepEqual(res, { checked: 1, warned: 1, cleared: 0, notified: 0 });
});
