// Slice 007 — mailbox repo (messages, recipients, deliveries, dead-letters,
// audit). Additive + alongside Channel; no cutover this slice.
//
// Core model:
//   - Enqueue writes message + recipients + deliveries (+ audit) in ONE tx,
//     idempotent by `idempotency_key` (a replay returns the existing message).
//   - Lease acquire is an atomic conditional UPDATE: only the pass that wins the
//     `WHERE status IN ('pending','retrying') AND lease free AND due` owns the
//     row. An expired lease is reclaimable (the predicate lets a later pass win).
//   - Accept / retry-backoff / dead-letter are explicit transitions.
//   - Recipient read/action/dismiss is recipient state, NOT delivery state.

import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { ULID } from '@pc/domain';
import { getDb } from '../connection.ts';
import type { DbExecutor } from '../connection.ts';
import {
  mailboxAudit,
  mailboxDeadLetters,
  mailboxDeliveries,
  mailboxMessages,
  mailboxRecipients,
} from '../schema.ts';

export type MailboxMessageRow = typeof mailboxMessages.$inferSelect;
export type MailboxRecipientRow = typeof mailboxRecipients.$inferSelect;
export type MailboxDeliveryRow = typeof mailboxDeliveries.$inferSelect;
export type MailboxDeadLetterRow = typeof mailboxDeadLetters.$inferSelect;
export type MailboxAuditRow = typeof mailboxAudit.$inferSelect;

export type MailboxDeliveryStatus =
  | 'pending'
  | 'leased'
  | 'accepted'
  | 'retrying'
  | 'failed'
  | 'dead-lettered'
  | 'cancelled';

export interface EnqueueMailboxRecipientRow {
  id: ULID;
  addressKind: string;
  addressJson: Record<string, unknown>;
  channel: string;
  deliveryId: ULID;
}

export interface EnqueueMailboxMessageInput {
  message: {
    id: ULID;
    projectId: ULID | null;
    kind: string;
    subject?: string | null;
    body: string;
    payload?: Record<string, unknown>;
    sourceKind: string;
    sourceId?: string | null;
    interactionId?: ULID | null;
    idempotencyKey: string;
  };
  recipients: EnqueueMailboxRecipientRow[];
  now: number;
}

export interface EnqueueMailboxMessageResult {
  message: MailboxMessageRow;
  recipients: MailboxRecipientRow[];
  deliveries: MailboxDeliveryRow[];
  created: boolean;
}

/** Idempotent enqueue. A replayed `idempotency_key` returns the existing
 *  message/recipients/deliveries (`created:false`) and writes nothing. Caller
 *  runs this inside its outbox transaction so the live_outbox row commits
 *  atomically with the product rows. */
