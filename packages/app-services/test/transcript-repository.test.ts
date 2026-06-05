// M3b — DbTranscriptRepository over injected conversation_events readers
// (was: FileTranscriptRepository over the injected file parser, ☠).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ConversationReplayService,
  DbTranscriptRepository,
} from '../src/conversations/index.ts';
import type { ConversationEventRow } from '@pc/db';

function mkRow(seq: number, over: Partial<ConversationEventRow> = {}): ConversationEventRow {
  return {
    id: `s1:${seq}`,
    sessionId: 's1',
    seq,
    type: 'jsonl',
    kind: 'jsonl-user',
    event: { kind: 'jsonl-user', text: `m${seq}` },
    sourceKind: 'claude-jsonl',
    sourceCursor: seq,
    createdAt: 1000 + seq,
    ...over,
  };
}

/** In-memory double mirroring the repo's afterSeq/limit semantics. */
function mkRepo(rows: ConversationEventRow[]) {
  return new DbTranscriptRepository({
    listEvents: (sessionId, opts = {}) => {
      let out = rows.filter((r) => r.sessionId === sessionId).sort((a, b) => a.seq - b.seq);
      if (opts.afterSeq !== undefined) out = out.filter((r) => r.seq > opts.afterSeq!);
      if (opts.limit !== undefined) out = out.slice(0, opts.limit);
      return out;
    },
    getHighWaterSeq: (sessionId) =>
      rows.filter((r) => r.sessionId === sessionId).reduce((m, r) => Math.max(m, r.seq), 0),
  });
}

test('loadCheckpoint maps rows to the envelope shape (id/type/kind/event/source)', () => {
  const repo = mkRepo([mkRow(1), mkRow(2)]);
  const out = repo.loadCheckpoint({ projectId: 'p1', sessionId: 's1' });
  assert.equal(out.sessionId, 's1');
  assert.equal(out.highWaterSeq, 2);
  assert.deepEqual(out.events.map((e) => e.seq), [1, 2]);
  assert.deepEqual(out.events[0], {
    id: 's1:1',
    sessionId: 's1',
    seq: 1,
    type: 'jsonl',
    kind: 'jsonl-user',
    event: { kind: 'jsonl-user', text: 'm1' },
    source: { kind: 'claude-jsonl', cursor: 1 },
  });
});

test('an empty session yields an empty checkpoint with highWaterSeq 0', () => {
  const out = mkRepo([]).loadCheckpoint({ projectId: 'p', sessionId: 's1' });
  assert.deepEqual(out, { sessionId: 's1', highWaterSeq: 0, events: [] });
});

test('legacy imported rows keep type event + legacy source kind', () => {
  const repo = mkRepo([mkRow(1, { type: 'event', kind: null, sourceKind: 'legacy-events-jsonl' })]);
  const out = repo.loadCheckpoint({ projectId: 'p', sessionId: 's1' });
  assert.equal(out.events[0]!.type, 'event');
  assert.equal(out.events[0]!.kind, null);
  assert.equal(out.events[0]!.source.kind, 'legacy-events-jsonl');
});

test('listAfter returns only rows with seq > afterSeq, highWaterSeq stays the full session high water', () => {
  const repo = mkRepo([mkRow(1), mkRow(2), mkRow(3), mkRow(4)]);
  const out = repo.listAfter({ projectId: 'p1', sessionId: 's1', afterSeq: 2 });
  assert.deepEqual(out.events.map((e) => e.seq), [3, 4]);
  assert.equal(out.highWaterSeq, 4);
});

test('listAfter: afterSeq=0 equals the full checkpoint', () => {
  const repo = mkRepo([mkRow(1), mkRow(2), mkRow(3)]);
  const full = repo.loadCheckpoint({ projectId: 'p1', sessionId: 's1' });
  assert.deepEqual(repo.listAfter({ projectId: 'p1', sessionId: 's1', afterSeq: 0 }), full);
});

test('listAfter: afterSeq >= highWaterSeq returns empty events, stable highWaterSeq', () => {
  const repo = mkRepo([mkRow(1), mkRow(2), mkRow(3)]);
  const out = repo.listAfter({ projectId: 'p1', sessionId: 's1', afterSeq: 3 });
  assert.deepEqual(out.events, []);
  assert.equal(out.highWaterSeq, 3);
});

test('listAfter: limit caps oldest-first', () => {
  const repo = mkRepo([1, 2, 3, 4, 5].map((n) => mkRow(n)));
  const out = repo.listAfter({ projectId: 'p1', sessionId: 's1', afterSeq: 1, limit: 2 });
  assert.deepEqual(out.events.map((e) => e.seq), [2, 3]);
});

test('ConversationReplayService maps to the byte-identical response body', () => {
  const service = new ConversationReplayService(mkRepo([mkRow(1), mkRow(2)]));
  const full = service.loadReplay({ projectId: 'p1', sessionId: 's1' });
  assert.equal(full.ok, true);
  assert.equal(full.sessionId, 's1');
  assert.equal(full.highWaterSeq, 2);
  assert.deepEqual(full.events.map((e) => e.seq), [1, 2]);
  assert.equal('resetRequired' in full, false);

  const after = service.loadReplayAfter({ projectId: 'p1', sessionId: 's1', afterSeq: 1 });
  assert.deepEqual(after.events.map((e) => e.seq), [2]);
  assert.equal(after.highWaterSeq, 2);
});
