// MailboxService (slice 007) — the single durable write door for mailbox
// message/recipient/delivery state changes the UI cares about. Mirrors the
// slice-005 AgentRunMutationGateway:
//
//   run the product mutation -> insert the live_outbox row in the SAME
//   getDb().transaction -> re-read the post-write rows -> return a publication
//   the server composition layer fans out (canonical {type:'live-event'} frame)
//   AFTER commit. A rollback emits nothing.
//
// Scope-from-project (corrects the draft): a project-bound message emits
// scope:'project'; a project-less message (global user-inbox) emits
// scope:'global'+projectId:null (the `global ⟺ projectId IS NULL` invariant).
//
// Boundary purity: @pc/contracts + @pc/db + @pc/domain only. No Hono, React, WS
// hub, Channel, MCP, or runtime process classes. The delivery worker (server)
// holds the injected send facade; fanout is wired at the composition layer.

import type {
  MailboxDeliveryChangedLivePayload,
  MailboxMessageChangedLivePayload,
} from '@pc/contracts';
import {
  acquireDeliveryLease as defaultAcquireDeliveryLease,
  enqueueMailboxMessage as defaultEnqueueMailboxMessage,
  getDb,
  getMailboxMessage as defaultGetMailboxMessage,
  insertLiveEvent,
  listMailboxMessagesBySource as defaultListMailboxMessagesBySource,
  listRecipientsForMessage as defaultListRecipientsForMessage,
  markDeliveryAccepted as defaultMarkDeliveryAccepted,
  markDeliveryDeadLettered as defaultMarkDeliveryDeadLettered,
  markDeliveryDeferred as defaultMarkDeliveryDeferred,
  markDeliveryRetrying as defaultMarkDeliveryRetrying,
  markRecipientActioned as defaultMarkRecipientActioned,
  markRecipientDismissed as defaultMarkRecipientDismissed,
  markRecipientRead as defaultMarkRecipientRead,
  newId as defaultNewId,
  writeAudit as defaultWriteAudit,
  type DbExecutor,
  type EnqueueMailboxMessageInput,
  type InsertLiveEventDraft,
  type LiveOutboxEvent,
  type MailboxDeliveryRow,
  type MailboxMessageRow,
  type MailboxRecipientRow,
} from '@pc/db';
import type { ULID } from '@pc/domain';
import { recipientSummaryOf, toMailboxMessageDto } from './adapters.ts';

export interface MailboxMessagePublication {
  liveEvent: LiveOutboxEvent<MailboxMessageChangedLivePayload>;
  message: MailboxMessageRow;
  recipients: MailboxRecipientRow[];
}

export interface MailboxDeliveryPublication {
  liveEvent: LiveOutboxEvent<MailboxDeliveryChangedLivePayload>;
  delivery: MailboxDeliveryRow;
}

export interface MailboxEnqueuePublication extends MailboxMessagePublication {
  deliveries: MailboxDeliveryRow[];
  created: boolean;
}

export interface MailboxServiceDeps {
  transaction?: <T>(fn: (tx: DbExecutor) => T) => T;
  insertLiveEvent?: typeof insertLiveEvent;
  enqueueMailboxMessage?: typeof defaultEnqueueMailboxMessage;
  getMailboxMessage?: typeof defaultGetMailboxMessage;
  listMailboxMessagesBySource?: typeof defaultListMailboxMessagesBySource;
  listRecipientsForMessage?: typeof defaultListRecipientsForMessage;
  acquireDeliveryLease?: typeof defaultAcquireDeliveryLease;
  markDeliveryAccepted?: typeof defaultMarkDeliveryAccepted;
  markDeliveryRetrying?: typeof defaultMarkDeliveryRetrying;
  markDeliveryDeferred?: typeof defaultMarkDeliveryDeferred;
  markDeliveryDeadLettered?: typeof defaultMarkDeliveryDeadLettered;
  markRecipientRead?: typeof defaultMarkRecipientRead;
  markRecipientActioned?: typeof defaultMarkRecipientActioned;
  markRecipientDismissed?: typeof defaultMarkRecipientDismissed;
  writeAudit?: typeof defaultWriteAudit;
  /** Id mint for M4b dead-letter notices; tests inject deterministic ids. */
  newId?: typeof defaultNewId;
}

