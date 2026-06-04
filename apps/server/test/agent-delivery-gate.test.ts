import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ULID } from '@pc/domain';
import type { EnqueueMailboxMessageInput } from '@pc/db';

import {
  deliverAgentEnvelope,
  type DeliverAgentEnvelopeInput,
} from '../src/services/agent-delivery.ts';

// 017 Phase C — the Channel delivery path is deleted; deliverAgentEnvelope is
// mailbox-only. Every agent envelope enqueues exactly one mailbox message.
// M4a — addressing is dispatcher-aware: a REAL orchestrator session is
// addressed directly; a synthetic dispatcher (workflow worker) falls back to
// active-orchestrator for asks and SKIPS informational terminal notices.

function fakeMailbox() {
  const calls: EnqueueMailboxMessageInput[] = [];
  return { port: (input: EnqueueMailboxMessageInput) => (calls.push(input), {}), calls };
}

/** Tests run without a DB — pin the M4a session-existence seam explicitly. */
const realSession = { sessionExists: () => true };
const syntheticSession = { sessionExists: () => false };

const baseInput: DeliverAgentEnvelopeInput = {
  projectId: 'p1' as ULID,
  pcSessionId: 'dispatcher-sess-1',
  kind: 'agent-completed',
  slug: 'pc-orchestrator',
  source: 'agent',
  body: 'agent completed body',
  sender: 'pc',
  idempotencyKey: 'agent:run-1:agent-completed',
  sourceId: 'run-1',
};

test('enqueues an orchestrator-session + orchestrator-turn message with the stable key', () => {
  const mb = fakeMailbox();
  const res = deliverAgentEnvelope(baseInput, { mailboxEnqueue: mb.port, ...realSession });
  assert.equal(mb.calls.length, 1);
  const input = mb.calls[0]!;
  assert.equal(input.message.kind, 'agent-terminal');
  assert.equal(input.message.idempotencyKey, 'agent:run-1:agent-completed');
  assert.equal(input.message.body, 'agent completed body');
  // Human subject for the inbox card title (vs the raw [pc:agent-event …] body).
  assert.equal(input.message.subject, 'Agent pc-orchestrator completed');
  assert.equal(input.recipients.length, 1);
  const r = input.recipients[0]!;
  assert.equal(r.channel, 'orchestrator-turn');
  assert.equal(r.addressKind, 'orchestrator-session');
  assert.deepEqual(r.addressJson, {
    kind: 'orchestrator-session',
    projectId: 'p1',
    sessionId: 'dispatcher-sess-1',
  });
  // Mailbox path returns no agent_inbox row + no channel push (legacy fields).
  assert.equal(res.channelDelivered, false);
  assert.equal(res.inboxId, null);
});

test('message-kind mapping: asks ⟹ agent-question, approval ⟹ agent-approval, terminal ⟹ agent-terminal', () => {
  const cases: Array<[DeliverAgentEnvelopeInput['kind'], string]> = [
    ['agent-asks-orchestrator', 'agent-question'],
    ['agent-approval-request', 'agent-approval'],
    ['agent-completed', 'agent-terminal'],
    ['agent-failed', 'agent-terminal'],
    ['agent-queued-started', 'agent-terminal'],
  ];
  for (const [kind, expected] of cases) {
    const mb = fakeMailbox();
    deliverAgentEnvelope({ ...baseInput, kind }, { mailboxEnqueue: mb.port, ...realSession });
    assert.equal(mb.calls[0]!.message.kind, expected, `kind ${kind}`);
  }
});

test('mailbox subject — human title per kind (completed/failed/started use the agent slug)', () => {
  const cases: Array<[DeliverAgentEnvelopeInput['kind'], string]> = [
    ['agent-completed', 'Agent pc-orchestrator completed'],
    ['agent-failed', 'Agent pc-orchestrator failed'],
    ['agent-queued-started', 'Agent pc-orchestrator started'],
  ];
  for (const [kind, expected] of cases) {
    const mb = fakeMailbox();
    deliverAgentEnvelope({ ...baseInput, kind }, { mailboxEnqueue: mb.port, ...realSession });
    assert.equal(mb.calls[0]!.message.subject, expected, `subject for ${kind}`);
  }
});

test('idempotency key is stable per event (re-fire enqueues with the SAME key)', () => {
  const mb = fakeMailbox();
  deliverAgentEnvelope(baseInput, { mailboxEnqueue: mb.port, ...realSession });
  deliverAgentEnvelope(baseInput, { mailboxEnqueue: mb.port, ...realSession }); // a replay / sweep re-fire
  assert.equal(mb.calls.length, 2);
  assert.equal(mb.calls[0]!.message.idempotencyKey, mb.calls[1]!.message.idempotencyKey);
  // The real MailboxService.enqueue dedupes by this key → at most one delivery.
});

// ── M4a — dispatcher-aware addressing (no message silently dies) ─────────────

test('M4a: an ASK from a synthetic dispatcher falls back to active-orchestrator', () => {
  for (const kind of [
    'agent-asks-orchestrator',
    'agent-approval-request',
  ] as const) {
    const mb = fakeMailbox();
    const res = deliverAgentEnvelope(
      { ...baseInput, kind, idempotencyKey: `agent-ask:${kind}` },
      { mailboxEnqueue: mb.port, ...syntheticSession },
    );
    assert.equal(mb.calls.length, 1, `${kind} must still enqueue`);
    const r = mb.calls[0]!.recipients[0]!;
    assert.equal(r.addressKind, 'active-orchestrator', kind);
    assert.deepEqual(r.addressJson, { kind: 'active-orchestrator', projectId: 'p1' });
    assert.equal(r.channel, 'orchestrator-turn');
    assert.notEqual(res.skipped, true);
  }
});

test('M4a: a terminal notice for a synthetic dispatcher is SKIPPED (engine owns the outcome)', () => {
  for (const kind of ['agent-completed', 'agent-failed', 'agent-queued-started'] as const) {
    const mb = fakeMailbox();
    const res = deliverAgentEnvelope(
      { ...baseInput, kind },
      { mailboxEnqueue: mb.port, ...syntheticSession },
    );
    assert.equal(mb.calls.length, 0, `${kind} must not enqueue a doomed envelope`);
    assert.equal(res.skipped, true);
  }
});

test('M4a: a REAL dispatcher session keeps the pinned orchestrator-session address', () => {
  const mb = fakeMailbox();
  deliverAgentEnvelope(
    { ...baseInput, kind: 'agent-asks-orchestrator' },
    { mailboxEnqueue: mb.port, ...realSession },
  );
  assert.equal(mb.calls[0]!.recipients[0]!.addressKind, 'orchestrator-session');
});
