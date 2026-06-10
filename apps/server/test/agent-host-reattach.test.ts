// Slice 009 OBJ-2A C-coherence — the reconcile sweep + applyAgentHostEvent
// run-state case must ALSO re-seed a registered HostBackedActiveRunHandle so
// its snapshot stops being a stale lie. Convenience only (no gate reads it),
// but it keeps display/getState() callers + the OBJ-2 markPaused path coherent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import type { AgentRunRow, ULID } from '@pc/domain';
import type {
  AgentHostCommand,
  AgentHostCommandResponse,
  AgentHostEvent,
  AgentHostRunSnapshot,
} from '@pc/runtime';

import {
  ActiveRunRegistry,
  HostBackedActiveRunHandle,
} from '../src/services/agent-active-runs.ts';
import {
  applyAgentHostEvent,
  reconcileAgentRunsAgainstHost,
  type AgentHostReattachClient,
} from '../src/services/agent-host-reattach.ts';

class FakeHostClient extends EventEmitter implements AgentHostReattachClient {
  commands: AgentHostCommand[] = [];
  constructor(private readonly runs: AgentHostRunSnapshot[]) {
    super();
  }
  listRuns(): readonly AgentHostRunSnapshot[] {
    return this.runs;
  }
  sendCommand(command: AgentHostCommand): AgentHostCommandResponse | void {
    this.commands.push(command);
  }
  onEvent(listener: (event: AgentHostEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }
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
    rev: 0,
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
    terminalAt: null,
    ...patch,
  };
}

function registerHostHandle(
  registry: ActiveRunRegistry,
  host: FakeHostClient,
  seed: AgentHostRunSnapshot,
): HostBackedActiveRunHandle {
  const handle = new HostBackedActiveRunHandle(seed, host);
  registry.register({
    run: handle,
    projectId: seed.projectId,
    dispatcherSessionId: seed.dispatcherSessionId,
    ccSessionId: seed.ccSessionId,
    podName: seed.podName,
    parentWorkItemId: null,
    podRevisionAtDispatch: null,
  });
  return handle;
}

test('reconcileAgentRunsAgainstHost re-seeds a registered host handle on a non-terminal sweep (C-coherence)', () => {
  let currentRow = row('run-coherence', { status: 'spawning' });
  const host = new FakeHostClient([hostRun('run-coherence', 'running')]);
  const registry = new ActiveRunRegistry();
  // Handle is stale at `spawning` (the live-bug state).
  const handle = registerHostHandle(
    registry,
    host,
    hostRun('run-coherence', 'spawning'),
  );
  assert.equal(handle.getState(), 'spawning');

  const res = reconcileAgentRunsAgainstHost({
    hostClient: host,
    activeRunRegistry: registry,
    listNonTerminalRuns: () => [currentRow],
    getAgentRun: () => currentRow,
    updateStatus: (input) => {
      currentRow = { ...currentRow, status: input.status };
    },
    // No-op announce: this is a pure unit test of handle re-seeding; the default
    // announce reads the row from the DB (selects contract_id post-slice-013),
    // which this test never migrates. Announce DB-writes are covered elsewhere.
    announce: () => {},
    broadcast: () => {},
  });

  assert.equal(res.statusUpdated, 1);
  // The handle snapshot is now coherent with the reconciled host state.
  assert.equal(handle.getState(), 'running');
});

test('applyAgentHostEvent run-state case re-seeds a registered host handle', () => {
  let currentRow = row('run-event-coherence', { status: 'spawning' });
  const host = new FakeHostClient([]);
  const registry = new ActiveRunRegistry();
  const handle = registerHostHandle(
    registry,
    host,
    hostRun('run-event-coherence', 'spawning'),
  );
  assert.equal(handle.getState(), 'spawning');

  const res = applyAgentHostEvent(
    { seq: 1, type: 'run-state', run: hostRun('run-event-coherence', 'running') },
    {
      activeRunRegistry: registry,
      getAgentRun: () => currentRow,
      updateStatus: (input) => {
        currentRow = { ...currentRow, status: input.status };
      },
      announce: () => {}, // no-op: pure unit test, avoid the default DB read
      broadcast: () => {},
    },
  );

  assert.equal(res.statusUpdated, 1);
  assert.equal(handle.getState(), 'running');
});