export class MailboxService {
  private readonly tx: <T>(fn: (tx: DbExecutor) => T) => T;
  private readonly insert: typeof insertLiveEvent;
  private readonly enqueueRepo: typeof defaultEnqueueMailboxMessage;
  private readonly getMessage: typeof defaultGetMailboxMessage;
  private readonly listBySource: typeof defaultListMailboxMessagesBySource;
  private readonly listRecipients: typeof defaultListRecipientsForMessage;
  private readonly acquireLease: typeof defaultAcquireDeliveryLease;
  private readonly accept: typeof defaultMarkDeliveryAccepted;
  private readonly retry: typeof defaultMarkDeliveryRetrying;
  private readonly defer: typeof defaultMarkDeliveryDeferred;
  private readonly deadLetter: typeof defaultMarkDeliveryDeadLettered;
  private readonly readRecipient: typeof defaultMarkRecipientRead;
  private readonly actionRecipient: typeof defaultMarkRecipientActioned;
  private readonly dismissRecipient: typeof defaultMarkRecipientDismissed;
  private readonly audit: typeof defaultWriteAudit;
  private readonly newId: typeof defaultNewId;

  constructor(deps: MailboxServiceDeps = {}) {
    this.tx = deps.transaction ?? ((fn) => getDb().transaction(fn));
    this.insert = deps.insertLiveEvent ?? insertLiveEvent;
    this.enqueueRepo = deps.enqueueMailboxMessage ?? defaultEnqueueMailboxMessage;
    this.getMessage = deps.getMailboxMessage ?? defaultGetMailboxMessage;
    this.listBySource = deps.listMailboxMessagesBySource ?? defaultListMailboxMessagesBySource;
    this.listRecipients = deps.listRecipientsForMessage ?? defaultListRecipientsForMessage;
    this.acquireLease = deps.acquireDeliveryLease ?? defaultAcquireDeliveryLease;
    this.accept = deps.markDeliveryAccepted ?? defaultMarkDeliveryAccepted;
    this.retry = deps.markDeliveryRetrying ?? defaultMarkDeliveryRetrying;
    this.defer = deps.markDeliveryDeferred ?? defaultMarkDeliveryDeferred;
    this.deadLetter = deps.markDeliveryDeadLettered ?? defaultMarkDeliveryDeadLettered;
    this.readRecipient = deps.markRecipientRead ?? defaultMarkRecipientRead;
    this.actionRecipient = deps.markRecipientActioned ?? defaultMarkRecipientActioned;
    this.dismissRecipient = deps.markRecipientDismissed ?? defaultMarkRecipientDismissed;
    this.audit = deps.writeAudit ?? defaultWriteAudit;
    this.newId = deps.newId ?? defaultNewId;
  }

  /** Enqueue a message + recipients + deliveries (+ audit) + the message fact
   *  in ONE tx. Idempotent by `idempotency_key` (a replay returns the existing
   *  rows and still emits the current fact). */
  enqueue(input: EnqueueMailboxMessageInput): MailboxEnqueuePublication {
    return this.tx((tx) => {
      const res = this.enqueueRepo(input, tx);
      const liveEvent = this.insert(
        tx,
        buildMessageDraft(res.message, res.recipients),
      );
      return {
        liveEvent,
        message: res.message,
        recipients: res.recipients,
        deliveries: res.deliveries,
        created: res.created,
      };
    });
  }

  /** Acquire an exclusive lease (no fact — leasing is internal worker state). */
  lease(input: { deliveryId: ULID; owner: string; now: number; leaseMs: number }): MailboxDeliveryRow | null {
    return this.acquireLease(input);
  }

  /** M8 (FD-7) — decided-elsewhere resolution, phase 1: every UNACTIONED,
   *  undismissed recipient of every message minted for this source (e.g. all
   *  open review cards for one workflow gate, across loop iterations). The
   *  caller snapshots these BEFORE applying the decision so a card the decision
   *  itself mints (ceiling escalation re-post on the same source) stays open. */
  collectUnactionedRecipients(sourceKind: string, sourceId: string): ULID[] {
    const ids: ULID[] = [];
    for (const message of this.listBySource(sourceKind, sourceId)) {
      for (const r of this.listRecipients(message.id)) {
        if (r.actionedAt === null && r.dismissedAt === null) ids.push(r.id);
      }
    }
    return ids;
  }

  /** M8 (FD-7) — decided-elsewhere resolution, phase 2: action the snapshot.
   *  Each flip re-emits the message fact (live inbox refresh). */
  actionRecipients(ids: readonly ULID[], now: number): number {
    let actioned = 0;
    for (const id of ids) {
      if (this.markActioned(id, now)) actioned += 1;
    }
    return actioned;
  }

  /** Auto-clear a resolved-elsewhere snapshot from the inbox. Dismissed is what
   *  the UI hides on (actioned only drops the actionable count); use this when a
   *  card should VANISH once its underlying decision is made — e.g. an escalated
   *  agent question answered through any door (user decision 2026-06-05). */
  dismissRecipients(ids: readonly ULID[], now: number): number {
    let dismissed = 0;
    for (const id of ids) {
      if (this.markDismissed(id, now)) dismissed += 1;
    }
    return dismissed;
  }

