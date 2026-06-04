import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MailboxAddress } from '@pc/contracts';
import type { ULID } from '@pc/domain';
import type { OrchestratorSendQueueRow } from '@pc/db';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-mailbox-worker-'));
process.env.PC_DATA_DIR = tmpDir;

const db = await import('@pc/db');
const { closeDb, enqueueMailboxMessage, getMailboxDelivery, listDeadLettersForMessage, newId, runMigrations } = db;
const { MailboxService } = await import('@pc/app-services');
const { MailboxWorker } = await import('../src/services/mailbox-worker.ts');
const { MailboxOrchestratorTurnAdapter, mailboxClientMessageId } = await import(
  '../src/services/mailbox-orchestrator-turn-adapter.ts'
);

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeDelivery(channel: string, addr: MailboxAddress, projectId: ULID | null) {
  const messageId = newId();
  const recipientId = newId();
  const deliveryId = newId();
  enqueueMailboxMessage({
    message: {
      id: messageId,
      projectId,
      kind: 'system-notice',
      body: 'deliver me',
      sourceKind: 'system',
      idempotencyKey: `w-${messageId}`,
    },
    recipients: [{ id: recipientId, addressKind: addr.kind, addressJson: addr as unknown as Record<string, unknown>, channel, deliveryId }],
    now: Date.now(),
  });
  return { messageId, recipientId, deliveryId };
}

/** A fake ConversationSendService exposing only enqueueRuntimeTurn, recording
 *  every call (and asserting NO raw send / NO channel call ever happens). */
function fakeSendService(opts: { throwOnce?: boolean } = {}) {
  const calls: { clientMessageId: string; source?: string }[] = [];
  const byClient = new Map<string, OrchestratorSendQueueRow>();
  let threw = false;
  const svc = {
    enqueueRuntimeTurn(input: { clientMessageId: string; source?: string }) {
      calls.push({ clientMessageId: input.clientMessageId, source: input.source });
      if (opts.throwOnce && !threw) {
        threw = true;
        throw new Error('runtime busy');
      }
      // idempotent by clientMessageId
      const existing = byClient.get(input.clientMessageId);
      if (existing) return { row: existing, created: false };
      const row = { id: `sq-${byClient.size + 1}` } as OrchestratorSendQueueRow;
      byClient.set(input.clientMessageId, row);
      return { row, created: true };
    },
  };
  return { svc, calls };
}

function worker(sendService: { enqueueRuntimeTurn: (i: never) => never }, addr: MailboxAddress, _projectId: ULID | null, getBody = () => 'deliver me') {
  const service = new MailboxService();
  const adapter = new MailboxOrchestratorTurnAdapter(sendService as never);
  // Slice 015b — the worker no longer hand-fans; the delivery `live_outbox` row
  // is written inside the service txn and the relay delivers it.
  const w = new MailboxWorker({
    service,
    orchestratorTurn: adapter,
    getRecipientAddress: () => addr,
    getMessageBody: getBody,
    maxAttempts: 2,
  });
  return w;
}

test('ui-inbox delivery accepts immediately with target_ref ui-inbox', () => {
  const addr: MailboxAddress = { kind: 'project-inbox', projectId: 'p1' };
  const { deliveryId } = makeDelivery('ui-inbox', addr, 'p1' as ULID);
  const w = worker({ enqueueRuntimeTurn: (() => {}) as never }, addr, 'p1' as ULID);
  const res = w.runOnce();
  assert.equal(res.accepted, 1);
  const delivery = getMailboxDelivery(deliveryId);
  assert.equal(delivery!.status, 'accepted');
  assert.equal(delivery!.targetRefKind, 'ui-inbox');
});