// ── T1.4 — host-lost finalize in the continuous reconcile ──────────────────
//
// The watchdog passes an authoritative-absence signal + a caller-owned
// consecutive-miss counter. A host-mode row missing from list-runs for
// >= hostLostAfterTicks ticks finalizes terminal `host-lost` via the injected
// terminal-effects seam. Below threshold / no signal → untouched (conservatism).

interface TerminalCall {
  runId: string;
  status: string;
  failureCause: string | null | undefined;
  failureReason: string | null | undefined;
}

/** Build a reconcile deps bag with an injected terminal-effects spy. */
function hostLostDeps(opts: {
  rows: AgentRunRow[];
  hostRuns?: AgentHostRunSnapshot[];
  missingTicks: Map<string, number>;
  hostAuthoritativelyAbsent: boolean;
  hostLostAfterTicks?: number;
  hasOpenAsk?: (runId: string) => boolean;
  calls: TerminalCall[];
}) {
  const host = new FakeHostClient(opts.hostRuns ?? []);
  return {
    deps: {
      hostClient: host,
      listNonTerminalRuns: () => opts.rows,
      missingFromHostTicks: opts.missingTicks,
      hostAuthoritativelyAbsent: opts.hostAuthoritativelyAbsent,
      ...(opts.hostLostAfterTicks !== undefined
        ? { hostLostAfterTicks: opts.hostLostAfterTicks }
        : {}),
      ...(opts.hasOpenAsk ? { hasOpenPendingAskForRun: (id: ULID) => opts.hasOpenAsk!(id) } : {}),
      applyTerminalEffects: ((input: {
        runId: string;
        status: string;
        failureCause?: string | null;
        failureReason?: string | null;
      }) => {
        opts.calls.push({
          runId: input.runId,
          status: input.status,
          failureCause: input.failureCause,
          failureReason: input.failureReason,
        });
        return { applied: 1 };
      }) as never,
    },
  };
}

test('T1.4 host absent, missing < threshold → NOT finalized; counter increments', () => {
  const calls: TerminalCall[] = [];
  const missingTicks = new Map<string, number>();
  const { deps } = hostLostDeps({
    rows: [row('run-lost', { status: 'running' })],
    hostRuns: [],
    missingTicks,
    hostAuthoritativelyAbsent: true,
    hostLostAfterTicks: 2,
    calls,
  });

  const res = reconcileAgentRunsAgainstHost(deps);
  assert.equal(res.hostLost, 0);
  assert.equal(calls.length, 0);
  assert.equal(missingTicks.get('run-lost'), 1);
});

test('T1.4 host absent, missing >= threshold → finalized failed/host-lost; counter cleared', () => {
  const calls: TerminalCall[] = [];
  const missingTicks = new Map<string, number>([['run-lost', 1]]);
  const { deps } = hostLostDeps({
    rows: [row('run-lost', { status: 'running' })],
    hostRuns: [],
    missingTicks,
    hostAuthoritativelyAbsent: true,
    hostLostAfterTicks: 2,
    calls,
  });

  const res = reconcileAgentRunsAgainstHost(deps);
  assert.equal(res.hostLost, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, 'failed');
  assert.equal(calls[0].failureCause, 'host-lost');
  assert.ok(calls[0].failureReason && calls[0].failureReason.length > 0);
  assert.equal(missingTicks.has('run-lost'), false);
});

test('T1.4 host CONNECTED but row not owned (missing from list-runs) → host-lost after threshold', () => {
  const calls: TerminalCall[] = [];
  // hostAuthoritativelyAbsent reflects "the run is absent from a successful
  // list-runs" — the watchdog sets it from connection + ownership. Other runs
  // present, this one not owned.
  const missingTicks = new Map<string, number>([['run-orphan', 1]]);
  const { deps } = hostLostDeps({
    rows: [row('run-orphan', { status: 'running' })],
    hostRuns: [hostRun('some-other-run', 'running')],
    missingTicks,
    hostAuthoritativelyAbsent: true,
    hostLostAfterTicks: 2,
    calls,
  });

  const res = reconcileAgentRunsAgainstHost(deps);
  assert.equal(res.hostLost, 1);
  assert.equal(calls[0].failureCause, 'host-lost');
});

