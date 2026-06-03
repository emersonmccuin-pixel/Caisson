// Step 2 guards — ONE reconciler, all states.
//
// 1. ONE-RECONCILER  — exactly one interval owner for run liveness; index.ts
//                      consumes the module, never the raw sweeps; the deleted
//                      boot-reconcile path stays deleted.
// 2. HOLD            — an unreachable / unrefreshed host withholds the absence
//                      signal, the counters, and handle registration: nothing
//                      can finalize on no-information (boot AND tick).
// 3. PAUSED-SURVIVES — FD-14 law: no reconciler path finalizes a paused run
//                      (host mode is guarded in agent-host-reattach.test.ts;
//                      the in-process sweep is guarded here).
// 4. Queued-orphan   — the in-process replacement for the deleted bulk-fail:
//                      a queued row with no registry entry finalizes
//                      `server-restart` after consecutive confirmed misses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentRunRow, ULID } from '@pc/domain';

import { createAgentRunReconciler } from '../src/services/agent-run-reconciler.ts';
import { sweepAgentRunLiveness } from '../src/services/agent-run-liveness-sweep.ts';
import { ActiveRunRegistry } from '../src/services/agent-active-runs.ts';

const SRC = join(import.meta.dirname, '..', 'src');

function row(id: string, patch: Partial<AgentRunRow> = {}): AgentRunRow {
  return {
    id: id as ULID,
    projectId: '01KRECONCILERPROJ00000001' as ULID,
    dispatcherSessionId: 'orch-session',
    ccSessionId: `cc-${id}`,
    podName: 'researcher',
    podRevisionAtDispatch: 'agent:1',
    podRevisionAtResume: null,
    status: 'queued',
    continues: null,
    parentInvokeDepth: 0,
    parentWorkItemId: null,
    input: 'input',
    result: null,
    failureCause: null,
    failureReason: null,
    queuedAt: 1_700_000_000_000,
    spawnedAt: null,
    readyAt: null,
    pid: null,
    lastActivityAt: null,
    completedAt: null,
    deliveredAt: null,
    contractId: null,
    rev: 0,
    ...patch,
  };
}

// ── 1. ONE-RECONCILER (structural guard) ─────────────────────────────────────

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('ONE-RECONCILER: the deleted boot-reconcile path stays deleted', () => {
  assert.equal(
    existsSync(join(SRC, 'services', 'agent-run-boot-reconcile.ts')),
    false,
    'agent-run-boot-reconcile.ts must not regrow',
  );
  assert.equal(
    existsSync(join(SRC, 'services', 'agent-run-server-boot.ts')),
    false,
    'agent-run-server-boot.ts must not regrow',
  );
  const deletedImport = /from\s+'[^']*agent-run-(?:boot-reconcile|server-boot)/;
  for (const file of walkTsFiles(SRC)) {
    const content = readFileSync(file, 'utf8');
    assert.ok(
      !deletedImport.test(content),
      `${file} must not import the deleted boot-reconcile path`,
    );
  }
});

test('ONE-RECONCILER: index.ts consumes the reconciler module, never the raw sweeps', () => {
  const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
  assert.ok(
    index.includes("from './services/agent-run-reconciler.ts'"),
    'index.ts imports the one reconciler',
  );
  for (const banned of [
    'agent-host-reattach.ts',
    'agent-run-liveness-sweep.ts',
    'agent-run-stall-warn.ts',
  ]) {
    assert.ok(!index.includes(banned), `index.ts must not import ${banned} (a second loop owner)`);
  }
});

