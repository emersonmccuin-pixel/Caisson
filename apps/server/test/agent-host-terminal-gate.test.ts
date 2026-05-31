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

const { closeDb, createProject, getAgentRunRow, insertAgentRunRow, newId, runMigrations } =
  await import('@pc/db');
const { applyHostTerminalSnapshot, reconcileAgentRunsAgainstHost } = await import(
  '../src/services/agent-host-reattach.ts'
);
const { reattachAgentRunsDuringServerBoot } = await import(
  '../src/services/agent-run-server-boot.ts'
);
const { sweepAgentRunLiveness } = await import('../src/services/agent-run-liveness-sweep.ts');
const { ActiveRunRegistry } = await import('../src/services/agent-active-runs.ts');
const { fixedDeliveryRouter } = await import('../src/services/delivery-routing.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

function fakeChannelServer() {
  const emits: { recipientSessionId: string; body: string }[] = [];
  return {
    cs: {
      emitToSession(input: { recipientSessionId: string; body: string }) {
        emits.push({ recipientSessionId: input.recipientSessionId, body: input.body });
        return true;
      },
    },
    emits,
  };
}

function fakeMailbox() {
  const calls: EnqueueMailboxMessageInput[] = [];
  return { port: (input: EnqueueMailboxMessageInput) => (calls.push(input), {}), calls };
}

function terminalSnapshot(runId: ULID, projectId: ULID): AgentHostRunSnapshot {
  const t = Date.now();
  return {
    runId,
    projectId,
    dispatcherSessionId: 'disp-1',
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

function seedRun(slug: string): { runId: ULID; projectId: ULID } {
  const project = createProject({
    slug,
    name: slug,
    stages,
    folderPath: join(tmpDir, slug),
  });
  const runId = newId();
  insertAgentRunRow({
    id: runId,
    projectId: project.id,
    podName: 'builder',
    dispatcherSessionId: 'disp-1',
    ccSessionId: 'cc-1',
    status: 'running',
    input: 'go',
    queuedAt: Date.now(),
  });
  return { runId, projectId: project.id };
}

// REGRESSION (slice-008 host-cutover hole): a host-backed agent that completes
// must honor the agent delivery gate. Before the fix, the factory/reattach host
// path called applyHostTerminalSnapshot WITHOUT threading deliveryRouter +
// mailboxEnqueue, so even under gate=mailbox the terminal envelope silently fell
// back to Channel.
test('host terminal under gate=mailbox enqueues via the mailbox port; NO channel push', async () => {
  const { runId } = seedRun(`htg-mbox-${Date.now()}`);
  const { cs, emits } = fakeChannelServer();
  const mb = fakeMailbox();

  const applied = applyHostTerminalSnapshot(terminalSnapshot(runId, getAgentRunRow(runId)!.projectId), {
    channelServer: cs as never,
    deliveryRouter: fixedDeliveryRouter({ agent: 'mailbox' }),
    mailboxEnqueue: mb.port,
    broadcast: () => {},
    terminalCleanup: () => {},
  });
  assert.equal(applied, 1);

  // the terminal envelope is emitted from the async finishTerminalEffects tail
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(mb.calls.length, 1, 'host completion must enqueue the mailbox orchestrator-turn');
  assert.equal(emits.length, 0, 'gate=mailbox must NOT push to Channel');
  const enq = mb.calls[0]!;
  assert.equal(enq.message.kind, 'agent-terminal');
  assert.equal(enq.recipients[0]!.channel, 'orchestrator-turn');
  assert.equal(getAgentRunRow(runId)!.status, 'completed');
});

function runningSnapshot(runId: ULID, projectId: ULID): AgentHostRunSnapshot {
  return { ...terminalSnapshot(runId, projectId), state: 'running', terminalAt: null, terminalResult: undefined };
}

/** Fake host client. Boot reattach registers a live handle for a non-terminal
 *  snapshot and subscribes via onEvent; emitting a run-terminal then drives the
 *  threaded terminal-effects deps (the OBJ-1 wiring under test). */
function fakeHostClient(snapshot: AgentHostRunSnapshot) {
  let listener: ((event: unknown) => void) | null = null;
  return {
    client: {
      sendCommand: () => undefined,
      listRuns: () => [snapshot],
      onEvent: (l: (event: unknown) => void) => {
        listener = l;
        return () => {};
      },
    },
    emitTerminal: (terminal: AgentHostRunSnapshot) =>
      listener?.({ seq: 1, type: 'run-terminal', run: terminal }),
  };
}

// SLICE-009 OBJ-1 — the BOOT-WIRED host terminal handlers must also carry the
// agent gate + mailbox port. Before slice 009 these three call sites omitted the
// port and so silently fell back to Channel, winning the idempotency race
// against the factory's gated live handler. Boot-reattach registers a live
// handle and routes terminals arriving on the host event stream; that path must
// carry the threaded port.

test('boot-reattach: gate=mailbox + port wired routes a host terminal event to mailbox; NO channel push', async () => {
  const { runId, projectId } = seedRun(`htg-boot-mbox-${Date.now()}`);
  const { cs, emits } = fakeChannelServer();
  const mb = fakeMailbox();
  const host = fakeHostClient(runningSnapshot(runId, projectId));

  const result = await reattachAgentRunsDuringServerBoot({
    getHostClient: () => host.client as never,
    activeRunRegistry: new ActiveRunRegistry(),
    channelServer: cs as never,
    deliveryRouter: fixedDeliveryRouter({ agent: 'mailbox' }),
    mailboxEnqueue: mb.port,
    broadcast: () => {},
    terminalCleanup: () => {},
  });
  assert.equal(result.mode, 'host');

  host.emitTerminal(terminalSnapshot(runId, projectId));
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(mb.calls.length, 1, 'boot-reattach terminal event must enqueue ONE mailbox turn');
  assert.equal(emits.length, 0, 'gate=mailbox boot-reattach must NOT push to Channel');
  assert.equal(getAgentRunRow(runId)!.status, 'completed');
});

test('boot-reattach: port OMITTED falls back to Channel (documents bug-before-fix)', async () => {
  const { runId, projectId } = seedRun(`htg-boot-noport-${Date.now()}`);
  const { cs, emits } = fakeChannelServer();
  const mb = fakeMailbox();
  const host = fakeHostClient(runningSnapshot(runId, projectId));

  await reattachAgentRunsDuringServerBoot({
    getHostClient: () => host.client as never,
    activeRunRegistry: new ActiveRunRegistry(),
    channelServer: cs as never,
    deliveryRouter: fixedDeliveryRouter({ agent: 'mailbox' }),
    // mailboxEnqueue omitted — the pre-009 boot call shape.
    broadcast: () => {},
    terminalCleanup: () => {},
  });

  host.emitTerminal(terminalSnapshot(runId, projectId));
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(mb.calls.length, 0, 'no port => no mailbox enqueue');
  assert.equal(emits.length, 1, 'no port => Channel fallback (the slice-008 hole)');
});

test('reconcile-sweep: gate=mailbox + port wired enqueues ONE mailbox turn; NO channel push', async () => {
  const { runId, projectId } = seedRun(`htg-recon-mbox-${Date.now()}`);
  const { cs, emits } = fakeChannelServer();
  const mb = fakeMailbox();
  const snap = terminalSnapshot(runId, projectId);

  const res = reconcileAgentRunsAgainstHost({
    hostClient: { sendCommand: () => undefined, listRuns: () => [snap] } as never,
    channelServer: cs as never,
    deliveryRouter: fixedDeliveryRouter({ agent: 'mailbox' }),
    mailboxEnqueue: mb.port,
    broadcast: () => {},
    terminalCleanup: () => {},
  });
  assert.equal(res.terminalApplied, 1);
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(mb.calls.length, 1, 'reconcile-sweep terminal must enqueue ONE mailbox turn');
  assert.equal(emits.length, 0, 'gate=mailbox reconcile-sweep must NOT push to Channel');
});

test('reconcile-sweep: port OMITTED falls back to Channel (documents bug-before-fix)', async () => {
  const { runId, projectId } = seedRun(`htg-recon-noport-${Date.now()}`);
  const { cs, emits } = fakeChannelServer();
  const mb = fakeMailbox();
  const snap = terminalSnapshot(runId, projectId);

  reconcileAgentRunsAgainstHost({
    hostClient: { sendCommand: () => undefined, listRuns: () => [snap] } as never,
    channelServer: cs as never,
    deliveryRouter: fixedDeliveryRouter({ agent: 'mailbox' }),
    // mailboxEnqueue omitted.
    broadcast: () => {},
    terminalCleanup: () => {},
  });
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(mb.calls.length, 0, 'no port => no mailbox enqueue');
  assert.equal(emits.length, 1, 'no port => Channel fallback');
});

// SLICE-009 OBJ-1 — the liveness sweep's `finalize` must forward
// deliveryRouter/mailboxEnqueue into applyAgentRunTerminalEffects. A swept
// idle/dead run under gate=mailbox routes through the mailbox port.
test('liveness-sweep finalize: gate=mailbox + port wired routes a swept failure to mailbox', async () => {
  const { runId, projectId } = seedRun(`htg-live-mbox-${Date.now()}`);
  void projectId;
  const { cs, emits } = fakeChannelServer();
  const mb = fakeMailbox();
  const row = getAgentRunRow(runId)!;

  const res = sweepAgentRunLiveness({
    channelServer: cs as never,
    deliveryRouter: fixedDeliveryRouter({ agent: 'mailbox' }),
    mailboxEnqueue: mb.port,
    broadcast: () => {},
    listNonTerminalRuns: () => [{ ...row, pid: 4242 }],
    hasOpenPendingAskForRun: () => false,
    // Process is gone => unexpected-exit, finalize immediately.
    isProcessAlive: () => false,
    killProcess: () => {},
  });
  assert.equal(res.failedDead, 1);
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(mb.calls.length, 1, 'swept failure under gate=mailbox enqueues a mailbox turn');
  assert.equal(emits.length, 0, 'gate=mailbox swept failure must NOT push to Channel');
});

test('liveness-sweep finalize: port OMITTED falls back to Channel (documents bug-before-fix)', async () => {
  const { runId } = seedRun(`htg-live-noport-${Date.now()}`);
  const { cs, emits } = fakeChannelServer();
  const mb = fakeMailbox();
  const row = getAgentRunRow(runId)!;

  sweepAgentRunLiveness({
    channelServer: cs as never,
    deliveryRouter: fixedDeliveryRouter({ agent: 'mailbox' }),
    // mailboxEnqueue omitted.
    broadcast: () => {},
    listNonTerminalRuns: () => [{ ...row, pid: 4242 }],
    hasOpenPendingAskForRun: () => false,
    isProcessAlive: () => false,
    killProcess: () => {},
  });
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(mb.calls.length, 0, 'no port => no mailbox enqueue');
  assert.equal(emits.length, 1, 'no port => Channel fallback');
});

test('host terminal under gate=channel rides Channel; NO mailbox enqueue', async () => {
  const prior = process.env.PC_DELIVERY_TRANSPORT;
  process.env.PC_DELIVERY_TRANSPORT = 'channel-only';
  const { runId } = seedRun(`htg-chan-${Date.now()}`);
  const { cs, emits } = fakeChannelServer();
  const mb = fakeMailbox();

  applyHostTerminalSnapshot(terminalSnapshot(runId, getAgentRunRow(runId)!.projectId), {
    channelServer: cs as never,
    deliveryRouter: fixedDeliveryRouter({ agent: 'channel' }),
    mailboxEnqueue: mb.port,
    broadcast: () => {},
    terminalCleanup: () => {},
  });
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(mb.calls.length, 0, 'gate=channel must NOT enqueue mailbox');
  assert.equal(emits.length, 1, 'gate=channel pushes the terminal envelope to Channel');
  if (prior === undefined) delete process.env.PC_DELIVERY_TRANSPORT;
  else process.env.PC_DELIVERY_TRANSPORT = prior;
});
