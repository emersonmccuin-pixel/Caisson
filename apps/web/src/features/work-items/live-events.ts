import {
  isStageListChangedLiveEventFrame,
  isWorkItemChangedLiveEventFrame,
} from '@pc/contracts';
import type { WorkItem } from './types.ts';

// ── Legacy compatibility envelope (kept working in parallel with canonical) ──

export interface WorkItemChangedEnvelope {
  type: 'work-item-changed';
  projectId: string;
  workItem: WorkItem;
}

export function isWorkItemChangedEnvelope(value: unknown): value is WorkItemChangedEnvelope {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return rec.type === 'work-item-changed' && typeof rec.projectId === 'string';
}

// ── Canonical live-event frame acceptors (slice 003) ─────────────────────────

/** True when `value` is a canonical `{type:'live-event'}` work-item frame
 *  scoped to `projectId`. Used by the work-item live hook to filter the live
 *  client stream before applying version-aware upserts. */
export function acceptWorkItemLiveFrame(value: unknown, projectId: string): boolean {
  if (!isWorkItemChangedLiveEventFrame(value)) return false;
  return value.event.projectId === projectId;
}

/** True when `value` is a canonical `{type:'live-event'}` stage-list frame
 *  scoped to `projectId`. */
export function acceptStageListLiveFrame(value: unknown, projectId: string): boolean {
  if (!isStageListChangedLiveEventFrame(value)) return false;
  return value.event.projectId === projectId;
}
