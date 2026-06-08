// M4b (FD-8) — stale-ask watchdog: an open pc_ask_* past the threshold mints
// ONE `agent-ask-escalated` message addressed to the active-orchestrator
// (idempotency `ask-stale:<askId>`); fresher asks are untouched. Agents never
// reach the human directly (pc-pty-chat-317 / doctrine).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STALE_ASK_THRESHOLD_MS,
  sweepStalePendingAsks,
  type PendingAskWatchdogDeps,
} from '../src/services/pending-ask-watchdog.ts';
import type { EnqueueMailboxMessageInput } from '@pc/db';
import type { PendingAskRow, ULID } from '@pc/domain';

const NOW = 1_700_000_000_000;

function ask(over: Partial<PendingAskRow> = {}): PendingAskRow {
  return {
    id: 'ask-1' as ULID,
    agentRunId: 'run-1' as ULID,
    ccSessionId: 'cc-1',
    projectId: 'proj-1' as ULID,
    parentWorkItemId: null,
    kind: 'orchestrator',
    promptBody: 'Which region should I target?',
    context: 'two candidates',
    options: [
      { label: 'US', value: 'us' },
      { label: 'EU', value: 'eu' },
    ],
    status: 'open',
    answerBody: null,
    answeredBy: null,
    createdAt: NOW - STALE_ASK_THRESHOLD_MS - 60_000,
    answeredAt: null,
    cancelledAt: null,
    ...over,
  };
}

function harness(stale: PendingAskRow[]) {
  const enqueued: EnqueueMailboxMessageInput[] = [];
  const cutoffs: number[] = [];
  const deps: PendingAskWatchdogDeps = {
    mailboxEnqueue: (input) => {
      enqueued.push(input as EnqueueMailboxMessageInput);
      return undefined;
    },
    listStaleOpenAsks: (cutoff) => {
      cutoffs.push(cutoff);
      return stale;
    },
    getPodName: () => 'researcher',
    now: () => NOW,
  };
  return { deps, enqueued, cutoffs };
}

test('a stale ask mints one agent-ask-escalated orchestrator message with the ask payload', () => {
  const h = harness([ask()]);
  const escalated = sweepStalePendingAsks(h.deps);
  assert.equal(escalated, 1);
  assert.equal(h.enqueued.length, 1);
  const msg = h.enqueued[0]!.message;
  assert.equal(msg.kind, 'agent-ask-escalated');
  assert.equal(msg.idempotencyKey, 'ask-stale:ask-1');
  assert.equal(msg.sourceKind, 'agent');
  assert.equal(msg.sourceId, 'ask-1');
  assert.equal(msg.projectId, 'proj-1');
  assert.match(msg.subject ?? '', /researcher has been waiting \d+m on a question/);
  const payload = msg.payload as Record<string, unknown>;
  assert.equal(payload.pendingAskId, 'ask-1');
  assert.equal(payload.agentRunId, 'run-1');
  assert.deepEqual(payload.options, [
    { label: 'US', value: 'us' },
    { label: 'EU', value: 'eu' },
  ]);
  // Doctrine (pc-pty-chat-317): agents never reach the human directly —
  // escalated asks go to the orchestrator, NOT to the user inbox.
  const recipient = h.enqueued[0]!.recipients[0]!;
  assert.equal(recipient.addressKind, 'active-orchestrator');
  assert.equal(recipient.channel, 'orchestrator-turn');
});

test('the sweep queries with now - threshold as the cutoff', () => {
  const h = harness([]);
  sweepStalePendingAsks(h.deps);
  assert.deepEqual(h.cutoffs, [NOW - STALE_ASK_THRESHOLD_MS]);
  assert.equal(h.enqueued.length, 0);
});

test('an approval ask words the subject as an approval', () => {
  const h = harness([ask({ kind: 'approval' })]);
  sweepStalePendingAsks(h.deps);
  assert.match(h.enqueued[0]!.message.subject ?? '', /waiting \d+m on an approval/);
});

test('multiple stale asks each get their own idempotency key', () => {
  const h = harness([ask(), ask({ id: 'ask-2' as ULID })]);
  const escalated = sweepStalePendingAsks(h.deps);
  assert.equal(escalated, 2);
  assert.deepEqual(
    h.enqueued.map((e) => e.message.idempotencyKey),
    ['ask-stale:ask-1', 'ask-stale:ask-2'],
  );
});

test('an unknown run falls back to a generic agent name', () => {
  const h = harness([ask()]);
  h.deps.getPodName = () => null;
  sweepStalePendingAsks(h.deps);
  assert.match(h.enqueued[0]!.message.subject ?? '', /^Agent agent has been waiting/);
});
