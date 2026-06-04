// Slice 007 — mailbox row<->DTO adapters. (☠ M8/FD-7: pending-interaction
// adapter — gone with the write-only shadow table.)
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
} from '@pc/contracts';
import { isActionableMailboxKind, parseMailboxAddress } from '@pc/contracts';
import type {
  MailboxDeliveryRow,
  MailboxMessageRow,
  MailboxRecipientRow,
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

/** Compute the recipient summary (total / unread / actionable) for a message
 *  from its recipient rows. `unread` = no readAt and not dismissed; `actionable`
 *  = the kind asks for a decision and the recipient hasn't actioned/dismissed it
 *  (M8/FD-7 — was the never-set `interactionId` link, an always-empty set). */
export function recipientSummaryOf(
  message: MailboxMessageRow,
  recipients: readonly MailboxRecipientRow[],
): { total: number; unread: number; actionable: number } {
  let unread = 0;
  let actionable = 0;
  for (const r of recipients) {
    if (r.readAt === null && r.dismissedAt === null) unread += 1;
    if (isActionableMailboxKind(message.kind) && r.actionedAt === null && r.dismissedAt === null) {
      actionable += 1;
    }
  }
  return { total: recipients.length, unread, actionable };
}

export type { ULID };
