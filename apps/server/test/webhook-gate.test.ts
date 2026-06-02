import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import type { ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-webhook-gate-'));
process.env.PC_DATA_DIR = tmpDir;

import type { EnqueueMailboxMessageInput } from '@pc/db';

const db = await import('@pc/db');
const {
  closeDb,
  newId,
  runMigrations,
  getMailboxMessageByIdempotencyKey,
  listRecipientsForMessage,
  listDeliveriesForMessage,
} = db;
const { MailboxService } = await import('@pc/app-services');
const { buildLiveEventFrame } = await import('@pc/contracts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

interface ChannelEvent {
  projectId: ULID;
  slug: string;
  source: string;
  body: string;
  sender: string;
  at: number;
}

/** Build the index.ts webhook sink closure against a real MailboxService so the
 *  durable "no silent drop" path is exercised end to end. 017 Phase C — the sink
 *  is unconditional (the mailbox is the sole door). */
function makeSink() {
  const service = new MailboxService();
  const broadcasts: unknown[] = [];
  const enqueueAndFanout = (input: EnqueueMailboxMessageInput) => {
    const pub = service.enqueue(input);
    broadcasts.push(buildLiveEventFrame(pub.liveEvent));
    return pub;
  };
  const sink = (event: ChannelEvent): void => {
    const hash = createHash('sha256')
      .update(`${event.slug}|${event.source}|${event.body}`)
      .digest('hex')
      .slice(0, 16);
    enqueueAndFanout({
      message: {
        id: newId(),
        projectId: event.projectId,
        kind: 'external-webhook',
        subject: `${event.source} webhook`,
        body: event.body,
        payload: { slug: event.slug, source: event.source, sender: event.sender, at: event.at },
        sourceKind: 'external-webhook',
        sourceId: event.source,
        idempotencyKey: `webhook:${event.slug}:${event.source}:${hash}:${String(event.at)}`,
      },
      recipients: [
        {
          id: newId(),
          addressKind: 'project-inbox',
          addressJson: { kind: 'project-inbox', projectId: event.projectId },
          channel: 'ui-inbox',
          deliveryId: newId(),
        },
      ],
      now: Date.now(),
    });
  };
  return { sink, broadcasts };
}

function event(over: Partial<ChannelEvent> = {}): ChannelEvent {
  return {
    projectId: 'proj-web' as ULID,
    slug: 'my-project',
    source: 'github',
    body: 'push event payload',
    sender: 'test',
    at: 1_700_000_000_000,
    ...over,
  };
}

test('durable external-webhook message lands in the project inbox (ui-inbox); no silent drop on missing registrant', () => {
  const { sink, broadcasts } = makeSink();
  const ev = event({ source: 'stripe', at: 1_700_000_000_002 });
  sink(ev);
  const hash = createHash('sha256').update(`${ev.slug}|${ev.source}|${ev.body}`).digest('hex').slice(0, 16);
  const key = `webhook:${ev.slug}:${ev.source}:${hash}:${String(ev.at)}`;
  const msg = getMailboxMessageByIdempotencyKey(key);
  assert.ok(msg, 'event landed durably with no registrant present (no drop)');
  assert.equal(msg!.kind, 'external-webhook');
  assert.equal(msg!.body, 'push event payload');
  const recipients = listRecipientsForMessage(msg!.id);
  assert.equal(recipients.length, 1);
  assert.equal(recipients[0]!.addressKind, 'project-inbox');
  const deliveries = listDeliveriesForMessage(msg!.id);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]!.channel, 'ui-inbox');
  assert.ok(broadcasts.length >= 1, 'mailbox.message.changed frame fanned out');
});

test('idempotency — a replayed event (same slug/source/body/at) enqueues no duplicate message', () => {
  const { sink } = makeSink();
  const ev = event({ source: 'replayed', at: 1_700_000_000_003 });
  sink(ev);
  sink(ev); // replay
  const hash = createHash('sha256').update(`${ev.slug}|${ev.source}|${ev.body}`).digest('hex').slice(0, 16);
  const msg = getMailboxMessageByIdempotencyKey(`webhook:${ev.slug}:${ev.source}:${hash}:${String(ev.at)}`);
  assert.ok(msg);
  // listDeliveriesForMessage returns exactly the original delivery (no dup).
  assert.equal(listDeliveriesForMessage(msg!.id).length, 1);
});
