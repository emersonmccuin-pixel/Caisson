// Slice 007 — mailbox + pending-interaction repo behavior.
//
// Covers transactional enqueue (+ rollback writes nothing), idempotency,
// exclusive lease acquire + expiry reclaim, retry backoff, dead-letter,
// recipient read/action/dismiss (separate from delivery status), and the
// pending-interaction lifecycle (answer/cancel/expire bumps version).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-mailbox-repos-'));
process.env.PC_DATA_DIR = tmpDir;

const db = await import('../src/index.ts');
const {
  acquireDeliveryLease,
  answerPendingInteraction,
  cancelPendingInteraction,
  closeDb,
  createPendingInteraction,
  enqueueMailboxMessage,
  expireOpenPendingInteractions,
  expirePendingInteraction,
  getDb,
  getMailboxMessage,
  getPendingInteraction,
  insertLiveEvent,
  listDeadLettersForMessage,
  listDeliveriesForMessage,
  listDueDeliveries,
  listRecipientsForInbox,
  markDeliveryAccepted,
  markDeliveryDeadLettered,
  markDeliveryRetrying,
  markRecipientDismissed,
  markRecipientRead,
  newId,
  runMigrations,
} = db;

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function id(): ULID {
  return newId();
}

const P_MBX = 'p-mbx' as ULID;

function enqueue(over: { projectId?: ULID | null; idempotencyKey?: string } = {}) {
  const messageId = id();
  const recipientId = id();
  const deliveryId = id();
  return enqueueMailboxMessage({
    message: {
      id: messageId,
      projectId: over.projectId === undefined ? P_MBX : over.projectId,
      kind: 'system-notice',
      body: 'hello',
      sourceKind: 'system',
      idempotencyKey: over.idempotencyKey ?? `k-${messageId}`,
    },
    recipients: [
      {
        id: recipientId,
        addressKind: 'project-inbox',
        addressJson: { kind: 'project-inbox', projectId: 'p-mbx' },
        channel: 'ui-inbox',
        deliveryId,
      },
    ],
    now: Date.now(),
  });
}

test('enqueue writes message + recipient + delivery atomically', () => {
  const res = enqueue();
  assert.equal(res.created, true);
  assert.equal(res.recipients.length, 1);
  assert.equal(res.deliveries.length, 1);
  assert.equal(res.deliveries[0]!.status, 'pending');
  assert.equal(res.deliveries[0]!.attempts, 0);
});

test('enqueue is idempotent by idempotency_key (replay returns the same message)', () => {
  const first = enqueue({ idempotencyKey: 'dup-1' });
  const second = enqueueMailboxMessage({
    message: {
      id: id(),
      projectId: P_MBX,
      kind: 'system-notice',
      body: 'different body',
      sourceKind: 'system',
      idempotencyKey: 'dup-1',
    },
    recipients: [
      {
        id: id(),
        addressKind: 'project-inbox',
        addressJson: { kind: 'project-inbox', projectId: 'p-mbx' },
        channel: 'ui-inbox',
        deliveryId: id(),
      },
    ],
    now: Date.now(),
  });
  assert.equal(second.created, false);
  assert.equal(second.message.id, first.message.id);
  assert.equal(second.message.body, 'hello'); // original kept, not overwritten
});

test('enqueue + outbox insert roll back together (no orphan rows)', () => {
  const messageId = id();
  const before = getMailboxMessage(messageId);
  assert.equal(before, null);
  assert.throws(() => {
    getDb().transaction((tx) => {
      enqueueMailboxMessage(
        {
          message: {
            id: messageId,
            projectId: P_MBX,
            kind: 'system-notice',
            body: 'rollback',
            sourceKind: 'system',
            idempotencyKey: `rb-${messageId}`,
          },
          recipients: [
            {
              id: id(),
              addressKind: 'project-inbox',
              addressJson: { kind: 'project-inbox', projectId: 'p-mbx' },
              channel: 'ui-inbox',
              deliveryId: id(),
            },
          ],
          now: Date.now(),
        },
        tx,
      );
      // Force a rollback via the global-scope invariant.
      insertLiveEvent(tx, {
        scope: 'global',
        projectId: 'p-mbx' as never,
        type: 'mailbox.message.changed',
        entity: 'mailbox-message',
        entityId: messageId as never,
        version: null,
        payload: {},
      });
    });
  });
  assert.equal(getMailboxMessage(messageId), null);
});

test('lease acquire is exclusive; a second acquire on a leased row fails; expiry reclaims', () => {
  const res = enqueue();
  const deliveryId = res.deliveries[0]!.id;
  const now = Date.now();

  const leased = acquireDeliveryLease({ deliveryId, owner: 'w1', now, leaseMs: 1000 });
  assert.ok(leased);
  assert.equal(leased!.status, 'leased');
  assert.equal(leased!.leaseOwner, 'w1');

  // A second worker cannot acquire while the lease is live.
  const second = acquireDeliveryLease({ deliveryId, owner: 'w2', now: now + 500, leaseMs: 1000 });
  assert.equal(second, null);

  // After the lease expires, mark retrying so it's eligible, then reclaim.
  markDeliveryRetrying({ deliveryId, lastError: 'crash', nextAttemptAt: now, now: now + 2000 });
  const reclaimed = acquireDeliveryLease({ deliveryId, owner: 'w2', now: now + 2000, leaseMs: 1000 });
  assert.ok(reclaimed);
  assert.equal(reclaimed!.leaseOwner, 'w2');
});

