// Slice 005 — canonical agent-run live-event consumption for the web client.
//
// Mirrors features/workflows/live-events.ts: accept the canonical
// `{ type:'live-event', event }` frames for agent.run.changed, dedupe by
// `event.id`, track the latest cursor, and apply rev-aware run upserts (drop
// terminal). The existing legacy `agent-run-changed` `useResourceList` handling
// keeps working in parallel (this is additive).

import {
  isAgentRunChangedLiveEvent,
  isAgentRunChangedLiveEventFrame,
  type AgentRunChangedLiveEvent,
  type AgentRunDto,
} from '@pc/contracts';

import type { WsEnvelope } from '../runtime/ws-types';

const TERMINAL = new Set<AgentRunDto['status']>(['completed', 'failed', 'cancelled']);

export interface AgentRunLiveScanResult {
  /** rev-aware run snapshots from canonical run frames, keyed by run id.
   *  Terminal runs are dropped (the active-list view excludes them). */
  runs: Map<string, AgentRunDto>;
  /** highest live-event cursor observed across all agent-run frames. */
  latestCursor: string | null;
}

/** Accept a WS envelope if it is a canonical agent-run frame or a legacy
 *  project-scoped envelope for this project. */
export function shouldAcceptAgentRunWsEnvelope(
  env: unknown,
  projectId: string,
): env is WsEnvelope {
  if (!env || typeof env !== 'object') return false;
  if (isAgentRunChangedLiveEventFrame(env)) return true;
  return (env as { projectId?: unknown }).projectId === projectId;
}

export function agentRunChangedLiveEventFromUnknown(
  value: unknown,
): AgentRunChangedLiveEvent | null {
  if (isAgentRunChangedLiveEvent(value)) return value;
  if (isAgentRunChangedLiveEventFrame(value)) return value.event;
  return null;
}

/**
 * Scan WS events from `startIndex`, folding canonical agent-run frames into a
 * rev-aware run map. Dedupes canonical events by `event.id` via the
 * caller-supplied `seenLiveEventIds`. Terminal runs are dropped from the map.
 */
export function scanAgentRunLiveEvents(
  events: readonly unknown[],
  startIndex: number,
  seenLiveEventIds: Set<string> = new Set(),
  prior?: AgentRunLiveScanResult,
): AgentRunLiveScanResult {
  const runs = new Map(prior?.runs ?? []);
  let latestCursor = prior?.latestCursor ?? null;

  const start = Math.max(0, Math.min(startIndex, events.length));
  for (let i = start; i < events.length; i++) {
    const event = agentRunChangedLiveEventFromUnknown(events[i]);
    if (!event) continue;
    latestCursor = event.cursor;
    if (seenLiveEventIds.has(event.id)) continue;
    seenLiveEventIds.add(event.id);
    const run = event.payload.run;
    if (TERMINAL.has(run.status)) {
      runs.delete(run.runId);
      continue;
    }
    const existing = runs.get(run.runId);
    // rev-aware upsert: drop out-of-order frames.
    if (!existing || existing.rev <= run.rev) runs.set(run.runId, run);
  }

  return { runs, latestCursor };
}

export { isAgentRunChangedLiveEventFrame };
