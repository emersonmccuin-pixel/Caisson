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
const { ContractService } = await import('@pc/app-services');
const { applyHostTerminalSnapshot, reconcileAgentRunsAgainstHost } = await import(
  '../src/services/agent-host-reattach.ts'
);
const { applyAgentRunTerminalEffects } = await import(
  '../src/services/agent-run-terminal-effects.ts'
);
const { reattachAgentRunsDuringServerBoot } = await import(
  '../src/services/agent-run-server-boot.ts'
);
const { sweepAgentRunLiveness } = await import('../src/services/agent-run-liveness-sweep.ts');
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

/** Fake host client. Boot reattach registers a live handle for a non-terminal
 *  snapshot and subscribes via onEvent; emitting a run-terminal then drives the
 *  threaded terminal-effects deps. */
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

test('boot-reattach: a host terminal event routes ONE mailbox turn', async () => {
  const { runId, projectId } = seedRun(`htg-boot-mbox-${Date.now()}`);
  const mb = fakeMailbox();
  const host = fakeHostClient(runningSnapshot(runId, projectId));

  const result = await reattachAgentRunsDuringServerBoot({
    getHostClient: () => host.client as never,
    activeRunRegistry: new ActiveRunRegistry(),
    mailboxEnqueue: mb.port,
    broadcast: () => {},
    terminalCleanup: () => {},
  });
  assert.equal(result.mode, 'host');

  host.emitTerminal(terminalSnapshot(runId, projectId));
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(mb.calls.length, 1, 'boot-reattach terminal event must enqueue ONE mailbox turn');
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
  });
  assert.equal(res.terminalApplied, 1);
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(mb.calls.length, 1, 'reconcile-sweep terminal must enqueue ONE mailbox turn');
});

test('liveness-sweep finalize: a swept failure routes to the mailbox', async () => {
  const { runId, projectId } = seedRun(`htg-live-mbox-${Date.now()}`);
  void projectId;
  const mb = fakeMailbox();
  const row = getAgentRunRow(runId)!;

  const res = sweepAgentRunLiveness({
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

  assert.equal(mb.calls.length, 1, 'swept failure enqueues a mailbox turn');
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
  const runId = newId();
  insertAgentRunRow({
    id: runId,
    projectId: project.id,
    podName: 'haiku',
    dispatcherSessionId: 'disp-1',
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
      dispatcherSessionId: 'disp-1',
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
