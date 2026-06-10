// Audit #3 (2026-06-10) — the deliverable watchdog. `deliveredAt` is a durable
// positive receipt; a run still `running` past the grace window means the
// route's detached complete-run relay was dropped AND the host's terminal
// never arrived. Rung 1: re-send the relay. Rung 2 (another grace later):
// finalize locally through the one terminal authority. Paused runs and
// fresh deliveries are never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRunReconciler } from '../src/services/agent-run-reconciler.ts';
import { ActiveRunRegistry } from '../src/services/agent-active-runs.ts';

const GRACE_MS = 1_000;

function fakeRow(overrides: Record<string, unknown> = {}): never {
  return {
    id: 'run-1',
    projectId: 'p1',
    dispatcherSessionId: 'disp-1',
    ccSessionId: 'cc-1',
    podName: 'worker',
    status: 'running',
    parentWorkItemId: null,
    worktreeDir: 'C:\\tmp\\wt',
    result: null,
    queuedAt: 0,
    deliveredAt: null,
    contractId: 'contract-1',
    ...overrides,
  } as never;
}

function watchdogProbe(rows: never[]) {
  let nowMs = 100_000;
  const sentCommands: Array<Record<string, unknown>> = [];
  const terminalCalls: Array<Record<string, unknown>> = [];
  const host = {
    sendCommand: (cmd: Record<string, unknown>) => {
      sentCommands.push(cmd);
      return Promise.resolve({ ok: true });
    },
    listRuns: () => [],
    refreshRuns: () => Promise.resolve([]),
    isConnected: () => true,
    onEvent: () => () => {},
  };
  const reconciler = createAgentRunReconciler({
    host: host as never,
    activeRunRegistry: new ActiveRunRegistry(),
    log: () => {},
    warn: () => {},
    now: () => nowMs,
    deliveredGraceMs: GRACE_MS,
    listNonTerminalRuns: () => rows,
    applyTerminalEffects: ((input: Record<string, unknown>) => {
      terminalCalls.push(input);
      return { applied: 1 };
    }) as never,
    reconcileHost: (() => ({
      checked: 0,
      terminalApplied: 0,
      statusUpdated: 0,
      registered: 0,
      backfilledEvents: 0,
      hostLost: 0,
      jsonlBroadcast: 0,
    })) as never,
    stallWarn: (() => ({ warned: 0, cleared: 0, notified: 0 })) as never,
  });
  return {
    reconciler,
    sentCommands,
    terminalCalls,
    setNow: (v: number) => {
      nowMs = v;
    },
    nowMs: () => nowMs,
  };
}

test('delivered-watchdog: re-sends complete-run after grace, finalizes locally after 2x grace', async () => {
  const row = fakeRow({ deliveredAt: 100_000 });
  const probe = watchdogProbe([row]);

  // Within grace — untouched.
  probe.setNow(100_000 + GRACE_MS - 1);
  await probe.reconciler.tick();
  assert.equal(probe.sentCommands.length, 0, 'no relay re-send within grace');
  assert.equal(probe.terminalCalls.length, 0);

  // Past grace — rung 1: relay re-sent exactly once, no local finalize yet.
  probe.setNow(100_000 + GRACE_MS + 1);
  await probe.reconciler.tick();
  assert.equal(probe.sentCommands.length, 1);
  assert.deepEqual(probe.sentCommands[0], {
    type: 'complete-run',
    runId: 'run-1',
    result: '',
  });
  assert.equal(probe.terminalCalls.length, 0, 'rung 1 gives the host its chance');

  // Still stuck past 2x grace — rung 2: local finalize through the authority.
  probe.setNow(100_000 + GRACE_MS * 2 + 1);
  await probe.reconciler.tick();
  assert.equal(probe.terminalCalls.length, 1, 'finalized locally');
  assert.equal(probe.terminalCalls[0]!.runId, 'run-1');
  assert.equal(probe.terminalCalls[0]!.status, 'completed');
  assert.equal(probe.terminalCalls[0]!.contractId, 'contract-1');
  assert.equal(probe.sentCommands.length, 1, 'relay not re-sent again');
});

test('delivered-watchdog: never touches paused or undelivered runs', async () => {
  const paused = fakeRow({ id: 'run-paused', status: 'paused', deliveredAt: 1 });
  const undelivered = fakeRow({ id: 'run-undelivered', deliveredAt: null });
  const probe = watchdogProbe([paused, undelivered]);

  probe.setNow(10_000_000); // far past any grace
  await probe.reconciler.tick();
  assert.equal(probe.sentCommands.length, 0);
  assert.equal(probe.terminalCalls.length, 0);
});
