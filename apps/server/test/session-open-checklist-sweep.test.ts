// Slice F — session-open checklist sweep: formatter + filter + idempotency.
//
// Three properties verified:
//   1. Formatter/filter excludes items with no checklist, empty checklist, or
//      all-done checklist; includes only cards with at least one open box.
//   2. Formatter renders cards as pc://work-item/<callsign> markdown links with
//      each card's OPEN boxes listed (done boxes not repeated).
//   3. Idempotency: two ready-transitions with the same sessionId produce the
//      same clientMessageId, which causes enqueueRuntimeTurn to dedupe.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { WorkItem, DoneChecklistItem } from '@pc/domain';

import {
  collectOpenChecklistCards,
  formatSweepBlock,
  sweepClientMessageId,
} from '../src/services/session-open-checklist-sweep.ts';

// ── minimal fixture builder ──────────────────────────────────────────────────

function makeItem(
  overrides: Partial<WorkItem> & { title: string; callsign: string | null },
): WorkItem {
  return {
    id: overrides.callsign ?? 'id-001',
    projectId: 'proj-1',
    parentId: null,
    position: 0,
    body: '',
    stageId: 'backlog',
    status: 'pending',
    statusReason: null,
    type: 'task',
    fields: {},
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    history: [],
    areaId: null,
    focusedAt: null,
    doneChecklist: null,
    ...overrides,
  } satisfies WorkItem;
}

function makeChecklist(...items: Array<{ label: string; done: boolean }>): DoneChecklistItem[] {
  return items.map((i, idx) => ({
    id: `item-${idx}`,
    label: i.label,
    done: i.done,
    kind: 'manual' as const,
  }));
}

// ── 1. filter: exclusion rules ────────────────────────────────────────────────

test('collectOpenChecklistCards: item with no checklist is excluded', () => {
  const item = makeItem({ title: 'no checklist', callsign: 'pc-1', doneChecklist: null });
  assert.deepEqual(collectOpenChecklistCards([item]), []);
});

test('collectOpenChecklistCards: item with empty checklist is excluded', () => {
  const item = makeItem({ title: 'empty', callsign: 'pc-2', doneChecklist: [] });
  assert.deepEqual(collectOpenChecklistCards([item]), []);
});

test('collectOpenChecklistCards: item with all-done checklist is excluded', () => {
  const item = makeItem({
    title: 'all done',
    callsign: 'pc-3',
    doneChecklist: makeChecklist(
      { label: 'Step A', done: true },
      { label: 'Step B', done: true },
    ),
  });
  assert.deepEqual(collectOpenChecklistCards([item]), []);
});

test('collectOpenChecklistCards: item with at least one open box is included', () => {
  const item = makeItem({
    title: 'in progress',
    callsign: 'pc-4',
    doneChecklist: makeChecklist(
      { label: 'Step A', done: true },
      { label: 'Step B', done: false },
    ),
  });
  const result = collectOpenChecklistCards([item]);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.callsign, 'pc-4');
  assert.deepEqual(result[0]!.openItems, ['Step B']);
});

test('collectOpenChecklistCards: mixed list — only cards with open boxes survive', () => {
  const items = [
    makeItem({ title: 'no checklist', callsign: 'pc-a', doneChecklist: null }),
    makeItem({
      title: 'open',
      callsign: 'pc-b',
      doneChecklist: makeChecklist({ label: 'Merge', done: false }),
    }),
    makeItem({
      title: 'all done',
      callsign: 'pc-c',
      doneChecklist: makeChecklist({ label: 'Done', done: true }),
    }),
    makeItem({
      title: 'partly done',
      callsign: 'pc-d',
      doneChecklist: makeChecklist(
        { label: 'X', done: true },
        { label: 'Y', done: false },
      ),
    }),
  ];
  const result = collectOpenChecklistCards(items);
  assert.equal(result.length, 2);
  assert.equal(result[0]!.callsign, 'pc-b');
  assert.equal(result[1]!.callsign, 'pc-d');
});

// ── 2. formatter: link + open-box rendering ───────────────────────────────────

test('formatSweepBlock: returns null when cards array is empty', () => {
  assert.equal(formatSweepBlock([]), null);
});

