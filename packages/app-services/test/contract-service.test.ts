// Slice 013 — ContractService announces a `contract.changed` fact for each
// mutation, atomically with the repo write. Uses a real temp DB + a recording
// insertLiveEvent stub injected into the service (mirrors area-service.test.ts).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-contract-service-'));
process.env.PC_DATA_DIR = tmpDir;

const db = await import('@pc/db');
const { ContractService } = await import('../src/contracts/index.ts');
const { isContractChangedLiveEvent } = await import('@pc/contracts');

import type { InsertLiveEventDraft, LiveOutboxEvent } from '@pc/db';

before(() => db.runMigrations());
after(() => {
  db.closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

function makeService() {
  const drafts: InsertLiveEventDraft[] = [];
  const recordingInsert = (<TPayload>(
    tx: Parameters<typeof db.insertLiveEvent>[0],
    draft: InsertLiveEventDraft<TPayload>,
  ): LiveOutboxEvent<TPayload> => {
    drafts.push(draft as InsertLiveEventDraft);
    return db.insertLiveEvent(tx, draft);
  }) as typeof db.insertLiveEvent;
  const service = new ContractService({ insertLiveEvent: recordingInsert });
  return { service, drafts };
}

function seedProject(slug: string) {
  return db.createProject({ slug, name: slug, stages, folderPath: '' });
}

test('create emits exactly one contract.changed (created) fact', () => {
  const p = seedProject('svc-create');
  const { service, drafts } = makeService();
  const c = service.create({
    projectId: p.id,
    podName: 'researcher',
    expectedOutput: { kind: 'answer', min_chars: 10 },
    acceptanceCriteria: [{ kind: 'report_contains', pattern: 'done' }],
    verificationTier: 'auto',
  });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]!.type, 'contract.changed');
  assert.equal(drafts[0]!.entity, 'contract');
  assert.equal(drafts[0]!.scope, 'project');
  assert.equal(drafts[0]!.entityId, c.id);
  assert.equal(drafts[0]!.version, c.version);
  assert.equal((drafts[0]!.payload as { reason: string }).reason, 'created');
  assert.equal(c.status, 'issued');
});

test('setDeliverable emits a deliverable-set fact carrying the new version', () => {
  const p = seedProject('svc-deliverable');
  const { service, drafts } = makeService();
  const c = service.create({ projectId: p.id, podName: 'writer' });
  drafts.length = 0;
  const updated = service.setDeliverable({
    id: c.id,
    deliverable: { kind: 'prose', text: '## Goals' },
    report: 'wrote it',
  });
  assert.ok(updated);
  assert.equal(drafts.length, 1);
  assert.equal((drafts[0]!.payload as { reason: string }).reason, 'deliverable-set');
  assert.equal(drafts[0]!.version, updated!.version);
  assert.deepEqual(updated!.deliverable, { kind: 'prose', text: '## Goals' });
  assert.equal(updated!.report, 'wrote it');
  assert.equal(updated!.status, 'submitted');
});

test('setVerification emits a verification-set fact + flips status', () => {
  const p = seedProject('svc-verify');
  const { service, drafts } = makeService();
  const c = service.create({ projectId: p.id, verificationTier: 'auto' });
  drafts.length = 0;
  const updated = service.setVerification({ id: c.id, verificationStatus: 'passed' });
  assert.ok(updated);
  assert.equal(drafts.length, 1);
  assert.equal((drafts[0]!.payload as { reason: string }).reason, 'verification-set');
  assert.equal(updated!.verificationStatus, 'passed');
  assert.equal(updated!.status, 'accepted');
});

test('the durable outbox row deserializes into a valid ContractChangedLiveEvent', () => {
  const p = seedProject('svc-durable');
  const { service } = makeService();
  const before = db.getLiveEventHighWater();
  service.create({ projectId: p.id, podName: 'x' });
  const after = db.listLiveEventsAfter({ after: before ?? '0', projectId: p.id });
  const evt = after.events.find((e) => e.type === 'contract.changed');
  assert.ok(evt);
  assert.equal(isContractChangedLiveEvent(evt), true);
});

test('many contracts : one work item — all announced, listByWorkItem ordered', () => {
  const p = seedProject('svc-many');
  const { service, drafts } = makeService();
  // a real WI id is not required for the FK (app-enforced, nullable) — use ULIDs.
  const wiId = db.newId();
  const a = service.create({ projectId: p.id, workItemId: wiId, podName: 'a' });
  const b = service.create({ projectId: p.id, workItemId: wiId, podName: 'b' });
  assert.equal(drafts.length, 2);
  const list = service.listByWorkItem(wiId);
  assert.deepEqual(list.map((c) => c.id), [a.id, b.id]);
});

test('setRun links a run + announces dispatched; listByRun resolves', () => {
  const p = seedProject('svc-run');
  const { service, drafts } = makeService();
  const c = service.create({ projectId: p.id, podName: 'x' });
  drafts.length = 0;
  const runId = db.newId();
  const linked = service.setRun(c.id, runId);
  assert.ok(linked);
  assert.equal(linked!.agentRunId, runId);
  assert.equal(linked!.status, 'dispatched');
  assert.equal((drafts[0]!.payload as { reason: string }).reason, 'dispatched');
  assert.deepEqual(service.listByRun(runId).map((x) => x.id), [c.id]);
});

test('a mutation on a missing contract emits NOTHING (returns null)', () => {
  const p = seedProject('svc-missing');
  const { service, drafts } = makeService();
  void p;
  const out = service.setDeliverable({ id: 'no-such', deliverable: null });
  assert.equal(out, null);
  assert.equal(drafts.length, 0);
});
