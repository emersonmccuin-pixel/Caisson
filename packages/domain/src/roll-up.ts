// Slice 1 (Areas + context model) — roll-up decision engine.
//
// TWO pure functions extracted for isolated unit-testing:
//
//  `decideContractCompletion` — Rule 1 + Rule 2 guard at acceptContract time.
//    Leaf (no children) → 'complete' (today's behavior unchanged).
//    Parent with children → 'accept-only' (the cascade, not the contract, completes it).
//    Workflow root → 'complete' (Rule 2 exemption — run completion drives it).
//
//  `planRollUp` — Roll-up cascade engine. Given the just-completed work item,
//    walks up the parent chain and collects every ancestor that should also
//    complete (because all its non-archived children are now done).
//    Returns them in bottom-up order (nearest ancestor first).
//
// These are the ONLY decision points for roll-up behavior. No DB calls here —
// callers supply pre-fetched data. This keeps the functions fast and testable.

import type { WorkItem, WorkItemStatus, ULID } from './index.ts';

/** Input snapshot for one roll-up decision step. */
export interface WorkItemSnapshot {
  id: ULID;
  parentId: ULID | null;
  isWorkflowRoot: boolean;
  status: WorkItemStatus;
}

/** Outcome of `decideContractCompletion`. */
export type ContractCompletionDecision = 'complete' | 'accept-only';

/**
 * Pure Rule 1 + Rule 2 guard for `acceptContract`.
 *
 * - `complete`: proceed with `applyRunOutcome` + `autoAdvanceToDoneStage`
 *   (current leaf behavior).
 * - `accept-only`: set contract to `passed` but skip WI completion — the
 *   cascade (planRollUp) will complete the parent when its children are all
 *   done.
 *
 * Decision table:
 *   isWorkflowRoot = true → 'complete'  (Rule 2: workflow run governs)
 *   childCount > 0       → 'accept-only' (Rule 1: roll-up governs)
 *   else (leaf)           → 'complete'  (Rule 1: contract governs)
 */
export function decideContractCompletion(input: {
  childCount: number;
  isWorkflowRoot: boolean;
}): ContractCompletionDecision {
  // Rule 2 — workflow roots complete on run completion, not child roll-up.
  if (input.isWorkflowRoot) return 'complete';
  // Rule 1 — parent with children: only roll-up may complete it.
  if (input.childCount > 0) return 'accept-only';
  // Leaf — current behavior unchanged.
  return 'complete';
}

/** Input to `planRollUp`. Callers supply the immediate parent + a function
 *  to fetch further ancestors + their children on demand. */
export interface PlanRollUpInput {
  /** The work item that just completed (the trigger). */
  completedWorkItemId: ULID;
  /**
   * Fetches the parent snapshot for a given work-item id. Returns null when
   * the item has no parent (root) or does not exist.
   */
  getParent(workItemId: ULID): WorkItemSnapshot | null;
  /**
   * Returns the non-archived children of a parent. Only `status` is needed
   * to determine roll-up eligibility. The completed item should be reflected
   * with status='complete' (callers must include it in the result).
   */
  getChildren(parentId: ULID): Pick<WorkItem, 'id' | 'status'>[];
}

/**
 * Pure roll-up cascade planner.
 *
 * Starting from the just-completed item, walks up the parent chain. At each
 * ancestor, checks:
 *   1. Not a workflow root (Rule 2 — exempt from roll-up).
 *   2. All non-archived children are `complete`.
 *   → If both hold, the ancestor rolls up too.
 *
 * Returns the ordered list of ancestor ULIDs to complete, nearest-first.
 * The caller applies them in order (each flip may unlock the next).
 *
 * Edge cases:
 *   - No parent → empty list.
 *   - Any sibling not complete → empty list (cascade stops).
 *   - Workflow root → stop (excluded from roll-up).
 *   - Zero children (shouldn't happen via this path, but handled as no-roll-up).
 */
export function planRollUp(input: PlanRollUpInput): ULID[] {
  const toComplete: ULID[] = [];
  let currentId: ULID = input.completedWorkItemId;
  const visited = new Set<ULID>();

  while (true) {
    if (visited.has(currentId)) break; // cycle guard
    visited.add(currentId);

    const parent = input.getParent(currentId);
    if (!parent) break; // root or not found

    // Rule 2: workflow roots never complete by roll-up.
    if (parent.isWorkflowRoot) break;

    // Already complete — keep walking up (parent may already be done).
    // But we shouldn't re-complete it; just skip if already complete.
    if (parent.status === 'complete') {
      currentId = parent.id;
      continue;
    }

    // Check if all non-archived children of the parent are complete.
    const children = input.getChildren(parent.id);
    if (children.length === 0) break; // no children — edge case, don't roll up

    const allDone = children.every((c) => c.status === 'complete');
    if (!allDone) break; // sibling not done — cascade stops

    // This ancestor should be completed by roll-up.
    toComplete.push(parent.id);
    currentId = parent.id;
  }

  return toComplete;
}
