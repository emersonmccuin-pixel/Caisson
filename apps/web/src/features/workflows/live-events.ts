// Workflow live-event helpers for the web client.
//
// The canonical workflow run/review consumption now flows through the
// identity-keyed live store (see use-project-workflow-v2-runs + use-resource-list
// + WorkflowsList's RunInlineDetail). The old positional `events[]` scanners
// (`scanWorkflowLiveEvents` et al.) were removed — they read live frames off the
// chat timeline, which is exactly the staleness anti-pattern slice 018 replaced.
//
// Only the WorkflowBuilderModal close-decision helper remains: it is pure UI
// logic over a single workflow-definition payload, not a live-event scan.

/** T3.2b — WorkflowBuilderModal close decision for one workflow-definition
 *  payload. Skip `deleted`. Edit mode: close only when the slug matches the row
 *  being edited AND the change is created/updated. New mode: close on `created`. */
export function shouldCloseWorkflowBuilder(
  payload: { change: 'created' | 'updated' | 'deleted'; definition?: { slug?: string } },
  editingId: string | null,
): boolean {
  const { change } = payload;
  if (change === 'deleted') return false;
  const changedSlug = payload.definition?.slug;
  if (editingId !== null) {
    if (changedSlug && changedSlug !== editingId) return false;
    return change === 'updated' || change === 'created';
  }
  return change === 'created';
}
