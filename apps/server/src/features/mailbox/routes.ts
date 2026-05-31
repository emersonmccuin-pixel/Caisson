// Slice 007 — mailbox HTTP routes (additive; no existing route changed).
//
// Project-scoped inbox + delivery inspector + an app-level global single-user
// inbox + a pending-interaction answer route. All NEW routes (no legacy parity).
// Contract parsers gate input; reads never emit; mutations fan out the canonical
// {type:'live-event'} frame after the service commit. No webhook route this
// slice (Channel stays). The mailbox runs alongside Channel — no cutover.

import type { Hono } from 'hono';
import type {
  MailboxDeliveryPublication,
  MailboxEnqueuePublication,
  MailboxMessagePublication,
  MailboxService,
  PendingInteractionPublication,
  PendingInteractionService,
} from '@pc/app-services';
import {
  buildLiveEventFrame,
  parseEnqueueMailboxMessageRequest,
  parseListMailboxQuery,
  parseAnswerPendingInteractionRequest,
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
import type { ULID } from '@pc/domain';

import {
  toMailboxDeliveryDto,
  toMailboxMessageDto,
  toMailboxRecipientDto,
} from '@pc/app-services';

export interface MailboxRouteDeps {
  mailbox: MailboxService;
  interactions: PendingInteractionService;
  broadcastTo(projectId: ULID, msg: unknown): void;
  /** Global (project-less) fanout for user-inbox events. */
  broadcastAll(msg: unknown): void;
  now?: () => number;
}

export function registerMailboxRoutes(app: Hono, deps: MailboxRouteDeps): void {
  const now = deps.now ?? (() => Date.now());

  const fanoutMessage = (pub: MailboxMessagePublication | MailboxEnqueuePublication | null): void => {
    if (!pub) return;
    const frame = buildLiveEventFrame(pub.liveEvent);
    if (pub.message.projectId === null) deps.broadcastAll(frame);
    else deps.broadcastTo(pub.message.projectId, frame);
  };

  const fanoutDelivery = (pub: MailboxDeliveryPublication | null): void => {
    if (!pub) return;
    const message = getMailboxMessage(pub.delivery.messageId);
    const frame = buildLiveEventFrame(pub.liveEvent);
    if (!message || message.projectId === null) deps.broadcastAll(frame);
    else deps.broadcastTo(message.projectId, frame);
  };

  const fanoutInteraction = (pub: PendingInteractionPublication | null): void => {
    if (!pub) return;
    deps.broadcastTo(pub.interaction.projectId, buildLiveEventFrame(pub.liveEvent));
  };

  // ── Enqueue (project-scoped). NEW route; idempotent by key. ────────────────
  app.post('/api/projects/:projectId/mailbox/messages', async (c) => {
    const projectId = c.req.param('projectId') as ULID;
    const parsed = parseEnqueueMailboxMessageRequest(await safeJson(c));
    if (!parsed.ok) return c.json({ ok: false, error: parsed.error }, 400);
    const req = parsed.value;
    const messageId = newId();
    const ts = now();
    const pub = deps.mailbox.enqueue({
      message: {
        id: messageId,
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
      now: ts,
    });
    fanoutMessage(pub);
    return c.json({
      ok: true,
      created: pub.created,
      message: toMailboxMessageDto(pub.message),
      recipients: pub.recipients.map(toMailboxRecipientDto),
      deliveries: pub.deliveries.map(toMailboxDeliveryDto),
    });
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
    const pub = deps.mailbox.markRead(recipientId, now());
    fanoutMessage(pub);
    return c.json({ ok: true });
  });

  app.post('/api/projects/:projectId/mailbox/recipients/:recipientId/action', (c) => {
    const recipientId = c.req.param('recipientId') as ULID;
    if (!getMailboxRecipient(recipientId)) return c.json({ ok: false, error: 'unknown recipient' }, 404);
    const pub = deps.mailbox.markActioned(recipientId, now());
    fanoutMessage(pub);
    return c.json({ ok: true });
  });

  app.post('/api/projects/:projectId/mailbox/recipients/:recipientId/dismiss', (c) => {
    const recipientId = c.req.param('recipientId') as ULID;
    if (!getMailboxRecipient(recipientId)) return c.json({ ok: false, error: 'unknown recipient' }, 404);
    const pub = deps.mailbox.markDismissed(recipientId, now());
    fanoutMessage(pub);
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
    fanoutInteraction(pub);
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

async function safeJson(c: { req: { json: <T>() => Promise<T> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

export type { MailboxAddress };
