// Slice 007 — mailbox HTTP routes (additive; no existing route changed).
//
// Project-scoped inbox + delivery inspector + an app-level global single-user
// inbox + a pending-interaction answer route. All NEW routes (no legacy parity).
// Contract parsers gate input; reads never emit.
//
// Slice 015b — mailbox-message AND pending-interaction delivery are now the
// relay's job. The mailbox + pending-interaction services write the canonical
// `live_outbox` row inside their mutation txn; the 250ms relay drains it to
// subscribers per scope/project. ALL ad-hoc `broadcastTo`/`broadcastAll` fanout
// that used to live here is DELETED (the relay delivers the identical frame,
// deduped by `event.id`). No fanout deps remain on these routes.

import type { Hono } from 'hono';
import type {
  MailboxEnqueuePublication,
  MailboxService,
  PendingInteractionService,
} from '@pc/app-services';
import {
  mailboxAddressProjectId,
  parseEnqueueMailboxMessageRequest,
  parseListMailboxQuery,
  parseAnswerPendingInteractionRequest,
  type EnqueueMailboxMessageRequest,
  type MailboxAddress,
} from '@pc/contracts';
import {
  getMailboxMessage,
  getMailboxRecipient,
  getPendingInteraction,
  listDeliveriesForProject,
  listRecipientsForInbox,
  newId,
  type MailboxRecipientRow,
} from '@pc/db';
// NOTE: `getMailboxMessage` stays imported for `filterInbox` typing + the
// delivery inspector; the mailbox-message fanout that also used it is gone.
import type { ULID } from '@pc/domain';

import {
  toMailboxDeliveryDto,
  toMailboxMessageDto,
  toMailboxRecipientDto,
} from '@pc/app-services';

export interface MailboxRouteDeps {
  mailbox: MailboxService;
  interactions: PendingInteractionService;
  now?: () => number;
}