test('T1.4 false-positive guard: no absence signal → no finalize, no increment', () => {
  const calls: TerminalCall[] = [];
  const missingTicks = new Map<string, number>([['run-lost', 1]]);
  const { deps } = hostLostDeps({
    rows: [row('run-lost', { status: 'running' })],
    hostRuns: [],
    missingTicks,
    hostAuthoritativelyAbsent: false, // refreshRuns threw / mid-respawn
    hostLostAfterTicks: 2,
    calls,
  });

  const res = reconcileAgentRunsAgainstHost(deps);
  assert.equal(res.hostLost, 0);
  assert.equal(calls.length, 0);
  // Counter untouched (still 1) — a withheld signal never advances it.
  assert.equal(missingTicks.get('run-lost'), 1);
});

test('T1.4 refreshRuns-threw shape (no counter + no absence) → no finalize, counter untouched', () => {
  // Mirrors the watchdog wiring: when refreshRuns() THROWS this tick, it passes
  // hostAuthoritativelyAbsent:false AND withholds the counter (undefined). The
  // reconcile must not finalize and must not mutate any standing counter.
  const calls: TerminalCall[] = [];
  const standing = new Map<string, number>([['run-lost', 1]]);
  const host = new FakeHostClient([]);
  const res = reconcileAgentRunsAgainstHost({
    hostClient: host,
    listNonTerminalRuns: () => [row('run-lost', { status: 'running' })],
    hostAuthoritativelyAbsent: false,
    missingFromHostTicks: undefined,
    hostLostAfterTicks: 2,
    applyTerminalEffects: ((input: { runId: string }) => {
      calls.push({ runId: input.runId, status: 'failed', failureCause: null, failureReason: null });
      return { applied: 1 };
    }) as never,
  });
  assert.equal(res.hostLost, 0);
  assert.equal(calls.length, 0);
  assert.equal(standing.get('run-lost'), 1); // never touched
});

test('T1.4 row reappears in list-runs before threshold → counter resets, no finalize', () => {
  const calls: TerminalCall[] = [];
  const missingTicks = new Map<string, number>([['run-back', 1]]);
  let currentRow = row('run-back', { status: 'running' });
  const { deps } = hostLostDeps({
    rows: [currentRow],
    hostRuns: [hostRun('run-back', 'running')], // host owns it again
    missingTicks,
    hostAuthoritativelyAbsent: true,
    hostLostAfterTicks: 2,
    calls,
  });
  // getAgentRun/updateStatus so the matched-row branch is happy.
  const res = reconcileAgentRunsAgainstHost({
    ...deps,
    getAgentRun: () => currentRow,
    updateStatus: (input) => {
      currentRow = { ...currentRow, status: input.status };
    },
    announce: () => {}, // no-op: pure unit test, avoid the default DB read
  });
  assert.equal(res.hostLost, 0);
  assert.equal(calls.length, 0);
  assert.equal(missingTicks.has('run-back'), false); // reset on reappearance
});

test('FD-14 LAW: paused row, host absent → NEVER host-lost, counter dropped', () => {
  const calls: TerminalCall[] = [];
  const missingTicks = new Map<string, number>([['run-paused', 50]]);
  const { deps } = hostLostDeps({
    rows: [row('run-paused', { status: 'paused' })],
    hostRuns: [],
    missingTicks,
    hostAuthoritativelyAbsent: true,
    hostLostAfterTicks: 2,
    hasOpenAsk: () => true,
    calls,
  });

  const res = reconcileAgentRunsAgainstHost(deps);
  assert.equal(res.hostLost, 0);
  assert.equal(calls.length, 0);
  // The reconciler can never finalize paused — its counter is dropped, so it
  // can never accrue toward finalize, no matter how many ticks pass.
  assert.equal(missingTicks.has('run-paused'), false);
});