test('ONE-RECONCILER: exactly one liveness interval owner in src', () => {
  // The loop's setInterval lives in agent-run-reconciler.ts. No other source
  // file may call the sweeps — one consumer (the loop), one definition each.
  const sweepCalls = ['sweepAgentRunLiveness(', 'reconcileAgentRunsAgainstHost(', 'sweepStallWarn('];
  const allowedCallers = new Set([
    join(SRC, 'services', 'agent-run-reconciler.ts'),
    // definitions (the export function lines match the `name(` probe):
    join(SRC, 'services', 'agent-run-liveness-sweep.ts'),
    join(SRC, 'services', 'agent-host-reattach.ts'),
    join(SRC, 'services', 'agent-run-stall-warn.ts'),
  ]);
  for (const file of walkTsFiles(SRC)) {
    const content = readFileSync(file, 'utf8');
    for (const probe of sweepCalls) {
      if (content.includes(probe)) {
        assert.ok(
          allowedCallers.has(file),
          `${file} calls ${probe}) — only the one reconciler may drive the sweeps`,
        );
      }
    }
  }
});

// ── 2. HOLD (unreachable host ⇒ zero destructive input) ─────────────────────

interface CapturedReconcileArgs {
  hostAuthoritativelyAbsent?: boolean;
  missingFromHostTicks?: Map<string, number>;
  registerMissingHandles?: boolean;
}

function holdProbe(opts: { refreshThrows: boolean; connected: boolean }) {
  const captured: CapturedReconcileArgs[] = [];
  const host = {
    sendCommand: () => undefined,
    listRuns: () => [],
    refreshRuns: () =>
      opts.refreshThrows ? Promise.reject(new Error('host down')) : Promise.resolve([]),
    isConnected: () => opts.connected,
    onEvent: () => () => {},
  };
  const reconciler = createAgentRunReconciler({
    mode: 'host',
    host: host as never,
    activeRunRegistry: new ActiveRunRegistry(),
    log: () => {},
    warn: () => {},
    reconcileHost: ((deps: CapturedReconcileArgs) => {
      captured.push(deps);
      return {
        checked: 0,
        terminalApplied: 0,
        statusUpdated: 0,
        hostLost: 0,
        registered: 0,
        backfilledEvents: 0,
      };
    }) as never,
    stallWarn: (() => ({ checked: 0, warned: 0, cleared: 0 })) as never,
  });
  return { reconciler, captured };
}

test('HOLD: refreshRuns throws → tick withholds absence signal, counters, and registration', async () => {
  const { reconciler, captured } = holdProbe({ refreshThrows: true, connected: true });
  const res = await reconciler.tick();
  assert.equal(res.held, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].hostAuthoritativelyAbsent, false, 'no absence signal on a thrown refresh');
  assert.equal(captured[0].missingFromHostTicks, undefined, 'no counters on a thrown refresh');
  assert.equal(captured[0].registerMissingHandles, false, 'no registration against a stale cache');
});

test('HOLD: refresh ok but disconnected → same withholding (boot included)', async () => {
  const { reconciler, captured } = holdProbe({ refreshThrows: false, connected: false });
  const res = await reconciler.boot();
  assert.equal(res.held, true);
  assert.equal(captured[0].hostAuthoritativelyAbsent, false);
  assert.equal(captured[0].registerMissingHandles, false);
});

test('HOLD: reachable host → absence signal + counters + registration flow', async () => {
  const { reconciler, captured } = holdProbe({ refreshThrows: false, connected: true });
  const res = await reconciler.tick();
  assert.equal(res.held, false);
  assert.equal(captured[0].hostAuthoritativelyAbsent, true);
  assert.ok(captured[0].missingFromHostTicks instanceof Map);
  assert.equal(captured[0].registerMissingHandles, true);
});

test('HOLD: the missing-tick counter map persists across ticks (same identity)', async () => {
  const { reconciler, captured } = holdProbe({ refreshThrows: false, connected: true });
  await reconciler.tick();
  await reconciler.tick();
  assert.equal(captured.length, 2);
  assert.ok(captured[0].missingFromHostTicks === captured[1].missingFromHostTicks);
});

// ── 3. PAUSED-SURVIVES (FD-14 law, in-process sweep) ─────────────────────────

interface TerminalSpyCall {
  runId: string;
  failureCause: string | null | undefined;
}