export function registerMailboxRoutes(app: Hono, deps: MailboxRouteDeps): void {
  const now = deps.now ?? (() => Date.now());

  // Shared enqueue. The message's projectId is DERIVED from its recipient
  // addresses (the live-event scope invariant is `global ⟺ projectId IS NULL`),
  // NOT hardcoded from any path param — a `user-inbox`/project-less recipient
  // yields a global (`projectId:null`) message that lands in `/api/mailbox`.
  const enqueue = (req: EnqueueMailboxMessageRequest): MailboxEnqueuePublication => {
    const projectId = deriveMessageProjectId(req);
    const pub = deps.mailbox.enqueue({
      message: {
        id: newId(),
        projectId,
        kind: req.kind,
        subject: req.subject ?? null,
        body: req.body,
        payload: req.payload ?? {},
        sourceKind: req.source?.kind ?? 'system',
        sourceId: req.source?.id ?? null,
        interactionId: (req.interactionId as ULID | undefined) ?? null,
        idempotencyKey: req.idempotencyKey,
      },
      recipients: req.recipients.map((r) => ({
        id: newId(),
        addressKind: r.address.kind,
        addressJson: r.address as unknown as Record<string, unknown>,
        channel: r.channel,
        deliveryId: newId(),
      })),
      now: now(),
    });
    // Outbox row written in the enqueue txn; the relay delivers it. No hand-fanout.
    return pub;
  };

  const enqueueResponse = (pub: MailboxEnqueuePublication) => ({
    ok: true as const,
    created: pub.created,
    message: toMailboxMessageDto(pub.message),
    recipients: pub.recipients.map(toMailboxRecipientDto),
    deliveries: pub.deliveries.map(toMailboxDeliveryDto),
  });

  // ── Enqueue (project-scoped). NEW route; idempotent by key. ────────────────
  // Kept for callers that already know the project; recipients still drive the
  // message's stored projectId (so a project-less recipient is still global).
  app.post('/api/projects/:projectId/mailbox/messages', async (c) => {
    const parsed = parseEnqueueMailboxMessageRequest(await safeJson(c));
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400);
    return c.json(enqueueResponse(enqueue(parsed.value)));
  });

  // ── Enqueue (app-level / unscoped). The ONLY path that can create a global
  // (`projectId:null`) message — used for the single-user inbox. The message's
  // scope comes from its recipient addresses. ────────────────────────────────
  app.post('/api/mailbox/messages', async (c) => {
    const parsed = parseEnqueueMailboxMessageRequest(await safeJson(c));
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400);
    return c.json(enqueueResponse(enqueue(parsed.value)));
  });

  // ── Project inbox list. ─────────────────────────────────────────────────────
  app.get('/api/projects/:projectId/mailbox', (c) => {
    const projectId = c.req.param('projectId') as ULID;
    const query = parseListMailboxQuery({
      unreadOnly: c.req.query('unreadOnly'),
      actionableOnly: c.req.query('actionableOnly'),
    });
    const rows = listRecipientsForInbox({ projectId });
    return c.json({ ok: true, items: filterInbox(rows, query.ok ? query.value : {}) });
  });

  // ── Global single-user inbox (project-less user-inbox messages). ───────────
  app.get('/api/mailbox', (c) => {
    const query = parseListMailboxQuery({
      unreadOnly: c.req.query('unreadOnly'),
      actionableOnly: c.req.query('actionableOnly'),
    });
    const rows = listRecipientsForInbox({ projectId: null });
    return c.json({ ok: true, items: filterInbox(rows, query.ok ? query.value : {}) });
  });

  // ── Recipient read / action / dismiss. ──────────────────────────────────────
  app.post('/api/projects/:projectId/mailbox/recipients/:recipientId/read', (c) => {
    const recipientId = c.req.param('recipientId') as ULID;
    if (!getMailboxRecipient(recipientId)) return c.json({ ok: false, error: 'unknown recipient' }, 404);
    deps.mailbox.markRead(recipientId, now());
    return c.json({ ok: true });
  });

  app.post('/api/projects/:projectId/mailbox/recipients/:recipientId/action', (c) => {
    const recipientId = c.req.param('recipientId') as ULID;
    if (!getMailboxRecipient(recipientId)) return c.json({ ok: false, error: 'unknown recipient' }, 404);
    deps.mailbox.markActioned(recipientId, now());
    return c.json({ ok: true });
  });

  app.post('/api/projects/:projectId/mailbox/recipients/:recipientId/dismiss', (c) => {
    const recipientId = c.req.param('recipientId') as ULID;
    if (!getMailboxRecipient(recipientId)) return c.json({ ok: false, error: 'unknown recipient' }, 404);
    deps.mailbox.markDismissed(recipientId, now());
    return c.json({ ok: true });
  });

  // ── Delivery inspector. ─────────────────────────────────────────────────────
  app.get('/api/projects/:projectId/mailbox/deliveries', (c) => {
    const projectId = c.req.param('projectId') as ULID;
    const deliveries = listDeliveriesForProject(projectId).map(toMailboxDeliveryDto);
    return c.json({ ok: true, deliveries });
  });

  // ── Answer a pending interaction (durable shadow; not the /api/ask authority). ─
  app.post('/api/projects/:projectId/pending-interactions/:interactionId/answer', async (c) => {
    const interactionId = c.req.param('interactionId') as ULID;
    if (!getPendingInteraction(interactionId)) {
      return c.json({ ok: false, error: 'unknown interaction' }, 404);
    }
    const parsed = parseAnswerPendingInteractionRequest(await safeJson(c));
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400);
    const pub = deps.interactions.answer({
      id: interactionId,
      answer: parsed.value.answer,
      answeredBy: parsed.value.answeredBy,
      now: now(),
    });
    if (!pub) return c.json({ ok: false, error: 'interaction not open' }, 409);
    // Outbox row written in the answer txn; the relay delivers it.
    return c.json({ ok: true });
  });
}

function filterInbox(
  rows: { recipient: MailboxRecipientRow; message: ReturnType<typeof getMailboxMessage> }[],
  query: { unreadOnly?: boolean; actionableOnly?: boolean },
): unknown[] {
  return rows
    .filter((r) => r.message !== null)
    .filter((r) => (query.unreadOnly ? r.recipient.readAt === null && r.recipient.dismissedAt === null : true))
    .filter((r) =>
      query.actionableOnly
        ? r.message!.interactionId !== null && r.recipient.actionedAt === null && r.recipient.dismissedAt === null
        : true,
    )
    .map((r) => ({
      recipient: toMailboxRecipientDto(r.recipient),
      message: toMailboxMessageDto(r.message!),
    }));
}

/** A message has ONE projectId; recipients can target multiple addresses. The
 *  message is project-bound iff some recipient carries a project context; a set
 *  of purely project-less recipients (e.g. a `user-inbox` with projectId:null)
 *  yields a global message. The first project context wins. */
function deriveMessageProjectId(req: EnqueueMailboxMessageRequest): ULID | null {
  for (const r of req.recipients) {
    const pid = mailboxAddressProjectId(r.address);
    if (pid !== null) return pid as ULID;
  }
  return null;
}

async function safeJson(c: { req: { json: <T>() => Promise<T> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

export type { MailboxAddress };
