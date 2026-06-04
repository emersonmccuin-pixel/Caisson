// P9/FD-17 — deliverable-skip nudge (the "marco" class). Pure unit, no DB:
// strike 1 injects the marked reminder, strike 2 escalates ONCE to the
// orchestrator, then silence; paused / delivered / contract-less runs are
// never touched. Never a kill.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AgentRunRow, AgentRunStatus, ULID } from '@pc/domain';
import type { EnqueueMailboxMessageInput } from '@pc/db';

import {
  DELIVERABLE_NUDGE_TEXT,
  onWorkerTurnEndWithoutDeliverable,
} from '../src/services/agent-run-deliverable-nudge.ts';

function row(patch: Partial<AgentRunRow> = {}): AgentRunRow {
  return {
    id: 'run-1' as ULID,
    projectId: 'proj-1' as ULID,
    dispatcherSessionId: 'disp-1',
    ccSessionId: 'cc-1',
    podName: 'writer',
    podRevisionAtDispatch: null,
    podRevisionAtResume: null,
    status: 'running' as AgentRunStatus,
    continues: null,
    parentInvokeDepth: 0,
    parentWorkItemId: null,
    input: 'go',
    result: null,
    failureCause: null,
    failureReason: null,
    queuedAt: 1000,
    spawnedAt: 2000,
    readyAt: 3000,
    pid: null,
    lastActivityAt: 5000,
    deliveredAt: null,
    contractId: 'ct-1' as ULID,
    completedAt: null,
    rev: 0,
    ...patch,
  };
}

function harness() {
  const strikes = new Map<string, number>();
  const sends: Array<{ runId: string; text: string }> = [];
  const enqueued: EnqueueMailboxMessageInput[] = [];
  const fire = (r: AgentRunRow) =>
    onWorkerTurnEndWithoutDeliverable(r, {
      strikes,
      sendToRun: (runId, text) => sends.push({ runId, text }),
      mailboxEnqueue: (input) => enqueued.push(input as EnqueueMailboxMessageInput),
      now: () => 99_000,
    });
  return { strikes, sends, enqueued, fire };
}

test('strike 1: marked reminder injected into the run, no mailbox', () => {
  const h = harness();
  assert.equal(h.fire(row()), 'nudged');
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].runId, 'run-1');
  assert.equal(h.sends[0].text, DELIVERABLE_NUDGE_TEXT);
  assert.match(h.sends[0].text, /^\[pc:system kind=deliverable-nudge\]/);
  assert.match(h.sends[0].text, /pc_submit_deliverable/);
  assert.match(h.sends[0].text, /pc_ask_orchestrator/);
  assert.equal(h.enqueued.length, 0);
});

test('strike 2: ONE agent-stalled escalation to the active orchestrator; then silence', () => {
  const h = harness();
  h.fire(row());
  assert.equal(h.fire(row()), 'notified');
  assert.equal(h.enqueued.length, 1);
  const msg = h.enqueued[0].message;
  assert.equal(msg.kind, 'agent-stalled');
  assert.equal(msg.idempotencyKey, 'agent-no-deliverable:run-1');
  assert.match(msg.body, /TWICE/);
  assert.match(msg.body, /NOT been killed/);
  const rcpt = h.enqueued[0].recipients[0];
  assert.equal(rcpt.addressKind, 'active-orchestrator');
  assert.equal(rcpt.channel, 'orchestrator-turn');

  // Strike 3+ — the orchestrator owns it; no nudge spam, no second mailbox.
  assert.equal(h.fire(row()), 'exhausted');
  assert.equal(h.sends.length, 1);
  assert.equal(h.enqueued.length, 1);
});

test('paused / terminal / delivered / contract-less runs are never touched', () => {
  const h = harness();
  assert.equal(h.fire(row({ status: 'paused' })), 'skipped');
  assert.equal(h.fire(row({ status: 'completed' })), 'skipped');
  assert.equal(h.fire(row({ deliveredAt: 50_000 })), 'skipped');
  assert.equal(h.fire(row({ contractId: null })), 'skipped');
  assert.equal(h.sends.length, 0);
  assert.equal(h.enqueued.length, 0);
  assert.equal(h.strikes.size, 0);
});
