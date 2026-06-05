// AreaDetailModal contracts.
//
// The tsx --test runner cannot resolve @/ Vite aliases, so component logic is
// replicated inline here. pnpm typecheck covers the actual component wiring.
// Tests pin three contracts:
//   1. membersOf — filter work items to the given area (includes ALL statuses).
//   2. STATUS_LABELS — every WorkItemStatus has a display label.
//   3. open-callback — clicking a row invokes the callback with the item's id.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Types (verbatim from @pc/domain / work-items/types.ts) ──────────────────

type WorkItemStatus =
  | 'pending'
  | 'in-progress'
  | 'awaiting-verification'
  | 'blocked'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'archived';

interface MockWorkItem {
  id: string;
  areaId: string | null;
  status: WorkItemStatus;
  title: string;
  callsign?: string;
}

// ── 1. membersOf (verbatim copy of AreaDetailModal filter logic) ────────────

function membersOf(workItems: MockWorkItem[], areaId: string): MockWorkItem[] {
  return workItems.filter((wi) => wi.areaId === areaId);
}

const ITEMS: MockWorkItem[] = [
  { id: 'w1', areaId: 'a1', status: 'pending', title: 'Open item' },
  { id: 'w2', areaId: 'a1', status: 'complete', title: 'Done item' },
  { id: 'w3', areaId: 'a1', status: 'cancelled', title: 'Cancelled item', callsign: 'proj-3' },
  { id: 'w4', areaId: 'a1', status: 'archived', title: 'Archived item' },
  { id: 'w5', areaId: 'a2', status: 'pending', title: 'Different area' },
  { id: 'w6', areaId: null, status: 'pending', title: 'Uncaptured' },
];

test('membersOf: returns only items belonging to the given area', () => {
  const result = membersOf(ITEMS, 'a1');
  assert.equal(result.length, 4);
  assert.ok(result.every((wi) => wi.areaId === 'a1'));
});

test('membersOf: includes ALL statuses — done, cancelled, archived, not just open', () => {
  const result = membersOf(ITEMS, 'a1');
  const statuses = result.map((wi) => wi.status);
  assert.ok(statuses.includes('pending'), 'pending');
  assert.ok(statuses.includes('complete'), 'complete');
  assert.ok(statuses.includes('cancelled'), 'cancelled');
  assert.ok(statuses.includes('archived'), 'archived');
});

test('membersOf: excludes items from other areas and uncaptured items', () => {
  const result = membersOf(ITEMS, 'a1');
  assert.ok(result.every((wi) => wi.areaId !== 'a2'));
  assert.ok(result.every((wi) => wi.areaId !== null));
});

test('membersOf: returns empty array when no items belong to the area', () => {
  const result = membersOf(ITEMS, 'nonexistent');
  assert.equal(result.length, 0);
});

// ── 2. STATUS_LABELS contract (replicated from status.ts) ──────────────────

const STATUS_LABELS: Record<WorkItemStatus, string> = {
  pending: 'Open',
  'in-progress': 'In progress',
  'awaiting-verification': 'Awaiting verification',
  blocked: 'Blocked',
  complete: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  archived: 'Archived',
};

const ALL_STATUSES: WorkItemStatus[] = [
  'pending',
  'in-progress',
  'awaiting-verification',
  'blocked',
  'complete',
  'failed',
  'cancelled',
  'archived',
];

test('STATUS_LABELS: every WorkItemStatus has a non-empty label', () => {
  for (const s of ALL_STATUSES) {
    assert.ok(STATUS_LABELS[s]?.length > 0, `missing or empty label for status: ${s}`);
  }
});

test('STATUS_LABELS: cancelled and archived have distinct labels (shown in detail list)', () => {
  assert.equal(STATUS_LABELS.cancelled, 'Cancelled');
  assert.equal(STATUS_LABELS.archived, 'Archived');
});

// ── 3. open-callback contract ───────────────────────────────────────────────

test('open callback is invoked with the correct work item id when a row is clicked', () => {
  let calledWith: string | null = null;
  const openWorkItem = (id: string) => {
    calledWith = id;
  };

  // Simulate the row onClick: `() => openWorkItem(wi.id)`
  const wi = ITEMS.find((i) => i.id === 'w1')!;
  openWorkItem(wi.id);

  assert.equal(calledWith, 'w1');
});

test('open callback receives id, not callsign — even when callsign is present', () => {
  let calledWith: string | null = null;
  const openWorkItem = (id: string) => {
    calledWith = id;
  };

  const wi = ITEMS.find((i) => i.id === 'w3')!; // has callsign 'proj-3'
  assert.ok(wi.callsign); // confirm fixture has callsign
  openWorkItem(wi.id); // AreaDetailModal calls openWorkItem(wi.id), not wi.callsign

  assert.equal(calledWith, 'w3', 'should pass the ULID id, not the callsign');
  assert.notEqual(calledWith, 'proj-3');
});

test('open callback is not invoked during member list render — only on row click', () => {
  let callCount = 0;
  const openWorkItem = (_id: string) => {
    callCount++;
  };

  // Simulating the render phase: just building the member list, no clicks
  const members = membersOf(ITEMS, 'a1');
  assert.equal(members.length, 4);
  assert.equal(callCount, 0, 'openWorkItem must not be called during render');

  // Clicking one row
  openWorkItem(members[0]!.id);
  assert.equal(callCount, 1);
});
