// M3b — conversation_events repo: append/replay-state/list/high-water on a
// fresh migrated DB (0047).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-conversation-events-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  appendConversationEvent,
  appendConversationEvents,
  closeDb,
  countConversationEvents,
  getConversationHighWaterSeq,
  getConversationReplayState,
  hasConversationEvents,
  listConversationEvents,
  runMigrations,
} = await import('../src/index.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function input(seq: number, over: Record<string, unknown> = {}) {
  return {
    sessionId: 's1',
    seq,
    type: 'jsonl' as const,
    kind: 'jsonl-assistant',
    event: { kind: 'jsonl-assistant', text: `t${seq}` },
    sourceKind: 'claude-jsonl',
    sourceCursor: seq * 10,
    now: 1000 + seq,
    ...over,
  };
}

test('append + list round-trips the envelope fields, ordered by seq', () => {
  appendConversationEvent(input(2));
  appendConversationEvent(input(1));
  const rows = listConversationEvents('s1');
  assert.deepEqual(rows.map((r) => r.seq), [1, 2]);
  assert.equal(rows[0]!.id, 's1:1');
  assert.deepEqual(rows[0]!.event, { kind: 'jsonl-assistant', text: 't1' });
  assert.equal(rows[0]!.sourceKind, 'claude-jsonl');
  assert.equal(rows[0]!.sourceCursor, 10);
});

test('replay state resumes nextSeq + the max source cursor (the G7 dedup floor)', () => {
  const state = getConversationReplayState('s1');
  assert.equal(state.nextSeq, 3);
  assert.equal(state.maxCursor, 20);
  // Unknown session = a fresh log.
  assert.deepEqual(getConversationReplayState('nope'), { nextSeq: 1, maxCursor: 0 });
});

test('double-write on the same (session, seq) throws (UNIQUE)', () => {
  assert.throws(() => appendConversationEvent(input(1)), /UNIQUE/);
});

test('afterSeq returns only later rows; limit caps oldest-first; high water is stable', () => {
  appendConversationEvent(input(3));
  appendConversationEvent(input(4));
  const after2 = listConversationEvents('s1', { afterSeq: 2 });
  assert.deepEqual(after2.map((r) => r.seq), [3, 4]);
  const capped = listConversationEvents('s1', { limit: 2 });
  assert.deepEqual(capped.map((r) => r.seq), [1, 2]);
  assert.equal(getConversationHighWaterSeq('s1'), 4);
});

test('bulk import writes all rows in one txn; count + has reflect it', () => {
  const n = appendConversationEvents([
    input(1, { sessionId: 's2', sourceKind: 'legacy-events-jsonl', type: 'event' }),
    input(2, { sessionId: 's2', sourceKind: 'legacy-events-jsonl', type: 'event' }),
  ]);
  assert.equal(n, 2);
  assert.equal(countConversationEvents('s2'), 2);
  assert.equal(hasConversationEvents('s2'), true);
  assert.equal(hasConversationEvents('s3'), false);
  assert.equal(listConversationEvents('s2')[0]!.type, 'event');
});

test('a bulk import with a duplicate seq rolls back whole (txn)', () => {
  assert.throws(() =>
    appendConversationEvents([
      input(5, { sessionId: 's2' }),
      input(2, { sessionId: 's2' }), // dup → throws
    ]),
  );
  assert.equal(countConversationEvents('s2'), 2); // unchanged — txn rolled back
});
