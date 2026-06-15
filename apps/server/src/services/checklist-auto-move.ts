// Slice C — checklist-completion auto-move trigger.
//
// Called from the tick route after every successful tick. When the checklist is
// non-empty and every item.done === true, fires the EXISTING one-door path:
//   autoAdvanceToDoneStage (moves to isDone stage) → applyRollUpCascade (parents).
//
// No-isDone-stage fallback: when the project has no isDone stage,
// `autoAdvanceToDoneStage` returns null silently. The handler detects this and
// flips status → 'complete' directly (via applyRunOutcome through the gateway)
// so completion is never silently lost, and emits a one-line log.
//
// Idempotent: if the WI is already in the isDone stage, `autoAdvanceToDoneStage`
// no-ops (returns null); the gateway mutate returns null and commits nothing.
// A concurrent contract-PASS calling the same function is safe for the same
// reason — the second call sees the already-done state and exits early.

import { applyRunOutcome, getWorkItem } from '@pc/db';
import { WorkItemMutationGateway } from '@pc/app-services';
import type { Project, ULID } from '@pc/domain';

import { autoAdvanceToDoneStage } from './auto-advance-done.ts';
import { applyRollUpCascade } from './agent-verification.ts';

/** FD-12 — the one write door for auto-move + fallback status flip. */
const gateway = new WorkItemMutationGateway();

/**
 * After a checklist tick, check `allItemsDone`. When true, fire the existing
 * auto-advance path. Idempotent and safe to call multiple times.
 */
export function triggerChecklistAutoMoveIfComplete(
  workItemId: ULID,
  project: Project,
): void {
  const wi = getWorkItem(workItemId);
  if (!wi) return;

  const checklist = wi.doneChecklist;
  // Only trigger when checklist is non-empty and every item is done.
  if (!checklist || checklist.length === 0) return;
  if (!checklist.every((item) => item.done)) return;

  const doneStage = project.stages.find((s) => s.isDone);

  gateway.tryCommitWorkItemChange({
    projectId: project.id as ULID,
    mutate: () => {
      if (doneStage) {
        // Happy path: move to the isDone stage via the existing one door.
        // No-ops (returns null) if already there — idempotent by design.
        const moved = autoAdvanceToDoneStage(workItemId, project);
        return moved ? { row: moved, reason: 'auto-advanced' } : null;
      } else {
        // No isDone stage — flip status directly so completion isn't lost.
        // Gotcha #1 from the build plan: autoAdvanceToDoneStage would silently
        // return null with no completion visible. We make it explicit.
        console.log(
          `[checklist-auto-move] project ${project.id} has no isDone stage; ` +
            `flipping ${workItemId} to complete directly`,
        );
        const updated = applyRunOutcome(
          workItemId,
          'complete',
          null,
          'checklist complete — no isDone stage, status set directly',
        );
        return updated ? { row: updated, reason: 'verified' } : null;
      }
    },
  });

  // Cascade up: ancestors whose children are now all done also complete.
  // Uses the exported one-door from agent-verification.ts.
  applyRollUpCascade(workItemId, 'checklist complete', project);
}
