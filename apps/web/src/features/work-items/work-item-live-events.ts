// T3.2b — pure decision helpers for the work-item live-store consumers
// (WorkItemDetailModal field-schema + history fold, InitiativeInspector history).
// Extracted so the branch logic can be pinned under tsx --test without jsdom.

import {
  isFieldSchemaListChangedLivePayload,
  isWorkItemChangedLivePayload,
  type LiveEvent,
} from '@pc/contracts';
import type { FieldSchema } from './client';

/** Latest field-schema list across the store's `field-schema` frames, chosen by
 *  highest cursor (cursor is the monotonic global outbox seq; field-schema frames
 *  carry version null so cursor is the only ordering key). null when none. */
export function latestFieldSchemas(events: LiveEvent[]): FieldSchema[] | null {
  let best: LiveEvent | null = null;
  for (const ev of events) {
    if (!isFieldSchemaListChangedLivePayload(ev.payload)) continue;
    if (!best || ev.cursor > best.cursor) best = ev;
  }
  if (!best || !isFieldSchemaListChangedLivePayload(best.payload)) return null;
  return best.payload.schemas as unknown as FieldSchema[];
}

export interface WorkItemHistoryRow {
  ts: number;
  actor: string;
  text: string;
}

/** Fold the store's `work-item` frames into history rows for ONE work item id.
 *  Mirrors the legacy timeline scan: one "updated · vN" row per frame whose
 *  payload work item matches `workItemId`. */
export function workItemHistoryRows(
  events: LiveEvent[],
  workItemId: string,
): WorkItemHistoryRow[] {
  const out: WorkItemHistoryRow[] = [];
  for (const ev of events) {
    if (!isWorkItemChangedLivePayload(ev.payload)) continue;
    const wi = ev.payload.workItem as { id?: string; updatedAt?: number; version?: number } | undefined;
    if (!wi || wi.id !== workItemId) continue;
    out.push({
      ts: wi.updatedAt ?? 0,
      actor: 'edit',
      text: `updated · v${wi.version}`,
    });
  }
  return out;
}
