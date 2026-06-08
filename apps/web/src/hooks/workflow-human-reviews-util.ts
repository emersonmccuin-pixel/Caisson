// T5 — pure derivation utilities for the "Waiting on you" human-review signal.
//
// Extracted from use-project-workflow-human-reviews.ts so node:test (tsx --test)
// can import and exercise them without loading React or zustand.
//
// NO React imports here — this file is intentionally side-effect-free.

/** Apply one `workflow.review.changed` payload to the current pending set.
 *  Pure / side-effect-free — safe to call in tests without React. */
export function applyReviewChange(
  pending: ReadonlySet<string>,
  payload: { runId: string; flavor: string; state: string },
): Set<string> {
  if (payload.flavor !== 'human') return new Set(pending);
  if (payload.state === 'pending') {
    if (pending.has(payload.runId)) return new Set(pending);
    const next = new Set(pending);
    next.add(payload.runId);
    return next;
  }
  if (payload.state === 'approved' || payload.state === 'rejected') {
    if (!pending.has(payload.runId)) return new Set(pending);
    const next = new Set(pending);
    next.delete(payload.runId);
    return next;
  }
  return new Set(pending);
}
