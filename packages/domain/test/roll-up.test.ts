// Slice 1 (Areas + context model) — unit tests for the roll-up decision engine.
//
// Tests pure functions only — no DB, no effects.
//
// Covers:
//   decideContractCompletion:
//     - leaf (no children) → 'complete'
//     - parent with children → 'accept-only'
//     - parent with all-done children → 'accept-only' (cascade handles it)
//     - workflow root with children → 'complete' (Rule 2 exemption)
//     - workflow root leaf → 'complete'
//
//   planRollUp:
//     - leaf, parent has another open child → no roll-up
//     - last child completes → parent rolls up
//     - multi-level chain → cascades to root
//     - workflow-root parent → stops at it (not completed by roll-up)
//     - parent with zero children edge → no roll-up
//     - already-complete ancestor → skipped, continues upward
//     - cycle guard → doesn't loop

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideContractCompletion,
  planRollUp,
  type WorkItemSnapshot,
} from '../src/roll-up.ts';
import type { WorkItem } from '../src/work-item.ts';

// ── decideContractCompletion ──────────────────────────────────────────────────

test('decideContractCompletion: leaf (no children) → complete', () => {
  assert.equal(decideContractCompletion({ childCount: 0, isWorkflowRoot: false }), 'complete');
});

test('decideContractCompletion: parent with open children → accept-only', () => {
  assert.equal(decideContractCompletion({ childCount: 3, isWorkflowRoot: false }), 'accept-only');
});

test('decideContractCompletion: parent with children (all done still) → accept-only (cascade governs)', () => {
  // Even if all children happen to be done, acceptContract sees childCount > 0
  // and defers to cascade. planRollUp is what fires the completion.
  assert.equal(decideContractCompletion({ childCount: 1, isWorkflowRoot: false }), 'accept-only');
});

test('decideContractCompletion: workflow root with children → complete (Rule 2)', () => {
  // Workflow roots are exempt — run completion drives them regardless of children.
  assert.equal(decideContractCompletion({ childCount: 5, isWorkflowRoot: true }), 'complete');
});

test('decideContractCompletion: workflow root leaf → complete', () => {
  assert.equal(decideContractCompletion({ childCount: 0, isWorkflowRoot: true }), 'complete');
});

// ── planRollUp ────────────────────────────────────────────────────────────────

/** Minimal WorkItemSnapshot factory. */
function snap(
  id: string,
  opts: {
    parentId?: string | null;
    isWorkflowRoot?: boolean;
    status?: WorkItem['status'];
  } = {},
): WorkItemSnapshot {
  return {
    id: id as import('@pc/domain').ULID,
    parentId: (opts.parentId ?? null) as import('@pc/domain').ULID | null,
    isWorkflowRoot: opts.isWorkflowRoot ?? false,
    status: opts.status ?? 'pending',
  };
}

/** Minimal child entry factory for getChildren. */
function child(id: string, status: WorkItem['status'] = 'complete'): Pick<WorkItem, 'id' | 'status'> {
  return { id: id as import('@pc/domain').ULID, status };
}

test('planRollUp: leaf completes, parent has another open child → no roll-up', () => {
  // Parent "P" has children "C1" (just completed) and "C2" (still pending).
  const snapshots: Record<string, WorkItemSnapshot> = {
    C1: snap('C1', { parentId: 'P' }),
    P: snap('P', { parentId: null }),
  };
  const childMap: Record<string, Pick<WorkItem, 'id' | 'status'>[]> = {
    P: [child('C1', 'complete'), child('C2', 'pending')],
  };

  const result = planRollUp({
    completedWorkItemId: 'C1' as import('@pc/domain').ULID,
    getParent: (id) => snapshots[id] ? { ...snapshots[id] } : null,
    // getParent for C1 returns P
    getChildren: (id) => childMap[id] ?? [],
  });

  assert.deepEqual(result, [], 'no roll-up when sibling is pending');
});

test('planRollUp: last child completes → parent rolls up', () => {
  const snapshots: Record<string, WorkItemSnapshot> = {
    C1: snap('C1', { parentId: 'P' }),
    P: snap('P', { parentId: null }),
  };
  // Both C1 and C2 are complete — C2 just completed (trigger), C1 was already done.
  const childMap: Record<string, Pick<WorkItem, 'id' | 'status'>[]> = {
    P: [child('C1', 'complete'), child('C2', 'complete')],
  };

  const result = planRollUp({
    completedWorkItemId: 'C2' as import('@pc/domain').ULID,
    getParent: (id) => {
      if (id === 'C2') return snapshots['P'] ?? null;
      return null;
    },
    getChildren: (id) => childMap[id] ?? [],
  });

  assert.deepEqual(result, ['P']);
});