test('FD-14 LAW: paused row WITHOUT an open ask is still never finalized', () => {
  // Pre-Step-2 the BOOT reconcile killed paused-without-ask rows. The law has
  // no exceptions: only the ask flow may end a paused run.
  const calls: TerminalCall[] = [];
  const missingTicks = new Map<string, number>([['run-paused-stray', 50]]);
  const { deps } = hostLostDeps({
    rows: [row('run-paused-stray', { status: 'paused' })],
    hostRuns: [],
    missingTicks,
    hostAuthoritativelyAbsent: true,
    hostLostAfterTicks: 2,
    hasOpenAsk: () => false,
    calls,
  });

  const res = reconcileAgentRunsAgainstHost(deps);
  assert.equal(res.hostLost, 0);
  assert.equal(calls.length, 0);
});

test('Step 2: spawning row absent below spawn threshold → counter stands, no finalize', () => {
  const calls: TerminalCall[] = [];
  // A slow-spawning run may legitimately not be in the host list yet — it gets
  // a LONGER threshold than running, not immunity.
  const missingTicks = new Map<string, number>([['run-spawning', 5]]);
  const { deps } = hostLostDeps({
    rows: [row('run-spawning', { status: 'spawning' })],
    hostRuns: [],
    missingTicks,
    hostAuthoritativelyAbsent: true,
    hostLostAfterTicks: 2,
    calls,
  });

  const res = reconcileAgentRunsAgainstHost({ ...deps, spawnLostAfterTicks: 8 });
  assert.equal(res.hostLost, 0);
  assert.equal(calls.length, 0);
  // Counter advances toward the spawn threshold (was 5, now 6) — pre-Step-2 it
  // was dropped every tick, so a lost spawning row stuck forever.
  assert.equal(missingTicks.get('run-spawning'), 6);
});

test('Step 2: spawning row the host never reports → host-lost at spawn threshold (stuck-forever gap closed)', () => {
  const calls: TerminalCall[] = [];
  const missingTicks = new Map<string, number>([['run-spawning', 7]]);
  const { deps } = hostLostDeps({
    rows: [row('run-spawning', { status: 'spawning' })],
    hostRuns: [],
    missingTicks,
    hostAuthoritativelyAbsent: true,
    hostLostAfterTicks: 2,
    calls,
  });

  const res = reconcileAgentRunsAgainstHost({ ...deps, spawnLostAfterTicks: 8 });
  assert.equal(res.hostLost, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, 'failed');
  assert.equal(calls[0].failureCause, 'host-lost');
  assert.equal(missingTicks.has('run-spawning'), false);
});

test('Step 2: queued row missing from a reachable host → same spawn-threshold path', () => {
  const calls: TerminalCall[] = [];
  const missingTicks = new Map<string, number>([['run-queued', 7]]);
  const { deps } = hostLostDeps({
    rows: [row('run-queued', { status: 'queued' })],
    hostRuns: [],
    missingTicks,
    hostAuthoritativelyAbsent: true,
    hostLostAfterTicks: 2,
    calls,
  });

  const res = reconcileAgentRunsAgainstHost({ ...deps, spawnLostAfterTicks: 8 });
  assert.equal(res.hostLost, 1);
  assert.equal(calls[0].failureCause, 'host-lost');
});

test('Step 2: self-healing reattach — matched host run with no registry entry gets registered on a tick', () => {
  let currentRow = row('run-selfheal', { status: 'running' });
  const host = new FakeHostClient([hostRun('run-selfheal', 'running')]);
  const registry = new ActiveRunRegistry();
  assert.ok(!registry.get('run-selfheal' as ULID), 'starts unregistered');

  const res = reconcileAgentRunsAgainstHost({
    hostClient: host,
    activeRunRegistry: registry,
    registerMissingHandles: true,
    listNonTerminalRuns: () => [currentRow],
    getAgentRun: () => currentRow,
    updateStatus: (input) => {
      currentRow = { ...currentRow, status: input.status };
    },
    announce: () => {},
    broadcast: () => {},
  });

  assert.equal(res.registered, 1, 'tick registers the missing handle');
  const entry = registry.get('run-selfheal' as ULID);
  assert.ok(entry, 'handle is registered');
  assert.ok(entry!.run instanceof HostBackedActiveRunHandle);

  // Second tick: already registered → no double-register.
  const res2 = reconcileAgentRunsAgainstHost({
    hostClient: host,
    activeRunRegistry: registry,
    registerMissingHandles: true,
    listNonTerminalRuns: () => [currentRow],
    getAgentRun: () => currentRow,
    updateStatus: () => {},
    announce: () => {},
    broadcast: () => {},
  });
  assert.equal(res2.registered, 0, 'no double-register on the next tick');
});

