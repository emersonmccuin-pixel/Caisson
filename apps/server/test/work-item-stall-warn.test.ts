// pc-pty-chat-433 — A3 work-item stall sweep. Fully deps-injected, no DB:
// covers the emit-once per-item debounce, episode reset on activity, the
// per-project notification shape, and the restart-stable idempotency key.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { BoardHealthItem, EnqueueMailboxMessageInput } from '@pc/db';
import type { ULID } from '@pc/domain';

import { sweepWorkItemStallWarn } from '../src/services/work-item-stall-warn.ts';

function makeItem(patch: Partial<BoardHealthItem> = {}): BoardHealthItem {
  return {
    id: '01ITEM000001XXXXXXXXXXXXXX' as ULID,
    callsign: 'test-1',
    title: 'Fix the bug',
    stageId: 'draft',
    status: 'pending',
    ageInStageDays: 10,
    lastActivityAt: 0,
    ...patch,
  };
}

function makeProject(
  patch: Partial<{ id: ULID; name: string }> = {},
): { id: ULID; name: string } {
  return { id: 'proj-0000000000001' as ULID, name: 'Test Project', ...patch };
}

test('no stalled items -> no mailbox call, result zeroed', () => {
  const calls: EnqueueMailboxMessageInput[] = [];
  const result = sweepWorkItemStallWarn({
    notifiedItems: new Map(),
    mailboxEnqueue: (m) => calls.push(m),
    listProjects: () => [makeProject()],
    getBoardHealth: () => ({ stalledItems: [] }),
  });
  assert.equal(calls.length, 0);
  assert.equal(result.checked, 1);
  assert.equal(result.notified, 0);
  assert.equal(result.newStalled, 0);
});

test('first sweep: stalled items -> one mailbox message with correct fields', () => {
  const calls: EnqueueMailboxMessageInput[] = [];
  sweepWorkItemStallWarn({
    notifiedItems: new Map(),
    mailboxEnqueue: (m) => calls.push(m),
    listProjects: () => [makeProject({ name: 'My Project' })],
    getBoardHealth: () => ({ stalledItems: [makeItem()] }),
  });
  assert.equal(calls.length, 1);
  const msg = calls[0].message;
  assert.equal(msg.kind, 'work-item-stalled');
  assert.equal(msg.sourceKind, 'system');
  assert.equal(msg.sourceId, null);
  assert.ok(msg.body.includes('My Project'), 'body mentions project name');
  assert.ok(msg.subject?.includes('My Project'), 'subject mentions project name');
  assert.equal(calls[0].recipients.length, 1);
  assert.equal(calls[0].recipients[0].addressKind, 'active-orchestrator');
  assert.equal(calls[0].recipients[0].channel, 'orchestrator-turn');
});

test('second sweep: same stalled items -> no re-notification (debounced)', () => {
  const calls: EnqueueMailboxMessageInput[] = [];
  const notifiedItems = new Map<string, Set<string>>();
  const deps = {
    notifiedItems,
    mailboxEnqueue: (m: EnqueueMailboxMessageInput) => calls.push(m),
    listProjects: () => [makeProject()],
    getBoardHealth: () => ({ stalledItems: [makeItem()] }),
  };
  sweepWorkItemStallWarn(deps);
  sweepWorkItemStallWarn(deps);
  assert.equal(calls.length, 1, 'second sweep must not re-notify the same items');
});

test('new item stalls after initial notification -> new message for that project', () => {
  const calls: EnqueueMailboxMessageInput[] = [];
  const notifiedItems = new Map<string, Set<string>>();
  const itemA = makeItem({ id: 'item-AAAA' as ULID, callsign: 'proj-1' });
  const itemB = makeItem({ id: 'item-BBBB' as ULID, callsign: 'proj-2' });
  sweepWorkItemStallWarn({
    notifiedItems,
    mailboxEnqueue: (m) => calls.push(m),
    listProjects: () => [makeProject()],
    getBoardHealth: () => ({ stalledItems: [itemA] }),
  });
  assert.equal(calls.length, 1);
  sweepWorkItemStallWarn({
    notifiedItems,
    mailboxEnqueue: (m) => calls.push(m),
    listProjects: () => [makeProject()],
    getBoardHealth: () => ({ stalledItems: [itemA, itemB] }),
  });
  assert.equal(calls.length, 2, 'new stalled item triggers a second notification');
});

