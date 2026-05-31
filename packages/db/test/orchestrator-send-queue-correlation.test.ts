import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-send-queue-correlation-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createOrchestratorSession,
  createProject,
  enqueueOrchestratorSend,
  getOrchestratorSendQueueRow,
  markNextDeliveredOrchestratorSendObservedInJsonl,
  markOrchestratorSendDelivered,
  newId,
  runMigrations,
} = await import('../src/index.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

function deliveredRow(projectId: ULID, sessionId: ULID, text: string): ULID {
  const row = enqueueOrchestratorSend({
    projectId,
    sessionId,
    clientMessageId: newId(),
    text,
    status: 'queued_busy',
  });
  markOrchestratorSendDelivered(row.id);
  return row.id;
}

// REGRESSION (slice-006 wedge): after an echo-timeout the un-submitted body
// glues onto the next send, so CC's jsonl-user text diverges from the stored
// row text. The old exact-text-only correlation then never advanced the
// delivered_to_pty row -> it stranded forever ("RUNTIME QUEUE 1"). The FIFO
// fallback must self-heal: the oldest delivered row advances on divergent text.
test('divergent jsonl text still advances the oldest delivered_to_pty row (self-heal)', () => {
  const project = createProject({
    slug: `sqc-heal-${Date.now()}`,
    name: 'SQC heal',
    stages,
    folderPath: join(tmpDir, 'sqc-heal'),
  });
  const sessionId = createOrchestratorSession({
    projectId: project.id,
    providerSessionId: `cc-${Date.now()}`,
  }).id;
  const id = deliveredRow(project.id, sessionId, 'keepme-three');

  // jsonl text is the glued artifact, NOT equal to the stored row text
  const advanced = markNextDeliveredOrchestratorSendObservedInJsonl(
    sessionId,
    'keepme-threeSay the word: recovered',
  );
  assert.ok(advanced, 'fallback must advance the delivered row on divergent text');
  assert.equal(advanced!.id, id);
  assert.equal(getOrchestratorSendQueueRow(id)!.status, 'observed_in_jsonl');
});

// The exact-text match must remain PRIMARY: when it hits, it advances that
// specific row, not merely the oldest delivered one.
test('exact-text match takes precedence over the oldest delivered row', () => {
  const project = createProject({
    slug: `sqc-exact-${Date.now()}`,
    name: 'SQC exact',
    stages,
    folderPath: join(tmpDir, 'sqc-exact'),
  });
  const sessionId = createOrchestratorSession({
    projectId: project.id,
    providerSessionId: `cc-${Date.now()}`,
  }).id;
  const older = deliveredRow(project.id, sessionId, 'alpha');
  const newer = deliveredRow(project.id, sessionId, 'bravo');

  const advanced = markNextDeliveredOrchestratorSendObservedInJsonl(sessionId, 'bravo');
  assert.equal(advanced!.id, newer, 'exact text wins over FIFO-oldest');
  assert.equal(getOrchestratorSendQueueRow(newer)!.status, 'observed_in_jsonl');
  assert.equal(getOrchestratorSendQueueRow(older)!.status, 'delivered_to_pty');
});

test('no delivered rows -> undefined (nothing to advance)', () => {
  const sessionId = newId();
  assert.equal(markNextDeliveredOrchestratorSendObservedInJsonl(sessionId, 'whatever'), undefined);
});
