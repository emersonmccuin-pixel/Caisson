// Migration 0056 — context-doc read receipts.
//
// Covers: batch record + stats aggregate, never-read docs absent from stats,
// receipts surviving doc soft-delete, and per-run listing.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-ctx-reads-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createAgent,
  createContextDoc,
  getContextDocReadStats,
  listContextDocReadsForRun,
  recordContextDocReads,
  runMigrations,
  softDeleteContextDoc,
} = await import('../src/index.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeDoc(title: string) {
  const agent = createAgent(
    { name: `reads-pod-${title}`, scope: 'global' },
    { actor: 'user' },
  );
  return createContextDoc({ scope: { agentId: agent.id }, title, body: 'x' });
}

test('record + stats aggregate (count and lastReadAt)', () => {
  const doc = makeDoc('agg');
  const runId = '01RUN000000000000000000000' as ULID;
  recordContextDocReads({
    docIds: [doc.id],
    agentRunId: runId,
    sessionKind: 'agent-run',
    readVia: 'injection',
  });
  recordContextDocReads({
    docIds: [doc.id],
    agentRunId: runId,
    sessionKind: 'agent-run',
    readVia: 'tool',
  });

  const stats = getContextDocReadStats([doc.id]);
  const s = stats.get(doc.id);
  assert.ok(s, 'doc should have stats');
  assert.equal(s!.readCount, 2);
  assert.ok(s!.lastReadAt > 0);
});

test('never-read docs are absent from stats', () => {
  const doc = makeDoc('never');
  const stats = getContextDocReadStats([doc.id]);
  assert.equal(stats.get(doc.id), undefined);
});

test('batch insert records one receipt per doc', () => {
  const a = makeDoc('batch-a');
  const b = makeDoc('batch-b');
  recordContextDocReads({
    docIds: [a.id, b.id],
    sessionKind: 'orchestrator',
    readVia: 'tool',
  });
  const stats = getContextDocReadStats([a.id, b.id]);
  assert.equal(stats.get(a.id)?.readCount, 1);
  assert.equal(stats.get(b.id)?.readCount, 1);
});

test('empty docIds list is a no-op', () => {
  assert.doesNotThrow(() =>
    recordContextDocReads({ docIds: [], sessionKind: 'orchestrator', readVia: 'tool' }),
  );
});

test('receipts survive doc soft-delete (history, no FK)', () => {
  const doc = makeDoc('survive');
  recordContextDocReads({
    docIds: [doc.id],
    sessionKind: 'orchestrator',
    readVia: 'tool',
  });
  softDeleteContextDoc(doc.id);
  assert.equal(getContextDocReadStats([doc.id]).get(doc.id)?.readCount, 1);
});

test('listContextDocReadsForRun returns only that run rows', () => {
  const doc = makeDoc('per-run');
  const runA = '01RUNAAAAAAAAAAAAAAAAAAAAA' as ULID;
  const runB = '01RUNBBBBBBBBBBBBBBBBBBBBB' as ULID;
  recordContextDocReads({
    docIds: [doc.id],
    agentRunId: runA,
    sessionKind: 'agent-run',
    readVia: 'injection',
  });
  recordContextDocReads({
    docIds: [doc.id],
    agentRunId: runB,
    sessionKind: 'agent-run',
    readVia: 'tool',
  });
  const rowsA = listContextDocReadsForRun(runA);
  assert.equal(rowsA.length, 1);
  assert.equal(rowsA[0]!.readVia, 'injection');
});