test('ui-inbox acceptance writes a committed delivery frame the relay delivers (no hand-fanout)', async () => {
  const { LiveRelay } = await import('../src/services/live-relay.ts');
  const fanProject = new Map<string, unknown[]>();
  const fanGlobal: unknown[] = [];
  const relay = new LiveRelay({
    hub: {
      broadcastAll(msg: unknown): number { fanGlobal.push(msg); return 1; },
      broadcast(pid: string, msg: unknown): number {
        const l = fanProject.get(pid) ?? [];
        l.push(msg);
        fanProject.set(pid, l);
        return 1;
      },
    },
  });
  relay.primeToHead();

  const addr: MailboxAddress = { kind: 'project-inbox', projectId: 'p-relay' };
  const { deliveryId } = makeDelivery('ui-inbox', addr, 'p-relay' as ULID);
  // makeDelivery wrote the enqueue's message-changed outbox row; advance past it
  // so we isolate the delivery frame.
  relay.drain();
  const beforeProject = (fanProject.get('p-relay') ?? []).length;

  const w = worker({ enqueueRuntimeTurn: (() => {}) as never }, addr, 'p-relay' as ULID);
  assert.equal(w.runOnce().accepted, 1);

  // The acceptDelivery txn wrote a `mailbox.delivery.changed` outbox row; the
  // relay delivers it to the message's project scope. Exactly one new frame.
  relay.drain();
  const delivered = (fanProject.get('p-relay') ?? []).slice(beforeProject);
  assert.equal(delivered.length, 1, 'relay delivers exactly one delivery frame');
  assert.equal(
    (delivered[0] as { event: { type: string; entityId: string } }).event.type,
    'mailbox.delivery.changed',
  );
  assert.equal(getMailboxDelivery(deliveryId)!.status, 'accepted');
});

/** M4a — pinned orchestrator-session addresses must reference a REAL session
 *  row (the worker now verifies existence; synthetic ids dead-letter). The
 *  session FK needs a real project row too. */
function realProject(): ULID {
  const slug = `mwp-${newId().toLowerCase()}`;
  return db.createProject({
    slug,
    name: slug,
    stages: [{ id: 'todo', name: 'Todo', order: 0 }],
    folderPath: join(tmpDir, slug),
  }).id;
}

function realSessionAddress(projectId: ULID): MailboxAddress {
  const sess = db.createOrchestratorSession({ projectId, providerSessionId: `cc-${newId()}` });
  return { kind: 'orchestrator-session', projectId, sessionId: sess.id };
}

test('orchestrator-turn delivery wraps enqueueRuntimeTurn (stable clientMessageId, source mailbox, send-queue target_ref)', () => {
  const addr = realSessionAddress(realProject());
  const { deliveryId } = makeDelivery('orchestrator-turn', addr, 'p1' as ULID);
  const { svc, calls } = fakeSendService();
  const w = worker(svc as never, addr, 'p1' as ULID);
  const res = w.runOnce();
  assert.equal(res.accepted, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.clientMessageId, mailboxClientMessageId(deliveryId));
  assert.equal(calls[0]!.source, 'mailbox');
  const delivery = getMailboxDelivery(deliveryId);
  assert.equal(delivery!.status, 'accepted');
  assert.equal(delivery!.targetRefKind, 'send-queue');
});

test('orchestrator-turn idempotency: a retried delivery returns created:false (same row)', () => {
  const addr = realSessionAddress(realProject());
  const { deliveryId } = makeDelivery('orchestrator-turn', addr, 'p1' as ULID);
  const { svc, calls } = fakeSendService();
  const w = worker(svc as never, addr, 'p1' as ULID);
  w.runOnce();
  // Re-running on an accepted delivery is a no-op (it's no longer due), but the
  // adapter idempotency is what guarantees one runtime turn. Prove it directly:
  const adapterResultA = svc.enqueueRuntimeTurn({ clientMessageId: mailboxClientMessageId(deliveryId) } as never);
  const adapterResultB = svc.enqueueRuntimeTurn({ clientMessageId: mailboxClientMessageId(deliveryId) } as never);
  assert.equal((adapterResultA as { created: boolean }).created, false); // already created in runOnce
  assert.equal((adapterResultB as { created: boolean }).created, false);
  assert.equal((adapterResultA as { row: { id: string } }).row.id, (adapterResultB as { row: { id: string } }).row.id);
  assert.ok(calls.length >= 1);
});