export function enqueueMailboxMessage(
  input: EnqueueMailboxMessageInput,
  db: DbExecutor = getDb(),
): EnqueueMailboxMessageResult {
  const existing = getMailboxMessageByIdempotencyKey(input.message.idempotencyKey, db);
  if (existing) {
    return {
      message: existing,
      recipients: listRecipientsForMessage(existing.id, db),
      deliveries: listDeliveriesForMessage(existing.id, db),
      created: false,
    };
  }

  db.insert(mailboxMessages)
    .values({
      id: input.message.id,
      projectId: input.message.projectId,
      kind: input.message.kind,
      subject: input.message.subject ?? null,
      body: input.message.body,
      payload: input.message.payload ?? {},
      sourceKind: input.message.sourceKind,
      sourceId: input.message.sourceId ?? null,
      interactionId: input.message.interactionId ?? null,
      idempotencyKey: input.message.idempotencyKey,
      createdAt: input.now,
      updatedAt: input.now,
      expiresAt: null,
    })
    .run();

  for (const r of input.recipients) {
    db.insert(mailboxRecipients)
      .values({
        id: r.id,
        messageId: input.message.id,
        addressKind: r.addressKind,
        addressJson: r.addressJson,
        readAt: null,
        actionedAt: null,
        dismissedAt: null,
        createdAt: input.now,
      })
      .run();
    db.insert(mailboxDeliveries)
      .values({
        id: r.deliveryId,
        messageId: input.message.id,
        recipientId: r.id,
        channel: r.channel,
        status: 'pending',
        leaseOwner: null,
        leaseExpiresAt: null,
        attempts: 0,
        nextAttemptAt: input.now,
        targetRefKind: null,
        targetRefId: null,
        lastError: null,
        createdAt: input.now,
        updatedAt: input.now,
        acceptedAt: null,
        failedAt: null,
      })
      .run();
  }

  writeAudit(
    {
      messageId: input.message.id,
      action: 'enqueued',
      actorKind: 'system',
      actorId: input.message.sourceKind,
      now: input.now,
    },
    db,
  );

  return {
    message: getMailboxMessage(input.message.id, db)!,
    recipients: listRecipientsForMessage(input.message.id, db),
    deliveries: listDeliveriesForMessage(input.message.id, db),
    created: true,
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

export function getMailboxMessage(id: ULID, db: DbExecutor = getDb()): MailboxMessageRow | null {
  return db.select().from(mailboxMessages).where(eq(mailboxMessages.id, id)).get() ?? null;
}

export function getMailboxMessageByIdempotencyKey(
  key: string,
  db: DbExecutor = getDb(),
): MailboxMessageRow | null {
  return (
    db.select().from(mailboxMessages).where(eq(mailboxMessages.idempotencyKey, key)).get() ?? null
  );
}

export function getMailboxRecipient(
  id: ULID,
  db: DbExecutor = getDb(),
): MailboxRecipientRow | null {
  return db.select().from(mailboxRecipients).where(eq(mailboxRecipients.id, id)).get() ?? null;
}

export function getMailboxDelivery(
  id: ULID,
  db: DbExecutor = getDb(),
): MailboxDeliveryRow | null {
  return db.select().from(mailboxDeliveries).where(eq(mailboxDeliveries.id, id)).get() ?? null;
}

export function listRecipientsForMessage(
  messageId: ULID,
  db: DbExecutor = getDb(),
): MailboxRecipientRow[] {
  return db
    .select()
    .from(mailboxRecipients)
    .where(eq(mailboxRecipients.messageId, messageId))
    .orderBy(asc(mailboxRecipients.createdAt), asc(mailboxRecipients.id))
    .all();
}

export function listDeliveriesForMessage(
  messageId: ULID,
  db: DbExecutor = getDb(),
): MailboxDeliveryRow[] {
  return db
    .select()
    .from(mailboxDeliveries)
    .where(eq(mailboxDeliveries.messageId, messageId))
    .orderBy(asc(mailboxDeliveries.createdAt), asc(mailboxDeliveries.id))
    .all();
}

/** Recipients addressed to a given address kind for a project (or the global
 *  user-inbox when projectId is null). Joins to the parent message for project
 *  scoping. Ordered by message createdAt then id. */
export function listRecipientsForInbox(
  input: { projectId: ULID | null; addressKinds?: string[] },
  db: DbExecutor = getDb(),
): { recipient: MailboxRecipientRow; message: MailboxMessageRow }[] {
  const messages = db
    .select()
    .from(mailboxMessages)
    .where(input.projectId === null ? isNull(mailboxMessages.projectId) : eq(mailboxMessages.projectId, input.projectId))
    .orderBy(asc(mailboxMessages.createdAt), asc(mailboxMessages.id))
    .all();
  const out: { recipient: MailboxRecipientRow; message: MailboxMessageRow }[] = [];
  for (const message of messages) {
    for (const recipient of listRecipientsForMessage(message.id, db)) {
      if (input.addressKinds && !input.addressKinds.includes(recipient.addressKind)) continue;
      out.push({ recipient, message });
    }
  }
  return out;
}

export function listDeliveriesForProject(
  projectId: ULID,
  db: DbExecutor = getDb(),
): MailboxDeliveryRow[] {
  const messages = db
    .select({ id: mailboxMessages.id })
    .from(mailboxMessages)
    .where(eq(mailboxMessages.projectId, projectId))
    .all();
  if (messages.length === 0) return [];
  return db
    .select()
    .from(mailboxDeliveries)
    .where(
      inArray(
        mailboxDeliveries.messageId,
        messages.map((m) => m.id),
      ),
    )
    .orderBy(asc(mailboxDeliveries.createdAt), asc(mailboxDeliveries.id))
    .all();
}

// ── Lease / delivery transitions ──────────────────────────────────────────────

/** Atomic exclusive lease acquire. Stamps lease_owner + lease_expires_at and
 *  flips to `leased` ONLY when the row is due and the lease is free/expired.
 *  Returns the leased row if THIS pass won, else null. Restart-safe: an expired
 *  lease (`lease_expires_at <= now`) is reclaimable by a later pass. */
export function acquireDeliveryLease(
  input: { deliveryId: ULID; owner: string; now: number; leaseMs: number },
  db: DbExecutor = getDb(),
): MailboxDeliveryRow | null {
  const res = db
    .update(mailboxDeliveries)
    .set({
      status: 'leased',
      leaseOwner: input.owner,
      leaseExpiresAt: input.now + input.leaseMs,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(mailboxDeliveries.id, input.deliveryId),
        inArray(mailboxDeliveries.status, ['pending', 'retrying']),
        or(isNull(mailboxDeliveries.leaseExpiresAt), lte(mailboxDeliveries.leaseExpiresAt, input.now)),
        or(isNull(mailboxDeliveries.nextAttemptAt), lte(mailboxDeliveries.nextAttemptAt, input.now)),
      ),
    )
    .run();
  return res.changes > 0 ? getMailboxDelivery(input.deliveryId, db) : null;
}

/** Deliveries that are due for a worker pass (pending/retrying, due, lease
 *  free/expired). Ordered by created_at + id for FIFO/deterministic ordering. */
export function listDueDeliveries(
  now: number,
  limit = 50,
  db: DbExecutor = getDb(),
): MailboxDeliveryRow[] {
  return db
    .select()
    .from(mailboxDeliveries)
    .where(
      and(
        inArray(mailboxDeliveries.status, ['pending', 'retrying']),
        or(isNull(mailboxDeliveries.leaseExpiresAt), lte(mailboxDeliveries.leaseExpiresAt, now)),
        or(isNull(mailboxDeliveries.nextAttemptAt), lte(mailboxDeliveries.nextAttemptAt, now)),
      ),
    )
    .orderBy(asc(mailboxDeliveries.createdAt), asc(mailboxDeliveries.id))
    .limit(limit)
    .all();
}

export function markDeliveryAccepted(
  input: { deliveryId: ULID; targetRefKind: string | null; targetRefId: string | null; now: number },
  db: DbExecutor = getDb(),
): MailboxDeliveryRow | null {
  db.update(mailboxDeliveries)
    .set({
      status: 'accepted',
      leaseOwner: null,
      leaseExpiresAt: null,
      attempts: sql`${mailboxDeliveries.attempts} + 1`,
      targetRefKind: input.targetRefKind,
      targetRefId: input.targetRefId,
      lastError: null,
      acceptedAt: input.now,
      updatedAt: input.now,
    })
    .where(eq(mailboxDeliveries.id, input.deliveryId))
    .run();
  return getMailboxDelivery(input.deliveryId, db);
}

export function markDeliveryRetrying(
  input: { deliveryId: ULID; lastError: string; nextAttemptAt: number; now: number },
  db: DbExecutor = getDb(),
): MailboxDeliveryRow | null {
  db.update(mailboxDeliveries)
    .set({
      status: 'retrying',
      leaseOwner: null,
      leaseExpiresAt: null,
      attempts: sql`${mailboxDeliveries.attempts} + 1`,
      nextAttemptAt: input.nextAttemptAt,
      lastError: input.lastError,
      updatedAt: input.now,
    })
    .where(eq(mailboxDeliveries.id, input.deliveryId))
    .run();
  return getMailboxDelivery(input.deliveryId, db);
}

export function markDeliveryDeadLettered(
  input: { deliveryId: ULID; messageId: ULID; recipientId: ULID; reason: string; lastError: string | null; now: number },
  db: DbExecutor = getDb(),
): MailboxDeliveryRow | null {
  db.update(mailboxDeliveries)
    .set({
      status: 'dead-lettered',
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: input.lastError,
      failedAt: input.now,
      updatedAt: input.now,
    })
    .where(eq(mailboxDeliveries.id, input.deliveryId))
    .run();
  db.insert(mailboxDeadLetters)
    .values({
      id: `${input.deliveryId}:dl` as ULID,
      messageId: input.messageId,
      recipientId: input.recipientId,
      deliveryId: input.deliveryId,
      reason: input.reason,
      lastError: input.lastError,
      createdAt: input.now,
    })
    .run();
  return getMailboxDelivery(input.deliveryId, db);
}

export function listDeadLettersForMessage(
  messageId: ULID,
  db: DbExecutor = getDb(),
): MailboxDeadLetterRow[] {
  return db
    .select()
    .from(mailboxDeadLetters)
    .where(eq(mailboxDeadLetters.messageId, messageId))
    .all();
}

// ── Recipient UI state (separate from delivery status) ────────────────────────

export function markRecipientRead(
  id: ULID,
  now: number,
  db: DbExecutor = getDb(),
): MailboxRecipientRow | null {
  db.update(mailboxRecipients)
    .set({ readAt: now })
    .where(and(eq(mailboxRecipients.id, id), isNull(mailboxRecipients.readAt)))
    .run();
  return getMailboxRecipient(id, db);
}

export function markRecipientActioned(
  id: ULID,
  now: number,
  db: DbExecutor = getDb(),
): MailboxRecipientRow | null {
  db.update(mailboxRecipients)
    .set({ actionedAt: now, readAt: sql`COALESCE(${mailboxRecipients.readAt}, ${now})` })
    .where(eq(mailboxRecipients.id, id))
    .run();
  return getMailboxRecipient(id, db);
}

export function markRecipientDismissed(
  id: ULID,
  now: number,
  db: DbExecutor = getDb(),
): MailboxRecipientRow | null {
  db.update(mailboxRecipients)
    .set({ dismissedAt: now, readAt: sql`COALESCE(${mailboxRecipients.readAt}, ${now})` })
    .where(eq(mailboxRecipients.id, id))
    .run();
  return getMailboxRecipient(id, db);
}

// ── Audit ──────────────────────────────────────────────────────────────────────

export interface WriteAuditInput {
  messageId?: ULID | null;
  recipientId?: ULID | null;
  deliveryId?: ULID | null;
  action: string;
  actorKind: string;
  actorId?: string | null;
  details?: Record<string, unknown> | null;
  now: number;
}

export function writeAudit(input: WriteAuditInput, db: DbExecutor = getDb()): void {
  db.insert(mailboxAudit)
    .values({
      id: `${input.messageId ?? input.deliveryId ?? 'mb'}:${input.action}:${input.now}:${Math.random().toString(36).slice(2, 8)}` as ULID,
      messageId: input.messageId ?? null,
      recipientId: input.recipientId ?? null,
      deliveryId: input.deliveryId ?? null,
      action: input.action,
      actorKind: input.actorKind,
      actorId: input.actorId ?? null,
      details: input.details ?? null,
      createdAt: input.now,
    })
    .run();
}

export function listAuditForMessage(
  messageId: ULID,
  db: DbExecutor = getDb(),
): MailboxAuditRow[] {
  return db
    .select()
    .from(mailboxAudit)
    .where(eq(mailboxAudit.messageId, messageId))
    .orderBy(asc(mailboxAudit.createdAt))
    .all();
}
