import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ULID } from '@pc/domain';
import type { EnqueueMailboxMessageInput } from '@pc/db';

import {
  deliverAgentEnvelope,
  type DeliverAgentEnvelopeInput,
} from '../src/services/agent-delivery.ts';
import { fixedDeliveryRouter } from '../src/services/delivery-routing.ts';

// A fake ChannelServer that records emitToSession + asserts it's the ONLY
// delivery path used on the channel gate. We never construct a real one.
function fakeChannelServer() {
  const emits: { recipientSessionId: string; body: string }[] = [];
  const cs = {
    emitToSession(input: { recipientSessionId: string; body: string }) {
      emits.push({ recipientSessionId: input.recipientSessionId, body: input.body });
      return true; // pretend a registrant received it
    },
  };
  return { cs, emits };
}

function fakeMailbox() {
  const calls: EnqueueMailboxMessageInput[] = [];
  return { port: (input: EnqueueMailboxMessageInput) => (calls.push(input), {}), calls };
}

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

test('gate=channel — the envelope rides enqueueAndPush/emitToSession; NO mailbox enqueue', () => {
  // channel-only transport so emitToSession is the observable path.
  const prior = process.env.PC_DELIVERY_TRANSPORT;
  process.env.PC_DELIVERY_TRANSPORT = 'channel-only';
  const { cs, emits } = fakeChannelServer();
  const mb = fakeMailbox();
  const res = deliverAgentEnvelope(baseInput, {
    channelServer: cs as never,
    router: fixedDeliveryRouter({ agent: 'channel' }),
    mailboxEnqueue: mb.port,
  });
  assert.equal(emits.length, 1);
  assert.equal(emits[0]!.recipientSessionId, 'dispatcher-sess-1');
  assert.equal(mb.calls.length, 0, 'channel gate must NOT enqueue mailbox');
  assert.equal(res.channelDelivered, true);
  if (prior === undefined) delete process.env.PC_DELIVERY_TRANSPORT;
  else process.env.PC_DELIVERY_TRANSPORT = prior;
});

test('gate=mailbox — enqueues orchestrator-session + orchestrator-turn with the stable key; NO channel push', () => {
  const { cs, emits } = fakeChannelServer();
  const mb = fakeMailbox();
  const res = deliverAgentEnvelope(baseInput, {
    channelServer: cs as never,
    router: fixedDeliveryRouter({ agent: 'mailbox' }),
    mailboxEnqueue: mb.port,
  });
  assert.equal(emits.length, 0, 'mailbox gate must NOT emit to channel');
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
  assert.equal(res.channelDelivered, false);
  assert.equal(res.inboxId, null);
});

test('message-kind mapping: asks ⟹ agent-question, approval ⟹ agent-approval, terminal ⟹ agent-terminal', () => {
  const cases: Array<[DeliverAgentEnvelopeInput['kind'], string]> = [
    ['agent-asks-orchestrator', 'agent-question'],
    ['agent-asks-user', 'agent-question'],
    ['agent-approval-request', 'agent-approval'],
    ['agent-completed', 'agent-terminal'],
    ['agent-failed', 'agent-terminal'],
    ['agent-queued-started', 'agent-terminal'],
  ];
  for (const [kind, expected] of cases) {
    const mb = fakeMailbox();
    deliverAgentEnvelope(
      { ...baseInput, kind },
      {
        channelServer: fakeChannelServer().cs as never,
        router: fixedDeliveryRouter({ agent: 'mailbox' }),
        mailboxEnqueue: mb.port,
      },
    );
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
    deliverAgentEnvelope(
      { ...baseInput, kind },
      {
        channelServer: fakeChannelServer().cs as never,
        router: fixedDeliveryRouter({ agent: 'mailbox' }),
        mailboxEnqueue: mb.port,
      },
    );
    assert.equal(mb.calls[0]!.message.subject, expected, `subject for ${kind}`);
  }
});

test('no-double-delivery — mailbox gate hits exactly one path (mailbox), channel gate hits exactly one (channel)', () => {
  // mailbox
  {
    const { cs, emits } = fakeChannelServer();
    const mb = fakeMailbox();
    deliverAgentEnvelope(baseInput, {
      channelServer: cs as never,
      router: fixedDeliveryRouter({ agent: 'mailbox' }),
      mailboxEnqueue: mb.port,
    });
    assert.equal(emits.length + mb.calls.length, 1);
    assert.equal(mb.calls.length, 1);
  }
  // channel (inbox-only transport — no emitToSession, but enqueueInboxRow path;
  // observable: NO mailbox enqueue)
  {
    const { cs } = fakeChannelServer();
    const mb = fakeMailbox();
    const prior = process.env.PC_DELIVERY_TRANSPORT;
    process.env.PC_DELIVERY_TRANSPORT = 'channel-only';
    const { cs: cs2, emits } = fakeChannelServer();
    deliverAgentEnvelope(baseInput, {
      channelServer: cs2 as never,
      router: fixedDeliveryRouter({ agent: 'channel' }),
      mailboxEnqueue: mb.port,
    });
    assert.equal(mb.calls.length, 0);
    assert.equal(emits.length, 1);
    void cs;
    if (prior === undefined) delete process.env.PC_DELIVERY_TRANSPORT;
    else process.env.PC_DELIVERY_TRANSPORT = prior;
  }
});

test('mailbox gate with NO port wired falls back to channel (boot/sweep recovery-path behavior)', () => {
  const prior = process.env.PC_DELIVERY_TRANSPORT;
  process.env.PC_DELIVERY_TRANSPORT = 'channel-only';
  const { cs, emits } = fakeChannelServer();
  const res = deliverAgentEnvelope(baseInput, {
    channelServer: cs as never,
    router: fixedDeliveryRouter({ agent: 'mailbox' }),
    mailboxEnqueue: null, // no port (recovery-path emitters)
  });
  assert.equal(emits.length, 1, 'no port ⟹ Channel fallback even when gated mailbox');
  assert.equal(res.channelDelivered, true);
  if (prior === undefined) delete process.env.PC_DELIVERY_TRANSPORT;
  else process.env.PC_DELIVERY_TRANSPORT = prior;
});

test('idempotency key is stable per event (re-fire enqueues with the SAME key)', () => {
  const mb = fakeMailbox();
  const deps = {
    channelServer: fakeChannelServer().cs as never,
    router: fixedDeliveryRouter({ agent: 'mailbox' }),
    mailboxEnqueue: mb.port,
  };
  deliverAgentEnvelope(baseInput, deps);
  deliverAgentEnvelope(baseInput, deps); // a replay / sweep re-fire
  assert.equal(mb.calls.length, 2);
  assert.equal(mb.calls[0]!.message.idempotencyKey, mb.calls[1]!.message.idempotencyKey);
  // The real MailboxService.enqueue dedupes by this key → at most one delivery.
});
