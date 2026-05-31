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
const { applyHostTerminalSnapshot } = await import('../src/services/agent-host-reattach.ts');
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
