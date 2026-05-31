import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLiveEventFrame,
  isMailboxDeliveryChangedLiveEvent,
  isMailboxDeliveryChangedLiveEventFrame,
  isMailboxDeliveryDto,
  isMailboxMessageChangedLiveEvent,
  isMailboxMessageChangedLiveEventFrame,
  isMailboxMessageDto,
  isMailboxRecipientDto,
  parseEnqueueMailboxMessageRequest,
  parseListMailboxQuery,
  parseMailboxAddress,
  type MailboxAddress,
  type MailboxDeliveryChangedLiveEvent,
  type MailboxMessageChangedLiveEvent,
} from '../src/index.ts';

test('parseMailboxAddress accepts every kind and rejects missing ids', () => {
  assert.equal(parseMailboxAddress({ kind: 'user-inbox', userId: 'local-user', projectId: null }).ok, true);
  assert.equal(parseMailboxAddress({ kind: 'user-inbox', userId: 'local-user', projectId: 'p1' }).ok, true);
  assert.equal(parseMailboxAddress({ kind: 'user-inbox', userId: 'someone', projectId: null }).ok, false);
  assert.equal(parseMailboxAddress({ kind: 'project-inbox', projectId: 'p1' }).ok, true);
  assert.equal(parseMailboxAddress({ kind: 'project-inbox' }).ok, false);
  assert.equal(parseMailboxAddress({ kind: 'active-orchestrator', projectId: 'p1' }).ok, true);
  assert.equal(
    parseMailboxAddress({ kind: 'orchestrator-session', projectId: 'p1', sessionId: 's1' }).ok,
    true,
  );
  assert.equal(parseMailboxAddress({ kind: 'orchestrator-session', projectId: 'p1' }).ok, false);
  assert.equal(parseMailboxAddress({ kind: 'agent-run', projectId: 'p1', agentRunId: 'r1' }).ok, true);
  assert.equal(parseMailboxAddress({ kind: 'agent-run', projectId: 'p1' }).ok, false);
  assert.equal(
    parseMailboxAddress({ kind: 'workflow-review', projectId: 'p1', workflowRunId: 'w1', nodeId: 'n1' }).ok,
    true,
  );
  assert.equal(parseMailboxAddress({ kind: 'workflow-review', projectId: 'p1', workflowRunId: 'w1' }).ok, false);
  assert.equal(parseMailboxAddress({ kind: 'nope' }).ok, false);
});

test('parseEnqueueMailboxMessageRequest validates kind/body/idempotency/recipients', () => {
  const ok = parseEnqueueMailboxMessageRequest({
    kind: 'system-notice',
    body: 'hello',
    idempotencyKey: 'k1',
    recipients: [{ address: { kind: 'project-inbox', projectId: 'p1' }, channel: 'ui-inbox' }],
  });
  assert.equal(ok.ok, true);

  assert.equal(
    parseEnqueueMailboxMessageRequest({
      kind: 'system-notice',
      body: 'x',
      idempotencyKey: '',
      recipients: [{ address: { kind: 'project-inbox', projectId: 'p1' }, channel: 'ui-inbox' }],
    }).ok,
    false,
  );
  assert.equal(
    parseEnqueueMailboxMessageRequest({
      kind: 'system-notice',
      body: 'x',
      idempotencyKey: 'k',
      recipients: [],
    }).ok,
    false,
  );
  assert.equal(
    parseEnqueueMailboxMessageRequest({
      kind: 'system-notice',
      body: 'x',
      idempotencyKey: 'k',
      recipients: [{ address: { kind: 'project-inbox' }, channel: 'ui-inbox' }],
    }).ok,
    false,
  );
  assert.equal(
    parseEnqueueMailboxMessageRequest({
      kind: 'system-notice',
      body: 'x',
      idempotencyKey: 'k',
      recipients: [{ address: { kind: 'project-inbox', projectId: 'p1' }, channel: 'bogus' }],
    }).ok,
    false,
  );
});

test('parseListMailboxQuery reads unread/actionable flags', () => {
  assert.deepEqual(parseListMailboxQuery({ unreadOnly: '1' }), {
    ok: true,
    value: { unreadOnly: true },
  });
  assert.deepEqual(parseListMailboxQuery({}), { ok: true, value: {} });
  assert.deepEqual(parseListMailboxQuery({ actionableOnly: true }), {
    ok: true,
    value: { actionableOnly: true },
  });
});

test('DTO guards', () => {
  const address: MailboxAddress = { kind: 'project-inbox', projectId: 'p1' };
  assert.equal(
    isMailboxMessageDto({
      id: 'm1',
      projectId: 'p1',
      kind: 'system-notice',
      subject: null,
      body: 'hi',
      payload: {},
      source: { kind: 'system', id: null },
      interactionId: null,
      idempotencyKey: 'k',
      createdAt: 1,
      updatedAt: 1,
    }),
    true,
  );
  assert.equal(isMailboxMessageDto({ id: 'm1', kind: 'bogus' }), false);
  assert.equal(
    isMailboxRecipientDto({
      id: 'r1',
      messageId: 'm1',
      address,
      readAt: null,
      actionedAt: null,
      dismissedAt: null,
    }),
    true,
  );
  assert.equal(
    isMailboxDeliveryDto({
      id: 'd1',
      messageId: 'm1',
      recipientId: 'r1',
      channel: 'ui-inbox',
      status: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      targetRef: { kind: null, id: null },
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    }),
    true,
  );
});

function messageEvent(over: Partial<MailboxMessageChangedLiveEvent> = {}): MailboxMessageChangedLiveEvent {
  return {
    id: 'e1',
    cursor: '1',
    scope: 'project',
    projectId: 'p1',
    type: 'mailbox.message.changed',
    entity: 'mailbox-message',
    entityId: 'm1',
    version: null,
    createdAt: 1,
    payload: {
      messageId: 'm1',
      kind: 'system-notice',
      recipientSummary: { total: 1, unread: 1, actionable: 0 },
    },
    ...over,
  };
}

test('mailbox.message.changed guard accepts project and global scope', () => {
  assert.equal(isMailboxMessageChangedLiveEvent(messageEvent()), true);
  // global (project-less) variant
  assert.equal(
    isMailboxMessageChangedLiveEvent(messageEvent({ scope: 'global', projectId: null })),
    true,
  );
  assert.equal(isMailboxMessageChangedLiveEventFrame(buildLiveEventFrame(messageEvent())), true);
  assert.equal(isMailboxMessageChangedLiveEvent({ ...messageEvent(), entity: 'project' }), false);
});

function deliveryEvent(over: Partial<MailboxDeliveryChangedLiveEvent> = {}): MailboxDeliveryChangedLiveEvent {
  return {
    id: 'e2',
    cursor: '2',
    scope: 'project',
    projectId: 'p1',
    type: 'mailbox.delivery.changed',
    entity: 'mailbox-message',
    entityId: 'm1',
    version: 1,
    createdAt: 1,
    payload: {
      deliveryId: 'd1',
      messageId: 'm1',
      status: 'accepted',
      attempts: 1,
      targetRef: { kind: 'send-queue', id: 'sq1' },
      lastError: null,
    },
    ...over,
  };
}

test('mailbox.delivery.changed guard', () => {
  assert.equal(isMailboxDeliveryChangedLiveEvent(deliveryEvent()), true);
  assert.equal(isMailboxDeliveryChangedLiveEventFrame(buildLiveEventFrame(deliveryEvent())), true);
  assert.equal(isMailboxDeliveryChangedLiveEvent({ ...deliveryEvent(), payload: { deliveryId: 'd1' } }), false);
});
