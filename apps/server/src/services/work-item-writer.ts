// UI Spine step 3 / Slice 015b — announcing write-door for work_items.
//
// EVERY mutating write of a work_items row MUST be announced through
// announceWorkItem (or one of the WorkItemService methods that call it).
// The door now writes a durable `live_outbox` row (`work-item.changed`)
// inside a DB transaction; the live-relay drains the committed row and fans
// the canonical `{type:'live-event'}` frame to subscribers per scope. The old
// hand-written `work-item-changed` envelope fanout is GONE — "forgetting to
// announce" stays structurally impossible (callers only call the announcing
// functions), and "announcement without durability" is now impossible too.
//
// Work items already carry a monotonic `version` counter; it doubles as the
// per-entity rev stamped on the live event so the client discards stale /
// out-of-order deliveries.
//
// NEVER call the relay/broadcast inside the txn — just `insertLiveEvent`; the
// relay drains the committed row post-commit.

import type { ULID, WorkItem } from '@pc/domain';
import type { WorkItemChangedLivePayload, WorkItemMutationReason } from '@pc/contracts';
import { getDb, getWorkItem, insertLiveEvent } from '@pc/db';

/** Build the canonical `work-item.changed` outbox draft from a row. */
function workItemChangedDraft(
  workItem: WorkItem,
  projectId: ULID,
  reason: WorkItemMutationReason,
) {
  const payload: WorkItemChangedLivePayload = {
    reason,
    // Domain WorkItem is a superset of the contract WorkItemDto (carries
    // `history`); the consumer reads the snapshot fields only.
    workItem: workItem as unknown as WorkItemChangedLivePayload['workItem'],
  };
  return {
    scope: 'project' as const,
    projectId,
    type: 'work-item.changed',
    entity: 'work-item' as const,
    entityId: workItem.id,
    version: workItem.version,
    payload,
  };
}

/** Read the current row and write a durable `work-item.changed` outbox row.
 *  No-ops if the row is gone (caller's write was a no-op too). */
export function announceWorkItem(
  id: ULID,
  projectId: ULID,
  reason: WorkItemMutationReason,
): void {
  const wi = getWorkItem(id);
  if (!wi) return;
  announceWorkItemRow(wi, projectId, reason);
}

/** Write a durable `work-item.changed` outbox row for an already-fetched row
 *  (e.g. right after create). The relay delivers it post-commit. */
export function announceWorkItemRow(
  workItem: WorkItem,
  projectId: ULID,
  reason: WorkItemMutationReason,
): void {
  getDb().transaction((tx) => {
    insertLiveEvent(tx, workItemChangedDraft(workItem, projectId, reason));
  });
}