test('planRollUp: multi-level chain → cascades to root', () => {
  // Tree: GRAND → PARENT → CHILD (just completed)
  // PARENT has only CHILD; GRAND has only PARENT.
  const snapshots: Record<string, WorkItemSnapshot> = {
    CHILD: snap('CHILD', { parentId: 'PARENT' }),
    PARENT: snap('PARENT', { parentId: 'GRAND' }),
    GRAND: snap('GRAND', { parentId: null }),
  };
  const childMap: Record<string, Pick<WorkItem, 'id' | 'status'>[]> = {
    PARENT: [child('CHILD', 'complete')],
    GRAND: [child('PARENT', 'complete')], // PARENT will be completed by cascade
  };

  const result = planRollUp({
    completedWorkItemId: 'CHILD' as import('@pc/domain').ULID,
    getParent: (id) => {
      if (id === 'CHILD') return snapshots['PARENT'] ?? null;
      if (id === 'PARENT') return snapshots['GRAND'] ?? null;
      return null;
    },
    getChildren: (id) => childMap[id] ?? [],
  });

  // Should cascade: PARENT first, then GRAND.
  assert.deepEqual(result, ['PARENT', 'GRAND']);
});

test('planRollUp: workflow-root parent → stops at it (not completed by roll-up)', () => {
  const wfRoot = snap('WF_ROOT', { parentId: null, isWorkflowRoot: true });
  const snapshots: Record<string, WorkItemSnapshot> = {
    CHILD: snap('CHILD', { parentId: 'WF_ROOT' }),
    WF_ROOT: wfRoot,
  };
  const childMap: Record<string, Pick<WorkItem, 'id' | 'status'>[]> = {
    WF_ROOT: [child('CHILD', 'complete')],
  };

  const result = planRollUp({
    completedWorkItemId: 'CHILD' as import('@pc/domain').ULID,
    getParent: (id) => {
      if (id === 'CHILD') return wfRoot;
      return null;
    },
    getChildren: (id) => childMap[id] ?? [],
  });

  // Workflow root is exempt — cascade stops before completing it.
  assert.deepEqual(result, [], 'workflow root not completed by roll-up');
});

test('planRollUp: parent with zero children → no roll-up (edge case)', () => {
  const parent = snap('P', { parentId: null });
  const result = planRollUp({
    completedWorkItemId: 'CHILD' as import('@pc/domain').ULID,
    getParent: () => parent,
    getChildren: () => [], // no children (shouldn't happen, but safe)
  });
  assert.deepEqual(result, []);
});

test('planRollUp: already-complete ancestor is skipped, continues upward', () => {
  // GRAND (not complete) → PARENT (already complete) → CHILD (just completed)
  // The cascade should skip PARENT (already done) and continue to GRAND.
  // But GRAND has PARENT as its only child; PARENT is already complete → GRAND rolls up.
  const snapshots: Record<string, WorkItemSnapshot> = {
    CHILD: snap('CHILD', { parentId: 'PARENT' }),
    PARENT: snap('PARENT', { parentId: 'GRAND', status: 'complete' }),
    GRAND: snap('GRAND', { parentId: null, status: 'pending' }),
  };
  const childMap: Record<string, Pick<WorkItem, 'id' | 'status'>[]> = {
    PARENT: [child('CHILD', 'complete')],
    GRAND: [child('PARENT', 'complete')],
  };

  const result = planRollUp({
    completedWorkItemId: 'CHILD' as import('@pc/domain').ULID,
    getParent: (id) => {
      if (id === 'CHILD') return snapshots['PARENT'] ?? null;
      if (id === 'PARENT') return snapshots['GRAND'] ?? null;
      return null;
    },
    getChildren: (id) => childMap[id] ?? [],
  });

  // PARENT is already complete — skip it, but GRAND should be completed since
  // its only child (PARENT) is complete.
  assert.deepEqual(result, ['GRAND'], 'already-complete parent skipped but grandparent rolls up');
});

test('planRollUp: completes item with no parent → empty list', () => {
  const result = planRollUp({
    completedWorkItemId: 'ROOT' as import('@pc/domain').ULID,
    getParent: () => null,
    getChildren: () => [],
  });
  assert.deepEqual(result, []);
});
