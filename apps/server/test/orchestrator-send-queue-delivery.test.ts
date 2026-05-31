// Slice-006 fix regression: the LIVE drain path (pty-handlers state->ready ->
// deliverNextQueuedPrompt) must not wedge when a queued send returns
// echo-timeout (or any non-ok). Pre-fix, deliverNextQueuedPromptOnce delivered
// exactly one row then returned; a SUCCESS advanced the queue via the
// jsonl-user correlation, but a FAILURE produced no jsonl-user event, so the
// remaining queued prompts stranded ("N queued prompt pending" stuck). The
// drain now marks the head failed and CONTINUES to the next queued row.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-send-queue-delivery-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createOrchestratorSession,
  createProject,
  enqueueOrchestratorSend,
  listVisibleOrchestratorSendsForSession,
  newId,
  runMigrations,
} = await import('@pc/db');
const { deliverNextQueuedPromptOnce } = await import(
  '../src/services/orchestrator-send-queue-delivery.ts'
);

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

interface Harness {
  projectId: ULID;
  sessionId: ULID;
  runtime: { ptySession(): { getState(): string; send(text: string): Promise<string> } | null };
  sends: string[];
  snapshots: Array<{ projectId: ULID; sessionId: ULID }>;
}

function mkHarness(send: (text: string, call: number) => string): Harness {
  const project = createProject({
    slug: `del-${newId()}`,
    name: 'Del',
    stages,
    folderPath: join(tmpDir, `del-${newId()}`),
  });
  const session = createOrchestratorSession({
    projectId: project.id,
    providerSessionId: `uuid-${newId()}`,
  });
  const sends: string[] = [];
  const snapshots: Array<{ projectId: ULID; sessionId: ULID }> = [];
  let call = 0;
  const live = {
    getState: () => 'ready',
    send: async (text: string) => {
      call += 1;
      const result = send(text, call);
      if (result === 'ok') sends.push(text);
      return result;
    },
  };
  return {
    projectId: project.id,
    sessionId: session.id,
    runtime: { ptySession: () => live },
    sends,
    snapshots,
  };
}

function enqueueAll(h: Harness, texts: string[]): void {
  for (const [i, text] of texts.entries()) {
    enqueueOrchestratorSend({
      projectId: h.projectId,
      sessionId: h.sessionId,
      clientMessageId: `cm-${i}-${newId()}`,
      text,
      status: 'queued_busy',
    });
  }
}

const broadcast = (h: Harness) => (projectId: ULID, sessionId: ULID) =>
  h.snapshots.push({ projectId, sessionId });

test('echo-timeout on the head queued send does NOT wedge — head fails, next is delivered', async () => {
  const h = mkHarness((_text, call) => (call === 1 ? 'echo-timeout' : 'ok'));
  enqueueAll(h, ['testing', 'testing', 'okay']);

  await deliverNextQueuedPromptOnce(h.projectId, h.runtime, h.sessionId, broadcast(h));

  const visible = listVisibleOrchestratorSendsForSession(h.sessionId);
  const failed = visible.filter((r) => r.status === 'failed');
  const delivered = visible.filter((r) => r.status === 'delivered_to_pty');
  const queued = visible.filter((r) => r.status.startsWith('queued_'));

  assert.equal(failed.length, 1, 'the echo-timeout head terminalizes as failed');
  assert.equal(failed[0]!.failureReason, 'send returned echo-timeout');
  assert.equal(delivered.length, 1, 'the next queued turn was delivered (not wedged)');
  assert.equal(queued.length, 1, 'drain stops on the first SUCCESS pending jsonl correlation');
  // Discrete turns stay discrete rows; no glue/concatenation at the queue layer.
  assert.deepEqual(h.sends, ['testing']);
});

test('a queue of all-failures drains fully and leaves nothing open/queued (no wedge)', async () => {
  const h = mkHarness(() => 'echo-timeout');
  enqueueAll(h, ['a', 'b', 'c']);

  await deliverNextQueuedPromptOnce(h.projectId, h.runtime, h.sessionId, broadcast(h));

  const visible = listVisibleOrchestratorSendsForSession(h.sessionId);
  assert.equal(visible.filter((r) => r.status === 'failed').length, 3);
  assert.equal(visible.filter((r) => r.status.startsWith('queued_')).length, 0);
  assert.equal(visible.filter((r) => r.status === 'delivering').length, 0);
});
