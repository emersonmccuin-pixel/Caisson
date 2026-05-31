// Slice 007 — mailbox + pending-interaction row<->DTO adapters.
//
// Pure mappers between the @pc/db rows and the browser-safe @pc/contracts DTOs.
// Boundary purity: @pc/contracts + @pc/db (type-only) + @pc/domain.

import type {
  MailboxAddress,
  MailboxDeliveryChannel,
  MailboxDeliveryDto,
  MailboxDeliveryStatus,
  MailboxMessageDto,
  MailboxMessageKind,
  MailboxRecipientDto,
  MailboxTargetRefKind,
  PendingInteractionDto,
  PendingInteractionKind,
  PendingInteractionSourceKind,
  PendingInteractionStatus,
} from '@pc/contracts';
import { parseMailboxAddress } from '@pc/contracts';
import type {
  MailboxDeliveryRow,
  MailboxMessageRow,
  MailboxRecipientRow,
  PendingInteractionRow,
} from '@pc/db';
import type { ULID } from '@pc/domain';

export class MailboxAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailboxAdapterError';
  }
}

export function toMailboxMessageDto(row: MailboxMessageRow): MailboxMessageDto {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind as MailboxMessageKind,
    subject: row.subject,
    body: row.body,
    payload: row.payload ?? {},
    source: { kind: row.sourceKind, id: row.sourceId },
    interactionId: row.interactionId,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toMailboxRecipientDto(row: MailboxRecipientRow): MailboxRecipientDto {
  const parsed = parseMailboxAddress(row.addressJson);
  if (!parsed.ok) {
    throw new MailboxAdapterError(`invalid recipient address: ${parsed.error}`);
  }
  return {
    id: row.id,
    messageId: row.messageId,
    address: parsed.value as MailboxAddress,
    readAt: row.readAt,
    actionedAt: row.actionedAt,
    dismissedAt: row.dismissedAt,
  };
}

export function toMailboxDeliveryDto(row: MailboxDeliveryRow): MailboxDeliveryDto {
  return {
    id: row.id,
    messageId: row.messageId,
    recipientId: row.recipientId,
    channel: row.channel as MailboxDeliveryChannel,
    status: row.status as MailboxDeliveryStatus,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    targetRef: {
      kind: (row.targetRefKind as MailboxTargetRefKind | null) ?? null,
      id: row.targetRefId,
    },
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPendingInteractionDto(row: PendingInteractionRow): PendingInteractionDto {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind as PendingInteractionKind,
    status: row.status as PendingInteractionStatus,
    source: { kind: row.sourceKind as PendingInteractionSourceKind, id: row.sourceId },
    prompt: row.prompt,
    context: row.context,
    options: row.options ?? null,
    answer: row.answerBody,
    answeredBy: row.answeredBy,
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
    cancelledAt: row.cancelledAt,
    version: row.version,
  };
}

/** Compute the recipient summary (total / unread / actionable) for a message
 *  from its recipient rows. `unread` = no readAt and not dismissed; `actionable`
 *  = the message carries an interaction and the recipient hasn't actioned it. */
export function recipientSummaryOf(
  message: MailboxMessageRow,
  recipients: readonly MailboxRecipientRow[],
): { total: number; unread: number; actionable: number } {
  let unread = 0;
  let actionable = 0;
  for (const r of recipients) {
    if (r.readAt === null && r.dismissedAt === null) unread += 1;
    if (message.interactionId && r.actionedAt === null && r.dismissedAt === null) actionable += 1;
  }
  return { total: recipients.length, unread, actionable };
}

export type { ULID };