test('item regains activity then stalls again -> re-notified (new episode)', () => {
  const calls: EnqueueMailboxMessageInput[] = [];
  const notifiedItems = new Map<string, Set<string>>();
  const itemA = makeItem({ id: 'item-AAAA' as ULID });
  sweepWorkItemStallWarn({ notifiedItems, mailboxEnqueue: (m) => calls.push(m), listProjects: () => [makeProject()], getBoardHealth: () => ({ stalledItems: [itemA] }) });
  assert.equal(calls.length, 1);
  sweepWorkItemStallWarn({ notifiedItems, mailboxEnqueue: (m) => calls.push(m), listProjects: () => [makeProject()], getBoardHealth: () => ({ stalledItems: [] }) });
  assert.equal(calls.length, 1, 'cleared item must not trigger a new message');
  sweepWorkItemStallWarn({ notifiedItems, mailboxEnqueue: (m) => calls.push(m), listProjects: () => [makeProject()], getBoardHealth: () => ({ stalledItems: [itemA] }) });
  assert.equal(calls.length, 2, 're-stalled item after activity gets a new notification');
});

test('mailboxEnqueue absent -> result counts correct, no crash', () => {
  const notifiedItems = new Map<string, Set<string>>();
  const result = sweepWorkItemStallWarn({
    notifiedItems,
    mailboxEnqueue: null,
    listProjects: () => [makeProject()],
    getBoardHealth: () => ({ stalledItems: [makeItem()] }),
  });
  assert.equal(result.checked, 1);
  assert.equal(result.notified, 0, 'no enqueue -> nothing counted as notified');
  assert.equal(result.newStalled, 0);
});

test('multiple projects notified independently', () => {
  const calls: EnqueueMailboxMessageInput[] = [];
  const notifiedItems = new Map<string, Set<string>>();
  sweepWorkItemStallWarn({
    notifiedItems,
    mailboxEnqueue: (m) => calls.push(m),
    listProjects: () => [
      makeProject({ id: 'proj-P1' as ULID, name: 'Alpha' }),
      makeProject({ id: 'proj-P2' as ULID, name: 'Beta' }),
    ],
    getBoardHealth: (pid) => ({ stalledItems: [makeItem({ id: (pid + '-item') as ULID })] }),
  });
  assert.equal(calls.length, 2, 'one message per project');
  assert.ok(calls.some((c) => c.message.body.includes('Alpha')));
  assert.ok(calls.some((c) => c.message.body.includes('Beta')));
});

test('idempotency key stable for same new-item set (cross-restart safe)', () => {
  const calls: EnqueueMailboxMessageInput[] = [];
  const itemA = makeItem({ id: 'item-AAAA' as ULID });
  sweepWorkItemStallWarn({ notifiedItems: new Map(), mailboxEnqueue: (m) => calls.push(m), listProjects: () => [makeProject()], getBoardHealth: () => ({ stalledItems: [itemA] }) });
  sweepWorkItemStallWarn({ notifiedItems: new Map(), mailboxEnqueue: (m) => calls.push(m), listProjects: () => [makeProject()], getBoardHealth: () => ({ stalledItems: [itemA] }) });
  assert.equal(calls[0].message.idempotencyKey, calls[1].message.idempotencyKey, 'same new items -> same idempotency key');
});

test('result counts reflect notifications sent', () => {
  const calls: EnqueueMailboxMessageInput[] = [];
  const notifiedItems = new Map<string, Set<string>>();
  const result = sweepWorkItemStallWarn({
    notifiedItems,
    mailboxEnqueue: (m) => calls.push(m),
    listProjects: () => [
      makeProject({ id: 'proj-P1' as ULID, name: 'P1' }),
      makeProject({ id: 'proj-P2' as ULID, name: 'P2' }),
    ],
    getBoardHealth: (pid) => ({
      stalledItems: [
        makeItem({ id: (pid + '-A') as ULID }),
        makeItem({ id: (pid + '-B') as ULID }),
      ],
    }),
  });
  assert.equal(result.checked, 2);
  assert.equal(result.notified, 2);
  assert.equal(result.newStalled, 4, '2 new items per project x 2 projects');
});
