// Slice 004 — canonical workflow live-event consumption for the web client.
//
// Mirrors features/projects/live-events.ts: accept the canonical
// `{ type:'live-event', event }` frames for workflow.run.changed /
// workflow.review.changed / workflow.definition.changed, dedupe by `event.id`,
// track the latest cursor, and apply rev-aware run upserts. The existing
// `workflow-v2-run-changed` / `workflow-v2-review-pending` / `workflow-changed`
// legacy handling keeps working in parallel (this is additive).

import {
  isWorkflowDefinitionChangedLiveEvent,
  isWorkflowDefinitionChangedLiveEventFrame,
  isWorkflowReviewChangedLiveEvent,
  isWorkflowReviewChangedLiveEventFrame,
  isWorkflowRunChangedLiveEvent,
  isWorkflowRunChangedLiveEventFrame,
  type WorkflowRunChangedLiveEvent,
  type WorkflowRunDto,
} from '@pc/contracts';

import type { WsEnvelope } from '../runtime/ws-types';

export interface WorkflowLiveScanResult {
  /** rev-aware run snapshots from canonical run frames, keyed by run id. */
  runs: Map<string, WorkflowRunDto>;
  /** run ids whose latest review fact is `pending`. */
  reviewPending: Set<string>;
  /** true if any workflow.definition.changed frame was seen (refetch defs). */
  definitionChanged: boolean;
  /** highest live-event cursor observed across all workflow frames. */
  latestCursor: string | null;
}

/** Accept a WS envelope if it is a canonical workflow frame or a legacy
 *  project-scoped workflow envelope for this project. */
export function shouldAcceptWorkflowWsEnvelope(
  env: unknown,
  projectId: string,
): env is WsEnvelope {
  if (!env || typeof env !== 'object') return false;
  if (
    isWorkflowRunChangedLiveEventFrame(env) ||
    isWorkflowReviewChangedLiveEventFrame(env) ||
    isWorkflowDefinitionChangedLiveEventFrame(env)
  ) {
    return true;
  }
  return (env as { projectId?: unknown }).projectId === projectId;
}

export function workflowRunChangedLiveEventFromUnknown(
  value: unknown,
): WorkflowRunChangedLiveEvent | null {
  if (isWorkflowRunChangedLiveEvent(value)) return value;
  if (isWorkflowRunChangedLiveEventFrame(value)) return value.event;
  return null;
}

/**
 * Scan WS events from `startIndex`, folding canonical workflow frames into a
 * rev-aware run map + review-pending set + a definition-changed flag. Dedupes
 * canonical events by `event.id` via the caller-supplied `seenLiveEventIds`.
 */
export function scanWorkflowLiveEvents(
  events: readonly unknown[],
  startIndex: number,
  seenLiveEventIds: Set<string> = new Set(),
  prior?: WorkflowLiveScanResult,
): WorkflowLiveScanResult {
  const runs = new Map(prior?.runs ?? []);
  const reviewPending = new Set(prior?.reviewPending ?? []);
  let definitionChanged = false;
  let latestCursor = prior?.latestCursor ?? null;

  const start = Math.max(0, Math.min(startIndex, events.length));
  for (let i = start; i < events.length; i++) {
    const value = events[i];

    const runEvent = workflowRunChangedLiveEventFromUnknown(value);
    if (runEvent) {
      latestCursor = runEvent.cursor;
      if (seenLiveEventIds.has(runEvent.id)) continue;
      seenLiveEventIds.add(runEvent.id);
      const run = runEvent.payload.run;
      if (run) {
        const existing = runs.get(run.id);
        // rev-aware upsert: drop out-of-order frames.
        if (!existing || existing.rev <= run.rev) runs.set(run.id, run);
        if (run.status !== 'paused') reviewPending.delete(run.id);
      }
      continue;
    }

    const reviewEvent = reviewChangedFromUnknown(value);
    if (reviewEvent) {
      latestCursor = reviewEvent.cursor;
      if (seenLiveEventIds.has(reviewEvent.id)) continue;
      seenLiveEventIds.add(reviewEvent.id);
      if (reviewEvent.payload.state === 'pending') {
        reviewPending.add(reviewEvent.payload.runId);
      } else {
        reviewPending.delete(reviewEvent.payload.runId);
      }
      continue;
    }

    const defEvent = definitionChangedFromUnknown(value);
    if (defEvent) {
      latestCursor = defEvent.cursor;
      if (seenLiveEventIds.has(defEvent.id)) continue;
      seenLiveEventIds.add(defEvent.id);
      definitionChanged = true;
    }
  }

  return { runs, reviewPending, definitionChanged, latestCursor };
}

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

function reviewChangedFromUnknown(value: unknown) {
  if (isWorkflowReviewChangedLiveEvent(value)) return value;
  if (isWorkflowReviewChangedLiveEventFrame(value)) return value.event;
  return null;
}

function definitionChangedFromUnknown(value: unknown) {
  if (isWorkflowDefinitionChangedLiveEvent(value)) return value;
  if (isWorkflowDefinitionChangedLiveEventFrame(value)) return value.event;
  return null;
}