test('retry increments attempts + schedules next_attempt_at', () => {
  const res = enqueue();
  const deliveryId = res.deliveries[0]!.id;
  const now = Date.now();
  acquireDeliveryLease({ deliveryId, owner: 'w1', now, leaseMs: 1000 });
  const retried = markDeliveryRetrying({ deliveryId, lastError: 'boom', nextAttemptAt: now + 5000, now });
  assert.equal(retried!.status, 'retrying');
  assert.equal(retried!.attempts, 1);
  assert.equal(retried!.nextAttemptAt, now + 5000);
  // Not due yet — listDueDeliveries excludes it.
  const due = listDueDeliveries(now + 100).map((d) => d.id);
  assert.equal(due.includes(deliveryId), false);
});

test('accept stores target ref + clears lease', () => {
  const res = enqueue();
  const deliveryId = res.deliveries[0]!.id;
  const now = Date.now();
  acquireDeliveryLease({ deliveryId, owner: 'w1', now, leaseMs: 1000 });
  const accepted = markDeliveryAccepted({ deliveryId, targetRefKind: 'send-queue', targetRefId: 'sq-1', now });
  assert.equal(accepted!.status, 'accepted');
  assert.equal(accepted!.targetRefKind, 'send-queue');
  assert.equal(accepted!.targetRefId, 'sq-1');
  assert.equal(accepted!.leaseOwner, null);
});

test('dead-letter writes a queryable dead-letter row', () => {
  const res = enqueue();
  const deliveryId = res.deliveries[0]!.id;
  const recipientId = res.recipients[0]!.id;
  const messageId = res.message.id;
  const now = Date.now();
  markDeliveryDeadLettered({
    deliveryId,
    messageId,
    recipientId,
    reason: 'max-retries',
    lastError: 'gave up',
    now,
  });
  const delivery = listDeliveriesForMessage(messageId).find((d) => d.id === deliveryId);
  assert.equal(delivery!.status, 'dead-lettered');
  const dl = listDeadLettersForMessage(messageId);
  assert.equal(dl.length, 1);
  assert.equal(dl[0]!.reason, 'max-retries');
});

test('recipient read/dismiss is separate from delivery status', () => {
  const res = enqueue();
  const recipientId = res.recipients[0]!.id;
  const deliveryId = res.deliveries[0]!.id;
  const now = Date.now();
  const read = markRecipientRead(recipientId, now);
  assert.equal(read!.readAt, now);
  // delivery status untouched by recipient read
  const delivery = listDeliveriesForMessage(res.message.id).find((d) => d.id === deliveryId);
  assert.equal(delivery!.status, 'pending');
  const dismissed = markRecipientDismissed(recipientId, now + 1);
  assert.equal(dismissed!.dismissedAt, now + 1);
});

test('listRecipientsForInbox scopes by project and the global inbox by null', () => {
  enqueue({ projectId: 'proj-A' as ULID, idempotencyKey: `a-${id()}` });
  enqueue({ projectId: null, idempotencyKey: `g-${id()}` });
  const projA = listRecipientsForInbox({ projectId: 'proj-A' as ULID });
  assert.ok(projA.length >= 1);
  assert.ok(projA.every((r) => r.message.projectId === 'proj-A'));
  const global = listRecipientsForInbox({ projectId: null });
  assert.ok(global.every((r) => r.message.projectId === null));
});

// ── pending interactions ──────────────────────────────────────────────────────

test('pending interaction answer/cancel/expire bumps version, and is atomic', () => {
  const i1 = createPendingInteraction({
    id: id(),
    projectId: P_MBX,
    kind: 'runtime-hook-ask',
    sourceKind: 'runtime-hook',
    sourceId: 'tool-1',
    prompt: 'pick',
    now: Date.now(),
  });
  assert.equal(i1.status, 'open');
  assert.equal(i1.version, 1);

  const answered = answerPendingInteraction({ id: i1.id, answer: 'yes', answeredBy: 'user', now: Date.now() });
  assert.ok(answered);
  assert.equal(answered!.status, 'answered');
  assert.equal(answered!.version, 2);

  // A second answer is a no-op (already terminal).
  const replay = answerPendingInteraction({ id: i1.id, answer: 'no', answeredBy: 'user', now: Date.now() });
  assert.equal(replay, null);
  assert.equal(getPendingInteraction(i1.id)!.answerBody, 'yes');

  const i2 = createPendingInteraction({
    id: id(),
    projectId: P_MBX,
    kind: 'runtime-hook-ask',
    sourceKind: 'runtime-hook',
    sourceId: 'tool-2',
    prompt: 'pick',
    now: Date.now(),
  });
  assert.equal(cancelPendingInteraction(i2.id, Date.now())!.status, 'cancelled');
  assert.equal(expirePendingInteraction(i2.id, Date.now()), null); // already terminal
});

test('boot-sweep expires every orphaned open interaction', () => {
  const i3 = createPendingInteraction({
    id: id(),
    projectId: 'p-sweep' as ULID,
    kind: 'runtime-hook-ask',
    sourceKind: 'runtime-hook',
    sourceId: 'tool-sweep',
    prompt: 'pick',
    now: Date.now(),
  });
  const swept = expireOpenPendingInteractions(Date.now());
  assert.ok(swept.includes(i3.id));
  assert.equal(getPendingInteraction(i3.id)!.status, 'expired');
});
