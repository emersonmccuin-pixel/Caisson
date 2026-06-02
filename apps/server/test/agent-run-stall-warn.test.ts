// T2.2 — idle math + the non-terminal `stalled` warn pass. Fully deps-injected,
// no DB: covers computeIdleMs and the emit-once warn + un-stall +
// set-prune behavior of sweepStallWarn.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AgentRunRow, AgentRunStatus, ULID } from '@pc/domain';

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
    completedAt: null,
    rev: 0,
    ...patch,
  };
}

const WARN = 60_000;

test('computeIdleMs takes the latest sign of life incl. jsonl mtime', () => {
  const r = row({ lastActivityAt: 5000, readyAt: 3000, queuedAt: 1000 });
  // jsonl mtime newer than every row timestamp → it wins.
  assert.equal(computeIdleMs(r, { now: 20_000, jsonlMtime: 9000 }), 11_000);
  // null mtime → falls back to lastActivityAt (the max row timestamp).
  assert.equal(computeIdleMs(r, { now: 20_000, jsonlMtime: null }), 15_000);
});

interface Emit {
  runId: string;
  reason: 'stalled' | 'reconciled';
}

function harness(rows: AgentRunRow[], opts: { now: number; mtime?: number | null }) {
  const emits: Emit[] = [];
  const stalledRuns = new Set<string>();
  const run = () =>
    sweepStallWarn({
      stalledRuns,
      now: () => opts.now,
      warnMs: WARN,
      listNonTerminalRuns: () => rows,
      resolveJsonlPath: () => '/x.jsonl',
      jsonlMtime: () => opts.mtime ?? null,
      announceSignal: (input) => emits.push({ runId: input.runId, reason: input.reason }),
    });
  return { emits, stalledRuns, run };
}

test('quiet running run warns once, no re-emit on the next tick', () => {
  const rows = [row({ lastActivityAt: 1000 })];
  const h = harness(rows, { now: 1000 + WARN + 5000 });

  const r1 = h.run();
  assert.deepEqual(r1, { checked: 1, warned: 1, cleared: 0 });
  assert.deepEqual(h.emits, [{ runId: 'run-1', reason: 'stalled' }]);
  assert.ok(h.stalledRuns.has('run-1'));

  const r2 = h.run();
  assert.deepEqual(r2, { checked: 1, warned: 0, cleared: 0 });
  assert.equal(h.emits.length, 1, 'no second stalled frame');
});

test('un-stall: activity resumes → reconciled frame, dropped from the set', () => {
  const rows = [row({ lastActivityAt: 1000 })];
  // First tick: stalled.
  const h = harness(rows, { now: 1000 + WARN + 5000 });
  h.run();
  assert.ok(h.stalledRuns.has('run-1'));

  // Activity resumes (fresh mtime) — re-run with a recent jsonl mtime.
  const emits = h.emits;
  const stalledRuns = h.stalledRuns;
  const res = sweepStallWarn({
    stalledRuns,
    now: () => 1000 + WARN + 5000,
    warnMs: WARN,
    listNonTerminalRuns: () => rows,
    resolveJsonlPath: () => '/x.jsonl',
    jsonlMtime: () => 1000 + WARN + 4000, // idle now < WARN
    announceSignal: (input) => emits.push({ runId: input.runId, reason: input.reason }),
  });
  assert.deepEqual(res, { checked: 1, warned: 0, cleared: 1 });
  assert.equal(emits.at(-1)?.reason, 'reconciled');
  assert.ok(!stalledRuns.has('run-1'));
});

test('paused and queued runs are never badged', () => {
  const rows = [
    row({ id: 'p' as ULID, status: 'paused', lastActivityAt: 0 }),
    row({ id: 'q' as ULID, status: 'queued', lastActivityAt: 0 }),
  ];
  const h = harness(rows, { now: 10 * WARN });
  const res = h.run();
  assert.deepEqual(res, { checked: 0, warned: 0, cleared: 0 });
  assert.equal(h.emits.length, 0);
});

test('a stalled run that leaves the running set is pruned from the tracking set', () => {
  const rows = [row({ lastActivityAt: 1000 })];
  const h = harness(rows, { now: 1000 + WARN + 5000 });
  h.run();
  assert.ok(h.stalledRuns.has('run-1'));

  // Next tick the run is gone (terminal → excluded from non-terminal list).
  rows.length = 0;
  const res = h.run();
  assert.deepEqual(res, { checked: 0, warned: 0, cleared: 0 });
  assert.ok(!h.stalledRuns.has('run-1'), 'pruned');
});
