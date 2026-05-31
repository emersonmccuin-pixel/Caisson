import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isConversationKind,
  isConversationSessionDto,
  type ConversationSessionDto,
} from '../src/index.ts';

function makeSession(over: Partial<ConversationSessionDto> = {}): ConversationSessionDto {
  return {
    id: 's1',
    projectId: 'p1',
    provider: 'claude',
    providerSessionId: 'uuid-1',
    model: 'opus',
    title: 'Chat',
    status: 'active',
    endedReason: null,
    startedAt: 100,
    endedAt: null,
    jsonlPath: '/x/y.jsonl',
    jsonlLineCursor: 5,
    ...over,
  };
}

test('isConversationKind accepts the three read-surface kinds, rejects others', () => {
  assert.equal(isConversationKind('orchestrator-session'), true);
  assert.equal(isConversationKind('agent-run'), true);
  assert.equal(isConversationKind('subagent-transcript'), true);
  assert.equal(isConversationKind('workflow'), false);
  assert.equal(isConversationKind(7), false);
});

test('isConversationSessionDto round-trips a mirror of OrchestratorSession', () => {
  assert.equal(isConversationSessionDto(makeSession()), true);
  assert.equal(isConversationSessionDto(makeSession({ status: 'ended', endedReason: 'pty_exit', endedAt: 200 })), true);
  assert.equal(isConversationSessionDto(makeSession({ providerSessionId: null, model: null, title: null, jsonlPath: null })), true);
});

test('isConversationSessionDto rejects bad status / ended reason / missing cursor', () => {
  assert.equal(isConversationSessionDto(makeSession({ status: 'paused' as never })), false);
  assert.equal(isConversationSessionDto(makeSession({ endedReason: 'nope' as never })), false);
  assert.equal(isConversationSessionDto({ ...makeSession(), jsonlLineCursor: undefined }), false);
  assert.equal(isConversationSessionDto(null), false);
});

test('the DTO does NOT widen the wire: deletedAt is not part of the contract', () => {
  // A row carrying deletedAt is still a valid DTO (extra keys ignored), but the
  // contract type has no deletedAt member — guarded structurally by the type.
  const withExtra = { ...makeSession(), deletedAt: 123 } as unknown;
  assert.equal(isConversationSessionDto(withExtra), true);
});
