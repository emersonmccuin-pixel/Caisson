import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MailboxService,
  type MailboxServiceDeps,
} from '../src/mailbox/index.ts';
import {
  isMailboxDeliveryChangedLiveEvent,
  isMailboxMessageChangedLiveEvent,
} from '@pc/contracts';
import type {
  DbExecutor,
  InsertLiveEventDraft,
  LiveOutboxEvent,
  MailboxDeliveryRow,
  MailboxMessageRow,
  MailboxRecipientRow,
} from '@pc/db';

let seq = 0;
function fakeInsert<TPayload>(_db: DbExecutor, draft: InsertLiveEventDraft<TPayload>): LiveOutboxEvent<TPayload> {
  seq += 1;
  return {
    id: `evt-${seq}` as never,
    cursor: String(seq),
    scope: draft.scope,
    projectId: draft.projectId,
    type: draft.type,
    entity: draft.entity,
    entityId: draft.entityId,
    version: draft.version,
    createdAt: 1000 + seq,
    payload: draft.payload,
  };
}

function message(over: Partial<MailboxMessageRow> = {}): MailboxMessageRow {
  return {
    id: 'm1' as never,
    projectId: 'p1' as never,
    kind: 'system-notice',
    subject: null,
    body: 'hi',
    payload: {},
    sourceKind: 'system',
    sourceId: null,
    idempotencyKey: 'k1',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function recipient(over: Partial<MailboxRecipientRow> = {}): MailboxRecipientRow {
  return {
    id: 'r1' as never,
    messageId: 'm1' as never,
    addressKind: 'project-inbox',
    addressJson: { kind: 'project-inbox', projectId: 'p1' },
    readAt: null,
    actionedAt: null,
    dismissedAt: null,
    createdAt: 1,
    ...over,
  };
}

function delivery(over: Partial<MailboxDeliveryRow> = {}): MailboxDeliveryRow {
  return {
    id: 'd1' as never,
    messageId: 'm1' as never,
    recipientId: 'r1' as never,
    channel: 'ui-inbox',
    status: 'pending',
    leaseOwner: null,
    leaseExpiresAt: null,
    attempts: 0,
    nextAttemptAt: 1,
    targetRefKind: null,
    targetRefId: null,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    acceptedAt: null,
    failedAt: null,
    ...over,
  };
}

function mailboxHarness(opts: { failTx?: boolean; msg?: MailboxMessageRow } = {}) {
  const inserted: InsertLiveEventDraft[] = [];
  const msg = opts.msg ?? message();
  const deps: MailboxServiceDeps = {
    transaction: (fn) => {
      if (opts.failTx) throw new Error('forced tx failure');
      return fn({} as DbExecutor);
    },
    insertLiveEvent: ((db, draft) => {
      inserted.push(draft as InsertLiveEventDraft);
      return fakeInsert(db, draft);
    }) as MailboxServiceDeps['insertLiveEvent'],
    enqueueMailboxMessage: () => ({
      message: msg,
      recipients: [recipient()],
      deliveries: [delivery()],
      created: true,
    }),
    getMailboxMessage: () => msg,
    listRecipientsForMessage: () => [recipient()],
    markDeliveryAccepted: () => delivery({ status: 'accepted', attempts: 1, targetRefKind: 'send-queue', targetRefId: 'sq1' }),
    markDeliveryRetrying: () => delivery({ status: 'retrying', attempts: 1, nextAttemptAt: 9999 }),
    markDeliveryDeadLettered: () => delivery({ status: 'dead-lettered', attempts: 3 }),
    markRecipientRead: () => recipient({ readAt: 5 }),
    markRecipientActioned: () => recipient({ actionedAt: 6 }),
    markRecipientDismissed: () => recipient({ dismissedAt: 7 }),
    writeAudit: () => undefined,
  };
  return { service: new MailboxService(deps), inserted };
}

test('enqueue emits one mailbox.message.changed (project scope) with recipient summary', () => {
  const { service, inserted } = mailboxHarness();
  const pub = service.enqueue({
    message: { id: 'm1' as never, projectId: 'p1' as never, kind: 'system-notice', body: 'hi', sourceKind: 'system', idempotencyKey: 'k1' },
    recipients: [{ id: 'r1' as never, addressKind: 'project-inbox', addressJson: {}, channel: 'ui-inbox', deliveryId: 'd1' as never }],
    now: 1,
  });
  assert.equal(inserted.length, 1);
  assert.equal(isMailboxMessageChangedLiveEvent(pub.liveEvent), true);
  assert.equal(pub.liveEvent.scope, 'project');
  assert.equal(pub.liveEvent.payload.recipientSummary.total, 1);
});

test('a project-less message emits scope:global + projectId:null', () => {
  const { service, inserted } = mailboxHarness({ msg: message({ projectId: null }) });
  const pub = service.enqueue({
    message: { id: 'm1' as never, projectId: null, kind: 'system-notice', body: 'hi', sourceKind: 'system', idempotencyKey: 'k1' },
    recipients: [{ id: 'r1' as never, addressKind: 'user-inbox', addressJson: {}, channel: 'ui-inbox', deliveryId: 'd1' as never }],
    now: 1,
  });
  assert.equal(pub.liveEvent.scope, 'global');
  assert.equal(pub.liveEvent.projectId, null);
  assert.equal(inserted.length, 1);
});

test('a rollback emits nothing (no orphan outbox row)', () => {
  const { service, inserted } = mailboxHarness({ failTx: true });
  assert.throws(() =>
    service.enqueue({
      message: { id: 'm1' as never, projectId: 'p1' as never, kind: 'system-notice', body: 'hi', sourceKind: 'system', idempotencyKey: 'k1' },
      recipients: [{ id: 'r1' as never, addressKind: 'project-inbox', addressJson: {}, channel: 'ui-inbox', deliveryId: 'd1' as never }],
      now: 1,
    }),
  );
  assert.equal(inserted.length, 0);
});

test('accept/retry/dead-letter each emit a mailbox.delivery.changed fact', () => {
  const accept = mailboxHarness();
  const a = accept.service.acceptDelivery({ deliveryId: 'd1' as never, targetRefKind: 'send-queue', targetRefId: 'sq1', now: 1 });
  assert.ok(a);
  assert.equal(isMailboxDeliveryChangedLiveEvent(a!.liveEvent), true);
  assert.equal(a!.liveEvent.payload.status, 'accepted');
  assert.equal(a!.liveEvent.payload.targetRef.id, 'sq1');
  // T3.1 — delivery frames key by the delivery row id, not the messageId, so
  // they no longer collide with the message fact on `mailbox-message::<id>`.
  assert.equal(a!.liveEvent.entityId, 'd1');
  // The payload still carries both ids; consumers read payload.messageId.
  assert.equal(a!.liveEvent.payload.messageId, 'm1');
  assert.equal(a!.liveEvent.payload.deliveryId, 'd1');

  const retry = mailboxHarness();
  const r = retry.service.retryDelivery({ deliveryId: 'd1' as never, lastError: 'boom', nextAttemptAt: 9999, now: 1 });
  assert.equal(r!.liveEvent.payload.status, 'retrying');

  const dl = mailboxHarness();
  const d = dl.service.deadLetterDelivery({ deliveryId: 'd1' as never, messageId: 'm1' as never, recipientId: 'r1' as never, reason: 'max', lastError: 'x', now: 1 });
  assert.equal(d!.liveEvent.payload.status, 'dead-lettered');
});

test('recipient read/action/dismiss re-emits the message fact', () => {
  const h = mailboxHarness();
  const read = h.service.markRead('r1' as never, 5);
  assert.ok(read);
  assert.equal(isMailboxMessageChangedLiveEvent(read!.liveEvent), true);
  // The message fact keeps the message id as its entityId.
  assert.equal(read!.liveEvent.entityId, 'm1');
});

test('T3.1 — message-fact and delivery frames for the same message use DISTINCT entityIds', () => {
  // Message fact: entityId = messageId. Delivery frame: entityId = deliveryId.
  // For the same message these must differ so the client live store keys them
  // on separate slots (`mailbox-message::m1` vs `mailbox-message::d1`) and they
  // no longer overwrite / mis-dedup against each other.
  const msgH = mailboxHarness();
  const msgFact = msgH.service.markRead('r1' as never, 5);
  assert.ok(msgFact);

  const delH = mailboxHarness();
  const delFact = delH.service.acceptDelivery({ deliveryId: 'd1' as never, targetRefKind: 'send-queue', targetRefId: 'sq1', now: 1 });
  assert.ok(delFact);

  assert.equal(msgFact!.liveEvent.entity, 'mailbox-message');
  assert.equal(delFact!.liveEvent.entity, 'mailbox-message');
  assert.notEqual(msgFact!.liveEvent.entityId, delFact!.liveEvent.entityId);
  assert.equal(msgFact!.liveEvent.entityId, 'm1');
  assert.equal(delFact!.liveEvent.entityId, 'd1');
});

// ☠ M8/FD-7: the PendingInteractionService tests are gone with the write-only
// shadow table (archived in migration 0045).