test('formatSweepBlock: renders [pc:system kind=session-open-checklist-sweep] header', () => {
  const cards = [{ callsign: 'pc-10', title: 'My card', openItems: ['Do thing'] }];
  const block = formatSweepBlock(cards)!;
  assert.ok(block.startsWith('[pc:system kind=session-open-checklist-sweep]'), 'must start with marker');
});

test('formatSweepBlock: renders card as pc://work-item/<callsign> markdown link', () => {
  const cards = [{ callsign: 'pc-10', title: 'My card', openItems: ['Do thing'] }];
  const block = formatSweepBlock(cards)!;
  assert.ok(
    block.includes('[pc-10](pc://work-item/pc-10)'),
    'must include markdown link with callsign as text and pc:// href',
  );
});

test('formatSweepBlock: renders card title after the link', () => {
  const cards = [{ callsign: 'pc-10', title: 'My special card', openItems: ['Do thing'] }];
  const block = formatSweepBlock(cards)!;
  assert.ok(block.includes('My special card'), 'title must be in the block');
});

test('formatSweepBlock: renders open items as [ ] prefixed lines', () => {
  const cards = [{
    callsign: 'pc-20',
    title: 'Card',
    openItems: ['Write tests', 'Merge PR'],
  }];
  const block = formatSweepBlock(cards)!;
  assert.ok(block.includes('  [ ] Write tests'), 'open item must be indented [ ]');
  assert.ok(block.includes('  [ ] Merge PR'), 'second open item must be present');
});

test('formatSweepBlock: multiple cards each get their own section', () => {
  const cards = [
    { callsign: 'pc-30', title: 'Card A', openItems: ['Step 1'] },
    { callsign: 'pc-31', title: 'Card B', openItems: ['Step 2', 'Step 3'] },
  ];
  const block = formatSweepBlock(cards)!;
  assert.ok(block.includes('[pc-30](pc://work-item/pc-30)'), 'card A link present');
  assert.ok(block.includes('[pc-31](pc://work-item/pc-31)'), 'card B link present');
  assert.ok(block.includes('  [ ] Step 1'), 'card A item present');
  assert.ok(block.includes('  [ ] Step 2'), 'card B first item present');
  assert.ok(block.includes('  [ ] Step 3'), 'card B second item present');
});

// ── 3. idempotency ────────────────────────────────────────────────────────────

test('sweepClientMessageId: same sessionId → same clientMessageId (send-queue dedupe key)', () => {
  const sessionId = '01HZEXAMPLESESSION01';
  assert.strictEqual(sweepClientMessageId(sessionId), sweepClientMessageId(sessionId));
  assert.strictEqual(sweepClientMessageId(sessionId), `session-open-sweep:${sessionId}`);
});

test('sweepClientMessageId: different sessionIds → different clientMessageIds (new session re-sweeps)', () => {
  assert.notStrictEqual(
    sweepClientMessageId('sess-aaa'),
    sweepClientMessageId('sess-bbb'),
  );
});

test('idempotency: two ready-transitions with the same sessionId call enqueue with the same clientMessageId', () => {
  // Simulate the inner logic: both transitions would call enqueueRuntimeTurn
  // with the same clientMessageId → the second is a no-op at the DB layer.
  const sessionId = '01HZEXAMPLESESSION99';
  const enqueuedIds: string[] = [];

  // Simulate what enqueueSessionOpenSweepForProject does internally,
  // isolated to the idempotency-key invariant.
  function simulateReadyTransition(): void {
    const cards = [{ callsign: 'pc-99', title: 'Stale card', openItems: ['Finish it'] }];
    const text = formatSweepBlock(cards);
    if (!text) return;
    const clientMessageId = sweepClientMessageId(sessionId);
    enqueuedIds.push(clientMessageId);
  }

  // Two ready transitions (e.g. busy→ready twice, or restart→ready):
  simulateReadyTransition();
  simulateReadyTransition();

  assert.equal(enqueuedIds.length, 2, 'both transitions attempt to enqueue');
  assert.strictEqual(
    enqueuedIds[0],
    enqueuedIds[1],
    'same clientMessageId both times — DB dedupe prevents second injection',
  );
  assert.ok(
    enqueuedIds[0]!.startsWith('session-open-sweep:'),
    'clientMessageId uses the sweep prefix',
  );
});
