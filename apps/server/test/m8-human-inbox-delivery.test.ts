// M8 (FD-7) — Human Inbox delivery. Pre-M8, every formal "a human must decide"
// moment was invisible: requestReview delivered ONLY the orchestrator flavor
// (a `reviewer:'human'` gate paused the run with no notice anywhere), the M6-C
// ceiling escalation re-posted through the same hole, the human-review
// verification tier promised an inbox that didn't exist, and a loop kick-back's
// re-review dedupe-vanished against the first prompt's idempotency key.
//
// This pins the slice-B contract:
//   1. the executor passes {iteration, escalated} so delivery is
//      iteration-keyed (FD-8 — a re-review delivers AGAIN),
//   2. the ceiling re-post arrives escalated:true,
//   3. a human-review verification hold enqueues a `verification-review`
//      user-inbox card,
//   4. resolve-by-source collect/action clears decided cards (the decided-
//      elsewhere loop closer).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ULID, WorkflowV2 } from '@pc/domain';
import type { EnqueueMailboxMessageInput } from '@pc/db';
import type { AgentHostRunSnapshot } from '@pc/runtime';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-m8-inbox-delivery-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createOrchestratorSession,
  createProject,
  getAgentRunRow,
  insertAgentRunRow,
  markAgentRunDelivered,
  newId,
  runMigrations,
} = await import('@pc/db');
const { ContractService, MailboxService } = await import('@pc/app-services');
const { applyHostTerminalSnapshot } = await import('../src/services/agent-host-reattach.ts');
const { DagExecutor } = await import('../src/services/dag-executor.ts');
type DagExecutorDeps = import('../src/services/dag-executor.ts').DagExecutorDeps;
type NodeOutcome = import('../src/services/dag-executor.ts').NodeOutcome;

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

// ── 1+2: executor-level requestReview opts (pure, no DB) ─────────────────────

/** max_iterations 2 → reject #1 kicks back (iteration 1 re-review), reject #2
 *  hits the ceiling (escalated re-post). */
function loopWorkflow(maxIterations: number): WorkflowV2.Workflow {
  return {
    id: 'wf',
    name: 'Loop Flow',
    nodes: [
      { id: 'a', kind: 'agent', agent: 'writer', task: 'write', next: ['r'] },
      { id: 'r', kind: 'review', reviewer: 'human', reject: 'l' },
      { id: 'l', kind: 'loop', back_to: 'a', max_iterations: maxIterations },
    ],
  };
}

function baseDeps(over: Partial<DagExecutorDeps> = {}): DagExecutorDeps {
  return {
    resolveRef: () => () => '',
    dispatchAgent: async (): Promise<NodeOutcome> => ({ state: 'completed' }),
    moveCard: async () => ({ ok: true }),
    mergeToDev: async () => ({ outcome: 'merged' as const }),
    requestReview: async () => {},
    persist: () => {},
    event: () => {},
    isCancelled: () => false,
    ...over,
  };
}

const ctxBase = { runId: 'run-1' as ULID, rootWorkItemId: 'wi-1' as ULID, worktreePath: null };

test('re-review after a loop kick-back is iteration-keyed; ceiling arrives escalated', async () => {
  const calls: { reviewer: string; iteration: number; escalated: boolean }[] = [];
  const deps = baseDeps({
    requestReview: async (node, _ctx, _bundle, opts) => {
      calls.push({ reviewer: node.reviewer, ...opts });
    },
  });

  const exec = DagExecutor.start(loopWorkflow(2), deps, ctxBase);
  let status = await exec.advance();
  assert.equal(status, 'awaiting-review');
  assert.deepEqual(calls[0], { reviewer: 'human', iteration: 0, escalated: false });

  // Reject #1 — under the ceiling: loop fires, the agent re-runs, the review
  // re-arms. The SECOND request carries iteration 1 (a NEW idempotency key —
  // pre-M8 it deduped against the first and silently never delivered).
  status = await exec.onReviewDecision('r', { kind: 'reject', notes: 'redo' });
  assert.equal(status, 'awaiting-review');
  assert.equal(calls.length, 2, 'kick-back re-review delivers again');
  assert.deepEqual(calls[1], { reviewer: 'human', iteration: 1, escalated: false });

  // Reject #2 — the ceiling (max_iterations 2). The gate re-posts ESCALATED.
  status = await exec.onReviewDecision('r', { kind: 'reject', notes: 'still bad' });
  assert.equal(status, 'awaiting-review');
  assert.equal(calls.length, 3, 'ceiling re-posts the gate');
  assert.equal(calls[2]!.escalated, true);
  assert.equal(calls[2]!.iteration, 2);
});