function livenessDeps(rows: AgentRunRow[], opts: { registry?: ActiveRunRegistry } = {}) {
  const calls: TerminalSpyCall[] = [];
  const queuedOrphanTicks = new Map<string, number>();
  const deps = {
    activeRunRegistry: opts.registry ?? new ActiveRunRegistry(),
    listNonTerminalRuns: () => rows,
    isProcessAlive: () => false, // every pid reads dead — the maximal kill press
    killProcess: () => {},
    queuedOrphanTicks,
    applyTerminalEffects: ((input: { runId: string; failureCause?: string | null }) => {
      calls.push({ runId: input.runId, failureCause: input.failureCause });
      return { applied: 1 };
    }) as never,
  };
  return { deps, calls, queuedOrphanTicks };
}

test('PAUSED-SURVIVES: paused row with a dead pid is never finalized by the sweep', () => {
  const { deps, calls } = livenessDeps([
    row('run-paused-ask', { status: 'paused', pid: 4242 }),
    row('run-paused-stray', { status: 'paused', pid: 4243, lastActivityAt: 0 }),
  ]);
  const res = sweepAgentRunLiveness(deps);
  assert.equal(res.failedDead, 0);
  assert.equal(res.failedIdle, 0);
  assert.equal(calls.length, 0, 'no terminal path may touch a paused run');
});

test('PAUSED-SURVIVES: a running dead-pid row IS finalized (the law is paused-specific)', () => {
  const { deps, calls } = livenessDeps([row('run-dead', { status: 'running', pid: 4242 })]);
  const res = sweepAgentRunLiveness(deps);
  assert.equal(res.failedDead, 1);
  assert.equal(calls[0].failureCause, 'unexpected-exit');
});

// ── 4. Queued-orphan (replaces the deleted legacy bulk-fail) ─────────────────

test('queued row with no registry entry → server-restart after consecutive misses', () => {
  const rows = [row('run-orphan-q', { status: 'queued' })];
  const { deps, calls, queuedOrphanTicks } = livenessDeps(rows);

  const first = sweepAgentRunLiveness(deps);
  assert.equal(first.failedOrphanedQueued, 0, 'first miss only counts');
  assert.equal(queuedOrphanTicks.get('run-orphan-q'), 1);

  const second = sweepAgentRunLiveness(deps);
  assert.equal(second.failedOrphanedQueued, 1, 'second consecutive miss finalizes');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].failureCause, 'server-restart');
  assert.equal(queuedOrphanTicks.has('run-orphan-q'), false);
});

test('queued row WITH a registry entry is owned by admission — never orphan-failed', () => {
  const registry = new ActiveRunRegistry();
  const rows = [row('run-admitted-q', { status: 'queued' })];
  const { deps, calls, queuedOrphanTicks } = livenessDeps(rows, { registry });
  registry.register({
    run: {
      getRecord: () => ({ agentRunId: 'run-admitted-q' }),
      onTerminal: () => {},
    } as never,
    projectId: rows[0].projectId,
    dispatcherSessionId: rows[0].dispatcherSessionId,
    ccSessionId: rows[0].ccSessionId,
    podName: rows[0].podName,
    parentWorkItemId: null,
    podRevisionAtDispatch: null,
  });

  sweepAgentRunLiveness(deps);
  sweepAgentRunLiveness(deps);
  assert.equal(calls.length, 0);
  assert.equal(queuedOrphanTicks.has('run-admitted-q'), false, 'counter cleared while admitted');
});

test('no orphan counter wired → queued rows are never touched (conservatism)', () => {
  const rows = [row('run-q-noctr', { status: 'queued' })];
  const calls: TerminalSpyCall[] = [];
  const res = sweepAgentRunLiveness({
    listNonTerminalRuns: () => rows,
    isProcessAlive: () => false,
    killProcess: () => {},
    applyTerminalEffects: ((input: { runId: string }) => {
      calls.push({ runId: input.runId, failureCause: null });
      return { applied: 1 };
    }) as never,
  });
  assert.equal(res.failedOrphanedQueued, 0);
  assert.equal(calls.length, 0);
});
