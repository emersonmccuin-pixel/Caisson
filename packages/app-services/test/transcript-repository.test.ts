import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ConversationReplayService,
  FileTranscriptRepository,
  type SessionReplayCheckpointLike,
  type ReadSessionCheckpoint,
} from '../src/conversations/index.ts';

function mkEnvelope(seq: number): SessionReplayCheckpointLike['events'][number] {
  return {
    id: `s1:${seq}`,
    sessionId: 's1',
    seq,
    type: 'jsonl',
    kind: 'jsonl-user',
    event: { kind: 'jsonl-user', text: `m${seq}` },
    source: { kind: 'claude-jsonl', cursor: seq },
  };
}

function mkCheckpoint(seqs: number[]): SessionReplayCheckpointLike {
  return {
    sessionId: 's1',
    highWaterSeq: seqs.length ? Math.max(...seqs) : 0,
    events: seqs.map(mkEnvelope),
  };
}

function mkRepo(checkpoint: SessionReplayCheckpointLike, paths: string[] = []) {
  const reader: ReadSessionCheckpoint = (path, sessionId) => {
    paths.push(`${path}|${sessionId ?? ''}`);
    return checkpoint;
  };
  return new FileTranscriptRepository({
    readCheckpoint: reader,
    resolveSessionDataPath: ({ projectId, sessionId }) => `/data/${projectId}/${sessionId}`,
  });
}

test('loadCheckpoint returns the injected reader output verbatim (byte-identical parity)', () => {
  const checkpoint = mkCheckpoint([1, 2, 3]);
  const paths: string[] = [];
  const repo = mkRepo(checkpoint, paths);
  const out = repo.loadCheckpoint({ projectId: 'p1', sessionId: 's1' });
  assert.deepEqual(out, checkpoint);
  assert.deepEqual(paths, ['/data/p1/s1|s1']);
});

test('loadCheckpoint preserves empty + legacy-fallback + malformed-skip results (reader owns it)', () => {
  // empty checkpoint
  assert.deepEqual(mkRepo(mkCheckpoint([])).loadCheckpoint({ projectId: 'p', sessionId: 's1' }), mkCheckpoint([]));
  // legacy-events fallback shape
  const legacy: SessionReplayCheckpointLike = {
    sessionId: 's1',
    highWaterSeq: 1,
    events: [{ id: 's1:1', sessionId: 's1', seq: 1, type: 'event', kind: null, event: { a: 1 }, source: { kind: 'legacy-events-jsonl', cursor: 1 } }],
  };
  assert.deepEqual(mkRepo(legacy).loadCheckpoint({ projectId: 'p', sessionId: 's1' }), legacy);
});

test('listAfter returns only rows with seq > afterSeq, highWaterSeq stays the full checkpoint', () => {
  const repo = mkRepo(mkCheckpoint([1, 2, 3, 4]));
  const out = repo.listAfter({ projectId: 'p1', sessionId: 's1', afterSeq: 2 });
  assert.deepEqual(out.events.map((e) => e.seq), [3, 4]);
  assert.equal(out.highWaterSeq, 4);
});

test('listAfter: afterSeq=0 equals the full checkpoint', () => {
  const full = mkCheckpoint([1, 2, 3]);
  const repo = mkRepo(full);
  assert.deepEqual(repo.listAfter({ projectId: 'p1', sessionId: 's1', afterSeq: 0 }), full);
});

test('listAfter: afterSeq >= highWaterSeq returns empty events, stable highWaterSeq', () => {
  const repo = mkRepo(mkCheckpoint([1, 2, 3]));
  const out = repo.listAfter({ projectId: 'p1', sessionId: 's1', afterSeq: 3 });
  assert.deepEqual(out.events, []);
  assert.equal(out.highWaterSeq, 3);
});

test('listAfter: limit caps oldest-first', () => {
  const repo = mkRepo(mkCheckpoint([1, 2, 3, 4, 5]));
  const out = repo.listAfter({ projectId: 'p1', sessionId: 's1', afterSeq: 1, limit: 2 });
  assert.deepEqual(out.events.map((e) => e.seq), [2, 3]);
});

test('ConversationReplayService maps to the byte-identical response body', () => {
  const repo = mkRepo(mkCheckpoint([1, 2]));
  const service = new ConversationReplayService(repo);
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

test('TranscriptEventDto preserves clientMessageId when the envelope carries it', () => {
  const checkpoint: SessionReplayCheckpointLike = {
    sessionId: 's1',
    highWaterSeq: 1,
    events: [{ ...mkEnvelope(1), clientMessageId: 'cm-9' }],
  };
  const service = new ConversationReplayService(mkRepo(checkpoint));
  const out = service.loadReplay({ projectId: 'p1', sessionId: 's1' });
  assert.equal(out.events[0]!.clientMessageId, 'cm-9');
});