  acceptDelivery(input: {
    deliveryId: ULID;
    targetRefKind: 'send-queue' | 'ui-inbox' | 'channel' | null;
    targetRefId: string | null;
    now: number;
  }): MailboxDeliveryPublication | null {
    return this.tx((tx) => {
      const delivery = this.accept(
        {
          deliveryId: input.deliveryId,
          targetRefKind: input.targetRefKind,
          targetRefId: input.targetRefId,
          now: input.now,
        },
        tx,
      );
      if (!delivery) return null;
      this.audit(
        {
          messageId: delivery.messageId,
          recipientId: delivery.recipientId,
          deliveryId: delivery.id,
          action: 'accepted',
          actorKind: 'worker',
          now: input.now,
        },
        tx,
      );
      const liveEvent = this.insert(tx, buildDeliveryDraft(this.getMessage(delivery.messageId, tx)!, delivery));
      return { liveEvent, delivery };
    });
  }

  retryDelivery(input: {
    deliveryId: ULID;
    lastError: string;
    nextAttemptAt: number;
    now: number;
  }): MailboxDeliveryPublication | null {
    return this.tx((tx) => {
      const delivery = this.retry(input, tx);
      if (!delivery) return null;
      this.audit(
        {
          messageId: delivery.messageId,
          deliveryId: delivery.id,
          action: 'retry-scheduled',
          actorKind: 'worker',
          details: { lastError: input.lastError, nextAttemptAt: input.nextAttemptAt },
          now: input.now,
        },
        tx,
      );
      const liveEvent = this.insert(tx, buildDeliveryDraft(this.getMessage(delivery.messageId, tx)!, delivery));
      return { liveEvent, delivery };
    });
  }

  /** M4a/FD-8 — park a delivery whose recipient cannot be reached YET (no live
   *  orchestrator). No attempt consumed; status returns to `pending` with a
   *  scheduled recheck. A message never dead-letters for the orchestrator
   *  being away — it waits. */
  deferDelivery(input: {
    deliveryId: ULID;
    reason: string;
    nextAttemptAt: number;
    now: number;
  }): MailboxDeliveryPublication | null {
    return this.tx((tx) => {
      const delivery = this.defer(input, tx);
      if (!delivery) return null;
      this.audit(
        {
          messageId: delivery.messageId,
          deliveryId: delivery.id,
          action: 'deferred',
          actorKind: 'worker',
          details: { reason: input.reason, nextAttemptAt: input.nextAttemptAt },
          now: input.now,
        },
        tx,
      );
      const liveEvent = this.insert(tx, buildDeliveryDraft(this.getMessage(delivery.messageId, tx)!, delivery));
      return { liveEvent, delivery };
    });
  }

  deadLetterDelivery(input: {
    deliveryId: ULID;
    messageId: ULID;
    recipientId: ULID;
    reason: string;
    lastError: string | null;
    now: number;
  }): MailboxDeliveryPublication | null {
    return this.tx((tx) => {
      const delivery = this.deadLetter(input, tx);
      if (!delivery) return null;
      this.audit(
        {
          messageId: input.messageId,
          recipientId: input.recipientId,
          deliveryId: input.deliveryId,
          action: 'dead-lettered',
          actorKind: 'worker',
          details: { reason: input.reason, lastError: input.lastError },
          now: input.now,
        },
        tx,
      );
      const message = this.getMessage(delivery.messageId, tx)!;
      const liveEvent = this.insert(tx, buildDeliveryDraft(message, delivery));
      this.mintDeadLetterNotice(message, delivery, input, tx);
      return { liveEvent, delivery };
    });
  }

  /** M4b (FD-8) — a dead letter is never silent: every dead-lettered delivery
   *  mints a user-inbox `system-notice` card in the SAME tx, idempotent per
   *  delivery (`dead-letter:<deliveryId>`). Guard: a notice's own delivery is
   *  ui-inbox (accepts immediately) so recursion is structurally impossible —
   *  but skip re-noticing a notice anyway (sourceKind `mailbox-dead-letter`). */
  private mintDeadLetterNotice(
    message: MailboxMessageRow,
    delivery: MailboxDeliveryRow,
    input: { deliveryId: ULID; reason: string; lastError: string | null; now: number },
    tx: DbExecutor,
  ): void {
    if (message.sourceKind === 'mailbox-dead-letter') return;
    const about = message.subject?.trim() || message.kind;
    const res = this.enqueueRepo(
      {
        message: {
          id: this.newId(),
          projectId: message.projectId,
          kind: 'system-notice',
          subject: `Message could not be delivered: ${about}`,
          body:
            `A "${message.kind}" message ("${about}") could not be delivered ` +
            `(${input.reason}${input.lastError ? `: ${input.lastError}` : ''}). ` +
            `Original message:\n\n${message.body}`,
          payload: {
            deadLetter: true,
            originalMessageId: message.id,
            originalKind: message.kind,
            deliveryId: input.deliveryId,
            channel: delivery.channel,
            reason: input.reason,
            lastError: input.lastError,
          },
          sourceKind: 'mailbox-dead-letter',
          sourceId: input.deliveryId,
          idempotencyKey: `dead-letter:${input.deliveryId}`,
        },
        recipients: [
          {
            id: this.newId(),
            addressKind: 'active-orchestrator',
            addressJson: {
              kind: 'active-orchestrator',
              projectId: message.projectId,
            },
            channel: 'orchestrator-turn',
            deliveryId: this.newId(),
          },
        ],
        now: input.now,
      },
      tx,
    );
    if (res.created) this.insert(tx, buildMessageDraft(res.message, res.recipients));
  }

