import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isTranscriptEventDto,
  isTranscriptReplayResponse,
  isTranscriptSourceDto,
  parseTranscriptAfterSeqQuery,
  type TranscriptEventDto,
  type TranscriptReplayResponse,
} from '../src/index.ts';

function makeEvent(over: Partial<TranscriptEventDto> = {}): TranscriptEventDto {
  return {
    id: 's1:1',
    sessionId: 's1',
    seq: 1,
    type: 'jsonl',
    kind: 'jsonl-user',
    event: { kind: 'jsonl-user', text: 'hi' },
    source: { kind: 'claude-jsonl', cursor: 1 },
    ...over,
  };
}

test('isTranscriptSourceDto mirrors the two existing source kinds', () => {
  assert.equal(isTranscriptSourceDto({ kind: 'claude-jsonl', cursor: 3 }), true);
  assert.equal(isTranscriptSourceDto({ kind: 'legacy-events-jsonl', cursor: null }), true);
  assert.equal(isTranscriptSourceDto({ kind: 'sqlite', cursor: 1 }), false);
});

test('isTranscriptEventDto mirrors ReplayEnvelope; clientMessageId optional', () => {
  assert.equal(isTranscriptEventDto(makeEvent()), true);
  assert.equal(isTranscriptEventDto(makeEvent({ type: 'event', kind: null })), true);
  assert.equal(isTranscriptEventDto(makeEvent({ clientMessageId: 'cm1' })), true);
  assert.equal(isTranscriptEventDto(makeEvent({ type: 'bogus' as never })), false);
  assert.equal(isTranscriptEventDto(makeEvent({ clientMessageId: 9 as never })), false);
  assert.equal(isTranscriptEventDto({ ...makeEvent(), seq: '1' }), false);
});

test('isTranscriptReplayResponse mirrors the route body and validates rows', () => {
  const ok: TranscriptReplayResponse = {
    ok: true,
    sessionId: 's1',
    highWaterSeq: 2,
    events: [makeEvent(), makeEvent({ id: 's1:2', seq: 2 })],
  };
  assert.equal(isTranscriptReplayResponse(ok), true);
  assert.equal(isTranscriptReplayResponse({ ...ok, ok: false }), false);
  assert.equal(isTranscriptReplayResponse({ ...ok, highWaterSeq: 'x' }), false);
  assert.equal(isTranscriptReplayResponse({ ...ok, events: [makeEvent({ seq: 'x' as never })] }), false);
});

test('parseTranscriptAfterSeqQuery: no afterSeq -> null (unchanged full checkpoint)', () => {
  assert.equal(parseTranscriptAfterSeqQuery({}), null);
  assert.equal(parseTranscriptAfterSeqQuery({ afterSeq: null }), null);
  assert.equal(parseTranscriptAfterSeqQuery({ afterSeq: '' }), null);
});

test('parseTranscriptAfterSeqQuery: clamps and reads limit', () => {
  assert.deepEqual(parseTranscriptAfterSeqQuery({ afterSeq: '5' }), { afterSeq: 5 });
  assert.deepEqual(parseTranscriptAfterSeqQuery({ afterSeq: '5', limit: '10' }), { afterSeq: 5, limit: 10 });
  // invalid afterSeq clamps to 0 (== full checkpoint), bad limit dropped
  assert.deepEqual(parseTranscriptAfterSeqQuery({ afterSeq: '-3', limit: 'x' }), { afterSeq: 0 });
});
