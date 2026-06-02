// Slice 007 — web mailbox feature types. Re-exports the shared contract DTOs so
// components never re-derive the wire shape.

export type {
  MailboxAddress,
  MailboxDeliveryChannel,
  MailboxDeliveryStatus,
  MailboxMessageDto,
  MailboxMessageKind,
  MailboxRecipientDto,
  PendingInteractionDto,
} from '@pc/contracts';

import type { MailboxMessageDto, MailboxRecipientDto } from '@pc/contracts';

/** One inbox row: the recipient (UI read/action/dismiss state) + its message. */
export interface MailboxInboxItem {
  recipient: MailboxRecipientDto;
  message: MailboxMessageDto;
}