// Ghost reaper (2026-06-10) — a NON-terminal host run whose DB row is already
// terminal (the timed-out-start-receipt dispatch marked it failed while the
// host had actually started it) must be cancelled once the row has been
// terminal past the grace window. Nothing else converges it: the row loop only
// iterates non-terminal DB rows.
test('ghost reaper: live host run with a terminal DB row past grace gets a cancel', () => {
  const host = new FakeHostClient([hostRun('run-ghost', 'running')]);
  const terminalRow = row('run-ghost', {
    status: 'failed',
    failureCause: 'host-unavailable',
    completedAt: 1_700_000_000_000,
  });

  const res = reconcileAgentRunsAgainstHost({
    hostClient: host,
    listNonTerminalRuns: () => [],
    getAgentRun: (id) => (id === ('run-ghost' as ULID) ? terminalRow : null),
    hostAuthoritativelyAbsent: true,
    now: () => 1_700_000_000_000 + 60_000, // past the 30s grace
    announce: () => {},
    broadcast: () => {},
  });

  assert.equal(res.ghostCancelled, 1, 'ghost counted');
  assert.deepEqual(host.commands, [{ type: 'cancel', runId: 'run-ghost' }]);
});

test('ghost reaper holds inside the grace window and on an unconfirmed host list', () => {
  const terminalRow = row('run-ghost2', {
    status: 'failed',
    failureCause: 'host-unavailable',
    completedAt: 1_700_000_000_000,
  });

  // Inside the grace window → no cancel (never race in-flight terminal effects).
  const hostA = new FakeHostClient([hostRun('run-ghost2', 'running')]);
  const inGrace = reconcileAgentRunsAgainstHost({
    hostClient: hostA,
    listNonTerminalRuns: () => [],
    getAgentRun: () => terminalRow,
    hostAuthoritativelyAbsent: true,
    now: () => 1_700_000_000_000 + 10_000,
    announce: () => {},
    broadcast: () => {},
  });
  assert.equal(inGrace.ghostCancelled, 0);
  assert.deepEqual(hostA.commands, []);

  // Stale/unconfirmed host list → no cancel (HOLD on no-information).
  const hostB = new FakeHostClient([hostRun('run-ghost2', 'running')]);
  const unconfirmed = reconcileAgentRunsAgainstHost({
    hostClient: hostB,
    listNonTerminalRuns: () => [],
    getAgentRun: () => terminalRow,
    hostAuthoritativelyAbsent: false,
    now: () => 1_700_000_000_000 + 60_000,
    announce: () => {},
    broadcast: () => {},
  });
  assert.equal(unconfirmed.ghostCancelled, 0);
  assert.deepEqual(hostB.commands, []);
});

test('ghost reaper never touches a live host run whose row is non-terminal', () => {
  const liveRow = row('run-live', { status: 'running' });
  const host = new FakeHostClient([hostRun('run-live', 'running')]);
  const res = reconcileAgentRunsAgainstHost({
    hostClient: host,
    listNonTerminalRuns: () => [liveRow],
    getAgentRun: () => liveRow,
    // This test's row IS matched + running on the host, so the main loop reaches
    // shouldUpdateFromHost → the status-update path. Stub updateStatus (and
    // announce) so it never falls through to the default DB writer — otherwise
    // it depends on a shared, test-order-dependent DB singleton and fails on CI
    // with "no such table: agent_runs" (pc-pty-chat-398).
    updateStatus: () => {},
    hostAuthoritativelyAbsent: true,
    now: () => 1_700_000_000_000 + 600_000,
    announce: () => {},
    broadcast: () => {},
  });
  assert.equal(res.ghostCancelled, 0);
  assert.deepEqual(host.commands, []);
});