test('a thrown enqueue error → retrying with backoff (then dead-letter at max attempts)', () => {
  const addr = realSessionAddress(realProject());
  const { deliveryId, messageId } = makeDelivery('orchestrator-turn', addr, 'p1' as ULID);
  // A send service that always throws.
  const alwaysThrow = {
    enqueueRuntimeTurn() {
      throw new Error('always busy');
    },
  };
  const w = worker(alwaysThrow as never, addr, 'p1' as ULID); // maxAttempts:2
  const first = w.runOnce();
  assert.equal(first.retried, 1);
  assert.equal(getMailboxDelivery(deliveryId)!.status, 'retrying');
  // Make it due again and run: attempt 2 hits maxAttempts → dead-letter.
  db.markDeliveryRetrying({ deliveryId, lastError: 'x', nextAttemptAt: Date.now() - 1, now: Date.now() });
  // attempts is now 2 (=maxAttempts); next attempt dead-letters.
  const second = w.runOnce();
  assert.equal(second.deadLettered, 1);
  assert.equal(getMailboxDelivery(deliveryId)!.status, 'dead-lettered');
  assert.equal(listDeadLettersForMessage(messageId).length, 1);
});

// ── M4a/FD-8 — no message silently dies ──────────────────────────────────────

test('M4a: no active orchestrator yet → DEFERRED (no attempt burned), then delivers when one exists', () => {
  const projectId = realProject();
  const addr: MailboxAddress = { kind: 'active-orchestrator', projectId };
  const { deliveryId } = makeDelivery('orchestrator-turn', addr, projectId);
  const { svc, calls } = fakeSendService();
  const w = worker(svc as never, addr, projectId);

  // Pass 1: the orchestrator is away — the old code dead-lettered HERE.
  const first = w.runOnce();
  assert.equal(first.deferred, 1);
  assert.equal(first.deadLettered, 0);
  const parked = getMailboxDelivery(deliveryId)!;
  assert.equal(parked.status, 'pending', 'parked, not failed');
  assert.equal(parked.attempts, 0, 'waiting is not a failed attempt');
  assert.ok((parked.nextAttemptAt ?? 0) > Date.now(), 'recheck scheduled');
  assert.equal(calls.length, 0);

  // The orchestrator returns; make the delivery due and run again → delivered.
  db.createOrchestratorSession({ projectId, providerSessionId: 'cc-return' });
  db.markDeliveryDeferred({ deliveryId, reason: 'test-due', nextAttemptAt: Date.now() - 1, now: Date.now() });
  const second = w.runOnce();
  assert.equal(second.accepted, 1);
  assert.equal(getMailboxDelivery(deliveryId)!.status, 'accepted');
  assert.equal(calls.length, 1);
});

test('M4a: a pinned orchestrator-session that does NOT exist dead-letters non-retryably (synthetic dispatcher id)', () => {
  const addr: MailboxAddress = { kind: 'orchestrator-session', projectId: 'p1', sessionId: 'wf-SYNTHETIC' };
  const { deliveryId, messageId } = makeDelivery('orchestrator-turn', addr, 'p1' as ULID);
  const { svc, calls } = fakeSendService();
  const w = worker(svc as never, addr, 'p1' as ULID);
  const res = w.runOnce();
  assert.equal(res.deadLettered, 1, 'permanently undeliverable — fail honestly, not after 5 burns');
  assert.equal(getMailboxDelivery(deliveryId)!.status, 'dead-lettered');
  assert.equal(listDeadLettersForMessage(messageId).length, 1);
  assert.equal(calls.length, 0);
});