  /** Recipient UI state (read/action/dismiss). Re-emits the message fact so the
   *  inbox unread/actionable summary updates live. Reads never emit. */
  markRead(recipientId: ULID, now: number): MailboxMessagePublication | null {
    return this.recipientStateChange(recipientId, now, (id, n, tx) => this.readRecipient(id, n, tx), 'read');
  }
  markActioned(recipientId: ULID, now: number): MailboxMessagePublication | null {
    return this.recipientStateChange(
      recipientId,
      now,
      (id, n, tx) => this.actionRecipient(id, n, tx),
      'actioned',
    );
  }
  markDismissed(recipientId: ULID, now: number): MailboxMessagePublication | null {
    return this.recipientStateChange(
      recipientId,
      now,
      (id, n, tx) => this.dismissRecipient(id, n, tx),
      'dismissed',
    );
  }

  private recipientStateChange(
    recipientId: ULID,
    now: number,
    mutate: (id: ULID, now: number, tx: DbExecutor) => MailboxRecipientRow | null,
    action: string,
  ): MailboxMessagePublication | null {
    return this.tx((tx) => {
      const recipient = mutate(recipientId, now, tx);
      if (!recipient) return null;
      const message = this.getMessage(recipient.messageId, tx);
      if (!message) return null;
      this.audit(
        { messageId: message.id, recipientId, action, actorKind: 'user', now },
        tx,
      );
      const recipients = this.listRecipients(message.id, tx);
      const liveEvent = this.insert(tx, buildMessageDraft(message, recipients));
      return { liveEvent, message, recipients };
    });
  }
}

/** Scope-from-project: a project-less message emits scope:'global'. */
export function buildMessageDraft(
  message: MailboxMessageRow,
  recipients: readonly MailboxRecipientRow[],
): InsertLiveEventDraft<MailboxMessageChangedLivePayload> {
  const payload: MailboxMessageChangedLivePayload = {
    messageId: message.id,
    kind: toMailboxMessageDto(message).kind,
    recipientSummary: recipientSummaryOf(message, recipients),
  };
  return scopeForProject(message.projectId, {
    type: 'mailbox.message.changed',
    entity: 'mailbox-message',
    entityId: message.id,
    version: null,
    payload,
  });
}

export function buildDeliveryDraft(
  message: MailboxMessageRow,
  delivery: MailboxDeliveryRow,
): InsertLiveEventDraft<MailboxDeliveryChangedLivePayload> {
  const payload: MailboxDeliveryChangedLivePayload = {
    deliveryId: delivery.id,
    messageId: delivery.messageId,
    status: toDeliveryStatus(delivery.status),
    attempts: delivery.attempts,
    targetRef: {
      kind: (delivery.targetRefKind as 'send-queue' | 'ui-inbox' | 'channel' | null) ?? null,
      id: delivery.targetRefId,
    },
    lastError: delivery.lastError,
  };
  return scopeForProject(message.projectId, {
    type: 'mailbox.delivery.changed',
    entity: 'mailbox-message',
    // T3.1 — key delivery frames by the delivery row id (NOT messageId) so they
    // stop colliding with the message-fact frame on `mailbox-message::<id>` in
    // the client live store. Consumers read `payload.messageId`, not entityId.
    entityId: delivery.id,
    version: delivery.attempts,
    payload,
  });
}

function scopeForProject<T>(
  projectId: ULID | null,
  partial: Omit<InsertLiveEventDraft<T>, 'scope' | 'projectId'>,
): InsertLiveEventDraft<T> {
  return projectId === null
    ? { ...partial, scope: 'global', projectId: null }
    : { ...partial, scope: 'project', projectId };
}

function toDeliveryStatus(
  status: string,
): MailboxDeliveryChangedLivePayload['status'] {
  return status as MailboxDeliveryChangedLivePayload['status'];
}
