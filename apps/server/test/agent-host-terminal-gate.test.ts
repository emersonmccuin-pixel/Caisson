import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ULID } from '@pc/domain';
import type { EnqueueMailboxMessageInput } from '@pc/db';
import type { AgentHostRunSnapshot } from '@pc/runtime';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-host-terminal-gate-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createOrchestratorSession,
  createProject,
  getAgentRunRow,
  insertAgentRunRow,
  newId,
  runMigrations,
} = await import('@pc/db');
const { ContractService } = await import('@pc/app-services');
const { applyHostTerminalSnapshot, reconcileAgentRunsAgainstHost } = await import(
  '../src/services/agent-host-reattach.ts'
);
const { applyAgentRunTerminalEffects, replayMissingTerminalEnvelopes } = await import(
  '../src/services/agent-run-terminal-effects.ts'
);
const { createAgentRunReconciler } = await import('../src/services/agent-run-reconciler.ts');
const { ActiveRunRegistry } = await import('../src/services/agent-active-runs.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

function fakeMailbox() {
  const calls: EnqueueMailboxMessageInput[] = [];
  return { port: (input: EnqueueMailboxMessageInput) => (calls.push(input), {}), calls };
}

function terminalSnapshot(runId: ULID, projectId: ULID): AgentHostRunSnapshot {
  const t = Date.now();
  return {
    runId,
    projectId,
    dispatcherSessionId: lastDispatcherId,
    ccSessionId: 'cc-1',
    podName: 'builder',
    worktreeDir: join(tmpDir, 'wt'),
    state: 'completed',
    jsonlPath: null,
    transcriptPath: null,
    queuedAt: t,
    spawnedAt: t,
    readyAt: t,
    updatedAt: t,
    terminalAt: t,
    terminalResult: { status: 'completed', result: 'done', failureCause: null, failureReason: null },
  };
}

// M4a — deliverAgentEnvelope is dispatcher-aware: a terminal envelope for a
// dispatcher id with NO orchestrator_sessions row is deliberately skipped.
// These tests assert routing, so the seed mints a REAL session per project
// (tests run sequentially; the snapshot helper reads the latest).
let lastDispatcherId = 'disp-1';

function seedRun(slug: string): { runId: ULID; projectId: ULID } {
  const project = createProject({
    slug,
    name: slug,
    stages,
    folderPath: join(tmpDir, slug),
  });
  const session = createOrchestratorSession({
    projectId: project.id,
    providerSessionId: `cc-${slug}`,
  });
  lastDispatcherId = session.id;
  const runId = newId();
  insertAgentRunRow({
    id: runId,
    projectId: project.id,
    podName: 'builder',
    dispatcherSessionId: session.id,
    ccSessionId: 'cc-1',
    status: 'running',
    input: 'go',
    queuedAt: Date.now(),
  });
  return { runId, projectId: project.id };
}

// 017 Phase C — a host-backed agent that completes delivers its terminal
// envelope to the mailbox (the sole door). These guard that the host terminal
// call sites (factory snapshot, boot-reattach, reconcile-sweep, liveness sweep)
// all thread the mailbox port through to applyAgentRunTerminalEffects.
test('host terminal enqueues via the mailbox port', async () => {
  const { runId } = seedRun(`htg-mbox-${Date.now()}`);
  const mb = fakeMailbox();

  const applied = applyHostTerminalSnapshot(terminalSnapshot(runId, getAgentRunRow(runId)!.projectId), {
    mailboxEnqueue: mb.port,
    broadcast: () => {},
    terminalCleanup: () => {},
  });
  assert.equal(applied, 1);

  // the terminal envelope is emitted from the async finishTerminalEffects tail
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(mb.calls.length, 1, 'host completion must enqueue the mailbox orchestrator-turn');
  const enq = mb.calls[0]!;
  assert.equal(enq.message.kind, 'agent-terminal');
  assert.equal(enq.recipients[0]!.channel, 'orchestrator-turn');
  assert.equal(getAgentRunRow(runId)!.status, 'completed');
});

function runningSnapshot(runId: ULID, projectId: ULID): AgentHostRunSnapshot {
  return { ...terminalSnapshot(runId, projectId), state: 'running', terminalAt: null, terminalResult: undefined };
}

/** Fake host port. The reconciler's boot tick registers a live handle for a
 *  non-terminal snapshot and subscribes the ONE event stream; emitting a
 *  run-terminal then drives the threaded terminal-effects deps. */
function fakeHostClient(snapshot: AgentHostRunSnapshot) {
  let listener: ((event: unknown) => void) | null = null;
  return {
    client: {
      sendCommand: () => undefined,
      listRuns: () => [snapshot],
      refreshRuns: () => Promise.resolve([snapshot]),
      isConnected: () => true,
      onEvent: (l: (event: unknown) => void) => {
        listener = l;
        return () => {};
      },
    },
    emitTerminal: (terminal: AgentHostRunSnapshot) =>
      listener?.({ seq: 1, type: 'run-terminal', run: terminal }),
  };
}

test('reconciler boot: a host terminal event routes ONE mailbox turn', async () => {
  const { runId, projectId } = seedRun(`htg-boot-mbox-${Date.now()}`);
  const mb = fakeMailbox();
  const host = fakeHostClient(runningSnapshot(runId, projectId));

  const reconciler = createAgentRunReconciler({
    host: host.client as never,
    activeRunRegistry: new ActiveRunRegistry(),
    mailboxEnqueue: mb.port,
    broadcast: () => {},
    log: () => {},
    warn: () => {},
    // Fake mailbox port doesn't persist; the S3 replay would re-emit envelopes
    // for OTHER tests' terminal rows in the shared DB. Own test covers replay.
    replayEnvelopes: () => Promise.resolve({ scanned: 0, replayed: 0 }),
  });
  const res = await reconciler.boot();
  assert.equal(res.held, false);
  assert.equal(res.hostReconcile!.registered, 1, 'boot tick registers the live host handle');

  host.emitTerminal(terminalSnapshot(runId, projectId));
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(mb.calls.length, 1, 'boot terminal event must enqueue ONE mailbox turn');
  assert.equal(getAgentRunRow(runId)!.status, 'completed');
});

test('reconcile-sweep: a host terminal enqueues ONE mailbox turn', async () => {
  const { runId, projectId } = seedRun(`htg-recon-mbox-${Date.now()}`);
  const mb = fakeMailbox();
  const snap = terminalSnapshot(runId, projectId);

  const res = reconcileAgentRunsAgainstHost({
    hostClient: { sendCommand: () => undefined, listRuns: () => [snap] } as never,
    mailboxEnqueue: mb.port,
    broadcast: () => {},
    terminalCleanup: () => {},
    // The fake mailbox port never persists a row, so the S3 envelope-replay's
    // idempotency probe can't see this just-emitted envelope and would re-emit
    // it. Stub it off — replay is covered by its own test.
    replayEnvelopes: () => Promise.resolve({ scanned: 0, replayed: 0 }),
  });
  assert.equal(res.terminalApplied, 1);
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(mb.calls.length, 1, 'reconcile-sweep terminal must enqueue ONE mailbox turn');
});

// (☠ P9: the in-process liveness sweep + its mailbox-routing test are deleted —
// host-mode terminal routing is covered by the reconcile-sweep test above.)

// One-terminal-authority guard (the link-2 race fix). The dispatch's `done`
// promise resolves through a run-keyed settlement waiter on the ActiveRunRegistry
// — NOT a per-call onSettled callback — so done-resolution is immune to WHICH
// terminal-apply path wins the host-event race. This proves:
//  (1) the waiter fires when the terminal is applied (running → completed),
//  (2) a SECOND apply of the same terminal (the rival listener / reconcile sweep
//      re-deriving an already-terminal row) STILL settles the waiter — and fires
//      it EXACTLY ONCE.
test('settlement waiter resolves by run id and fires exactly once across a double-apply', async () => {
  const { runId, projectId } = seedRun(`htg-settle-once-${Date.now()}`);
  const registry = new ActiveRunRegistry();

  const settlements: Array<{ status: string }> = [];
  registry.onSettled(runId, (s) => settlements.push({ status: s.status }));

  // First apply — the "winning" listener finalizes the row AND settles.
  const applied1 = applyHostTerminalSnapshot(terminalSnapshot(runId, projectId), {
    activeRunRegistry: registry,
    broadcast: () => {},
    terminalCleanup: () => {},
  });
  assert.equal(applied1, 1, 'first apply finalizes the row');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(getAgentRunRow(runId)!.status, 'completed');
  assert.equal(settlements.length, 1, 'waiter fired on the winning apply');
  assert.equal(settlements[0]!.status, 'completed');

  // Second apply — the row is ALREADY terminal (the rival path). It must NOT
  // re-apply effects (returns 0) but must NOT re-fire the waiter either: the
  // waiter was already consumed and is idempotent.
  const applied2 = applyHostTerminalSnapshot(terminalSnapshot(runId, projectId), {
    activeRunRegistry: registry,
    broadcast: () => {},
    terminalCleanup: () => {},
  });
  assert.equal(applied2, 0, 'second apply is a no-op on the already-terminal row');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(settlements.length, 1, 'waiter fires EXACTLY once across a double-apply');
});

// The losing-race ordering: the row is finalized FIRST (rival listener, no
// waiter), THEN the awaiting dispatch's waiter is registered + its path applies
// the (already-terminal) snapshot. The already-terminal authority must still
// settle the waiter from the durable row, or the workflow `done` hangs forever —
// the exact link-2 stall.
test('a waiter registered after the row is already terminal still settles', async () => {
  const { runId, projectId } = seedRun(`htg-settle-late-${Date.now()}`);
  const registry = new ActiveRunRegistry();

  // Rival path wins: finalize the row with NO waiter registered.
  const applied1 = applyHostTerminalSnapshot(terminalSnapshot(runId, projectId), {
    activeRunRegistry: registry,
    broadcast: () => {},
    terminalCleanup: () => {},
  });
  assert.equal(applied1, 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(getAgentRunRow(runId)!.status, 'completed');

  // Now the awaiting dispatch registers its waiter + re-applies the terminal.
  const settlements: Array<{ status: string }> = [];
  registry.onSettled(runId, (s) => settlements.push({ status: s.status }));
  const applied2 = applyHostTerminalSnapshot(terminalSnapshot(runId, projectId), {
    activeRunRegistry: registry,
    broadcast: () => {},
    terminalCleanup: () => {},
  });
  assert.equal(applied2, 0, 'already-terminal: no re-apply');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(settlements.length, 1, 'already-terminal path settles the late waiter from the durable row');
  assert.equal(settlements[0]!.status, 'completed');
});

// Slice 020 — the agent reports its deliverable via pc_submit_deliverable (the
// free-text result is empty). The completion envelope surfaces the SUBMITTED
// deliverable text (sourced from the contract, not borrowed from wi.body)
// instead of "(no output)" so the orchestrator has something to relay.
test('completed contract dispatch with empty result surfaces the submitted deliverable, not (no output)', async () => {
  const project = createProject({
    slug: `htg-deliverable-${Date.now()}`,
    name: 'deliverable',
    stages,
    folderPath: join(tmpDir, `htg-deliverable-${Date.now()}`),
  });
  const contract = new ContractService().create({
    projectId: project.id,
    workItemId: null,
    podName: 'haiku',
  });
  // Agent submitted its deliverable onto the contract.
  new ContractService().setDeliverable({
    id: contract.id as ULID,
    deliverable: { kind: 'answer', text: 'DONE' },
    report: null,
  });
  // M4a — the dispatcher must be a REAL orchestrator session or the terminal
  // envelope is (correctly) skipped.
  const session = createOrchestratorSession({
    projectId: project.id,
    providerSessionId: 'cc-deliverable',
  });
  const runId = newId();
  insertAgentRunRow({
    id: runId,
    projectId: project.id,
    podName: 'haiku',
    dispatcherSessionId: session.id,
    ccSessionId: 'cc-1',
    status: 'running',
    input: 'Begin.',
    contractId: contract.id as ULID,
    queuedAt: Date.now(),
  });
  const mb = fakeMailbox();

  applyAgentRunTerminalEffects(
    {
      runId,
      ccSessionId: 'cc-1',
      podName: 'haiku',
      projectId: project.id,
      dispatcherSessionId: session.id,
      parentWorkItemId: null,
      worktreeDir: join(tmpDir, 'wt'),
      status: 'completed',
      result: '', // agent submitted via pc_submit_deliverable; no trailing text
      contractId: contract.id as ULID,
    },
    {
      mailboxEnqueue: mb.port,
      verifyOnTerminal: (async () => ({
        contractId: contract.id as ULID,
        workItemId: null,
        verificationStatus: 'passed',
        verificationTier: 'auto',
        notes: null,
      })) as never,
      broadcast: () => {},
    },
  );
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(mb.calls.length, 1, 'completion enqueues a mailbox turn');
  const body = (mb.calls[0]!.message as { body: string }).body;
  assert.ok(body.includes('DONE'), 'surfaces the submitted deliverable');
  assert.ok(!body.includes('(no output)'), 'must not read (no output) when a deliverable exists');
});

// Issue 3 (near-term) — onMailboxEnqueued callback is fired after the terminal
// envelope is enqueued so the caller can drain the worker immediately.
test('Issue 3: terminal envelope triggers onMailboxEnqueued immediately after enqueue', async () => {
  const { runId, projectId } = seedRun(`htg-drain-signal-${Date.now()}`);
  const mb = fakeMailbox();
  const drainCalls: number[] = [];

  applyAgentRunTerminalEffects(
    {
      runId,
      ccSessionId: 'cc-1',
      podName: 'builder',
      projectId,
      dispatcherSessionId: lastDispatcherId,
      parentWorkItemId: null,
      worktreeDir: join(tmpDir, 'wt'),
      status: 'completed',
      result: 'done',
    },
    {
      mailboxEnqueue: mb.port,
      broadcast: () => {},
      onMailboxEnqueued: () => drainCalls.push(Date.now()),
    },
  );
  // Wait for the async finishTerminalEffects tail.
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(mb.calls.length, 1, 'terminal envelope was enqueued');
  assert.equal(drainCalls.length, 1, 'onMailboxEnqueued fired exactly once');
});

test('Issue 3: onMailboxEnqueued is threaded through applyHostTerminalSnapshot', async () => {
  const { runId, projectId } = seedRun(`htg-drain-thread-${Date.now()}`);
  const mb = fakeMailbox();
  const drainCalls: number[] = [];

  applyHostTerminalSnapshot(terminalSnapshot(runId, projectId), {
    mailboxEnqueue: mb.port,
    broadcast: () => {},
    terminalCleanup: () => {},
    onMailboxEnqueued: () => drainCalls.push(Date.now()),
  });
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(mb.calls.length, 1, 'terminal envelope was enqueued');
  assert.equal(drainCalls.length, 1, 'onMailboxEnqueued reached through applyHostTerminalSnapshot');
});

// S3 — a terminal run whose notify tail threw (no orchestrator envelope ever
// enqueued) is recovered by the replay pass: exactly ONE envelope, and a second
// pass is a no-op once the idempotency key exists.
test('S3 replay re-emits a missing terminal envelope exactly once', async () => {
  const { runId, projectId } = seedRun(`htg-replay-${Date.now()}`);
  void projectId;
  // Simulate "tail threw": flip the row terminal directly, never enqueue.
  applyAgentRunTerminalEffects(
    {
      runId,
      ccSessionId: 'cc-1',
      podName: 'builder',
      projectId,
      dispatcherSessionId: 'disp-1',
      parentWorkItemId: null,
      worktreeDir: join(tmpDir, 'wt'),
      status: 'completed',
      result: 'done',
    },
    { broadcast: () => {} }, // NO mailboxEnqueue → no envelope ever written
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(getAgentRunRow(runId)!.status, 'completed');

  const seen = new Set<string>();
  const port = (input: EnqueueMailboxMessageInput) => {
    seen.add(input.message.idempotencyKey);
    return {};
  };
  // Scope the scan to THIS run only (the shared test DB carries other tests'
  // terminal rows). hasMailboxKey reflects the (now real-ish) enqueue ledger.
  const onlyThisRun = () => [getAgentRunRow(runId)!];

  // First pass: the key is absent → emit once.
  const r1 = await replayMissingTerminalEnvelopes({
    mailboxEnqueue: port,
    listRecentTerminalRuns: onlyThisRun,
    hasMailboxKey: (key) => seen.has(key),
  });
  assert.equal(r1.replayed, 1, 'first replay emits the missing envelope');
  assert.ok(seen.has(`agent:${runId}:agent-completed`));

  // Second pass: the key now exists → no-op (exactly-once).
  const r2 = await replayMissingTerminalEnvelopes({
    mailboxEnqueue: port,
    listRecentTerminalRuns: onlyThisRun,
    hasMailboxKey: (key) => seen.has(key),
  });
  assert.equal(r2.replayed, 0, 'second replay is a no-op once the key exists');
});
