import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RUNTIME_SEND_STATUSES,
  isRuntimeSendQueueItemDto,
  isRuntimeSendStatus,
  isRuntimeTurnSource,
  parseSendRuntimeTurnRequest,
  type RuntimeSendQueueItemDto,
} from '../src/index.ts';

function makeItem(over: Partial<RuntimeSendQueueItemDto> = {}): RuntimeSendQueueItemDto {
  return {
    id: 'q1',
    clientMessageId: 'cm1',
    text: 'hello',
    status: 'queued_busy',
    createdAt: 1,
    updatedAt: 2,
    deliveryAttempts: 0,
    failureReason: null,
    ...over,
  };
}

test('RUNTIME_SEND_STATUSES is exactly the 8 existing strings', () => {
  assert.deepEqual([...RUNTIME_SEND_STATUSES], [
    'queued_busy',
    'queued_spawning',
    'queued_backlog',
    'delivering',
    'delivered_to_pty',
    'observed_in_jsonl',
    'failed',
    'cancelled',
  ]);
});

test('isRuntimeSendStatus accepts the 8, rejects others', () => {
  for (const s of RUNTIME_SEND_STATUSES) assert.equal(isRuntimeSendStatus(s), true);
  assert.equal(isRuntimeSendStatus('queued'), false);
  assert.equal(isRuntimeSendStatus(null), false);
});

test('isRuntimeSendQueueItemDto round-trips PublicSendQueueItem; no projectId/sessionId required', () => {
  assert.equal(isRuntimeSendQueueItemDto(makeItem()), true);
  assert.equal(isRuntimeSendQueueItemDto(makeItem({ status: 'failed', failureReason: 'boom' })), true);
  assert.equal(isRuntimeSendQueueItemDto(makeItem({ status: 'nope' as never })), false);
  assert.equal(isRuntimeSendQueueItemDto({ ...makeItem(), deliveryAttempts: '0' }), false);
});

test('isRuntimeTurnSource accepts the four sources', () => {
  assert.equal(isRuntimeTurnSource('user'), true);
  assert.equal(isRuntimeTurnSource('mailbox'), true);
  assert.equal(isRuntimeTurnSource('workflow'), true);
  assert.equal(isRuntimeTurnSource('system'), true);
  assert.equal(isRuntimeTurnSource('agent'), false);
});

test('parseSendRuntimeTurnRequest validates and accepts optional sessionId/sourceRef', () => {
  const ok = parseSendRuntimeTurnRequest({
    projectId: 'p1',
    clientMessageId: 'cm1',
    text: 'hi',
    source: 'mailbox',
    sourceRef: 'msg-9',
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.source, 'mailbox');
    assert.equal(ok.value.sourceRef, 'msg-9');
  }

  assert.equal(parseSendRuntimeTurnRequest({ clientMessageId: 'cm', text: 't', source: 'user' }).ok, false);
  assert.equal(parseSendRuntimeTurnRequest({ projectId: 'p', text: 't', source: 'user' }).ok, false);
  assert.equal(parseSendRuntimeTurnRequest({ projectId: 'p', clientMessageId: 'c', text: '', source: 'user' }).ok, false);
  assert.equal(parseSendRuntimeTurnRequest({ projectId: 'p', clientMessageId: 'c', text: 't', source: 'bad' }).ok, false);
});
