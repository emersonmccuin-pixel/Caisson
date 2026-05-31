import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MailboxService,
  PendingInteractionService,
  type MailboxServiceDeps,
  type PendingInteractionServiceDeps,
} from '../src/mailbox/index.ts';
import {
  isMailboxDeliveryChangedLiveEvent,
  isMailboxMessageChangedLiveEvent,
  isPendingInteractionChangedLiveEvent,
} from '@pc/contracts';
import type {
  DbExecutor,
  InsertLiveEventDraft,
  LiveOutboxEvent,
  MailboxDeliveryRow,
  MailboxMessageRow,
  MailboxRecipientRow,
  PendingInteractionRow,
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
    interactionId: null,
    idempotencyKey: 'k1',
    createdAt: 1,
    updatedAt: 1,
    expiresAt: null,
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
});

// ── pending interaction service ──────────────────────────────────────────────

function interaction(over: Partial<PendingInteractionRow> = {}): PendingInteractionRow {
  return {
    id: 'i1' as never,
    projectId: 'p1' as never,
    kind: 'runtime-hook-ask',
    status: 'open',
    sourceKind: 'runtime-hook',
    sourceId: 'tool-1',
    sourceRef: null,
    prompt: 'pick',
    context: null,
    options: null,
    answerBody: null,
    answeredBy: null,
    createdAt: 1,
    updatedAt: 1,
    answeredAt: null,
    cancelledAt: null,
    expiresAt: null,
    version: 1,
    ...over,
  };
}

function interactionHarness(opts: { answered?: PendingInteractionRow | null } = {}) {
  const inserted: InsertLiveEventDraft[] = [];
  const deps: PendingInteractionServiceDeps = {
    transaction: (fn) => fn({} as DbExecutor),
    insertLiveEvent: ((db, draft) => {
      inserted.push(draft as InsertLiveEventDraft);
      return fakeInsert(db, draft);
    }) as PendingInteractionServiceDeps['insertLiveEvent'],
    createPendingInteraction: () => interaction(),
    answerPendingInteraction: () =>
      opts.answered === undefined ? interaction({ status: 'answered', version: 2, answerBody: 'yes' }) : opts.answered,
  };
  return { service: new PendingInteractionService(deps), inserted };
}

test('create + answer emit pending-interaction.changed with version', () => {
  const h = interactionHarness();
  const created = h.service.create({
    id: 'i1' as never,
    projectId: 'p1' as never,
    kind: 'runtime-hook-ask',
    sourceKind: 'runtime-hook',
    sourceId: 'tool-1',
    prompt: 'pick',
    now: 1,
  });
  assert.equal(isPendingInteractionChangedLiveEvent(created.liveEvent), true);
  assert.equal(created.liveEvent.payload.status, 'open');

  const answered = h.service.answer({ id: 'i1' as never, answer: 'yes', answeredBy: 'user', now: 2 });
  assert.ok(answered);
  assert.equal(answered!.liveEvent.payload.status, 'answered');
  assert.equal(answered!.liveEvent.version, 2);
});

test('a no-op terminal flip (replayed answer) emits nothing', () => {
  const h = interactionHarness({ answered: null });
  const res = h.service.answer({ id: 'i1' as never, answer: 'yes', answeredBy: 'user', now: 2 });
  assert.equal(res, null);
  assert.equal(h.inserted.length, 0);
});
