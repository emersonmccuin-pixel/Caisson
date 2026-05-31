import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLiveEventFrame,
  isPendingInteractionChangedLiveEvent,
  isPendingInteractionChangedLiveEventFrame,
  isPendingInteractionDto,
  parseAnswerPendingInteractionRequest,
  type PendingInteractionChangedLiveEvent,
} from '../src/index.ts';

test('isPendingInteractionDto guard', () => {
  assert.equal(
    isPendingInteractionDto({
      id: 'i1',
      projectId: 'p1',
      kind: 'runtime-hook-ask',
      status: 'open',
      source: { kind: 'runtime-hook', id: 'tool-1' },
      prompt: 'pick',
      context: null,
      options: [{ value: 'a', label: 'A' }],
      answer: null,
      answeredBy: null,
      createdAt: 1,
      answeredAt: null,
      cancelledAt: null,
      version: 1,
    }),
    true,
  );
  assert.equal(isPendingInteractionDto({ id: 'i1', kind: 'bogus' }), false);
});

test('parseAnswerPendingInteractionRequest', () => {
  assert.deepEqual(parseAnswerPendingInteractionRequest({ answer: 'yes', answeredBy: 'user' }), {
    ok: true,
    value: { answer: 'yes', answeredBy: 'user' },
  });
  assert.equal(parseAnswerPendingInteractionRequest({ answer: '' }).ok, false);
  assert.equal(parseAnswerPendingInteractionRequest({ answer: 'x', answeredBy: 'nobody' }).ok, false);
});

function interactionEvent(
  over: Partial<PendingInteractionChangedLiveEvent> = {},
): PendingInteractionChangedLiveEvent {
  return {
    id: 'e1',
    cursor: '1',
    scope: 'project',
    projectId: 'p1',
    type: 'pending-interaction.changed',
    entity: 'pending-interaction',
    entityId: 'i1',
    version: 2,
    createdAt: 1,
    payload: { interactionId: 'i1', kind: 'runtime-hook-ask', status: 'answered', version: 2 },
    ...over,
  };
}

test('pending-interaction.changed guard is project-scoped', () => {
  assert.equal(isPendingInteractionChangedLiveEvent(interactionEvent()), true);
  assert.equal(
    isPendingInteractionChangedLiveEventFrame(buildLiveEventFrame(interactionEvent())),
    true,
  );
  // project-scoped only — a global variant is rejected by the guard.
  assert.equal(
    isPendingInteractionChangedLiveEvent({ ...interactionEvent(), scope: 'global', projectId: null }),
    false,
  );
});