// ── 3: human-review verification hold → user-inbox card ─────────────────────

function fakeMailbox() {
  const calls: EnqueueMailboxMessageInput[] = [];
  return { port: (input: EnqueueMailboxMessageInput) => (calls.push(input), {}), calls };
}

test('human-review tier parks the contract AND enqueues a verification-review user-inbox card', async () => {
  const project = createProject({
    slug: `m8-vr-${Date.now()}`,
    name: 'M8 VR',
    stages,
    folderPath: join(tmpDir, 'm8-vr'),
  });
  const session = createOrchestratorSession({
    projectId: project.id,
    providerSessionId: 'cc-m8-vr',
  });
  const contract = new ContractService().create({
    projectId: project.id as ULID,
    workItemId: null,
    podName: 'builder',
    acceptanceCriteria: [],
    verificationTier: 'human-review',
  });
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
    contractId: contract.id as ULID,
  });
  // The positive done-signal — without it the deliverable gate flips this
  // completion to a no-deliverable failure and verification rejects instead
  // of parking at the human-review hold.
  markAgentRunDelivered(runId, Date.now());

  const mb = fakeMailbox();
  const t = Date.now();
  const applied = applyHostTerminalSnapshot(
    {
      runId,
      projectId: project.id,
      dispatcherSessionId: session.id,
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
    } satisfies AgentHostRunSnapshot,
    { mailboxEnqueue: mb.port, broadcast: () => {}, terminalCleanup: () => {} },
  );
  assert.equal(applied, 1);
  await new Promise((r) => setTimeout(r, 200)); // async terminal-effects tail

  const card = mb.calls.find((c) => c.message.kind === 'verification-review');
  assert.ok(card, 'human-review hold enqueues the verification-review card');
  assert.equal(card!.recipients[0]!.addressKind, 'user-inbox');
  assert.equal(card!.recipients[0]!.channel, 'ui-inbox');
  assert.equal(card!.message.sourceKind, 'agent-contract');
  assert.equal(card!.message.sourceId, contract.id);
  assert.equal((card!.message.payload as { contractId?: string }).contractId, contract.id);
  assert.equal(card!.message.idempotencyKey, `verification-review:${contract.id}`);
  assert.equal(getAgentRunRow(runId)!.status, 'completed');
});

// ── 4: resolve-by-source collect/action (the decided-elsewhere loop closer) ──

test('collectUnactionedRecipients + actionRecipients clear every open card for a source', () => {
  const project = createProject({
    slug: `m8-res-${Date.now()}`,
    name: 'M8 Resolve',
    stages,
    folderPath: join(tmpDir, 'm8-res'),
  });
  const mailbox = new MailboxService();
  const sourceId = `run-x:review-1`;
  const enqueueCard = (iteration: number) =>
    mailbox.enqueue({
      message: {
        id: newId(),
        projectId: project.id,
        kind: 'workflow-review',
        body: `review please (i${String(iteration)})`,
        sourceKind: 'workflow-run-node',
        sourceId,
        idempotencyKey: `workflow-review:run-x:review-1:i${String(iteration)}`,
      },
      recipients: [
        {
          id: newId(),
          addressKind: 'user-inbox',
          addressJson: { kind: 'user-inbox', userId: 'local-user', projectId: project.id },
          channel: 'ui-inbox',
          deliveryId: newId(),
        },
      ],
      now: Date.now(),
    });
  enqueueCard(0);
  enqueueCard(1); // iteration-keyed: the re-review is a SECOND message

  const open = mailbox.collectUnactionedRecipients('workflow-run-node', sourceId);
  assert.equal(open.length, 2, 'both iteration cards are open');

  const actioned = mailbox.actionRecipients(open, Date.now());
  assert.equal(actioned, 2);
  assert.deepEqual(
    mailbox.collectUnactionedRecipients('workflow-run-node', sourceId),
    [],
    'decided cards never linger',
  );

  // Unrelated source untouched.
  assert.deepEqual(mailbox.collectUnactionedRecipients('workflow-run-node', 'other'), []);
});
