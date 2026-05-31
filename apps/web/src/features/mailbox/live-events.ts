// Slice 007 — canonical mailbox / pending-interaction live-event consumption.
//
// Mirrors features/agent-runs/live-events.ts: accept the canonical
// `{ type:'live-event', event }` frames for mailbox.message.changed /
// mailbox.delivery.changed / pending-interaction.changed, dedupe by `event.id`,
// track the latest cursor, and signal a refetch (the inbox refetches on event;
// patching can come later per spec §9). The global single-user inbox replays
// with includeGlobal=1 (so scope:'global' user-inbox events arrive without a
// projectId); the project inbox replays with a projectId.

import {
  isMailboxDeliveryChangedLiveEventFrame,
  isMailboxMessageChangedLiveEventFrame,
  isPendingInteractionChangedLiveEventFrame,
} from '@pc/contracts';

import type { WsEnvelope } from '../runtime/ws-types';

export interface MailboxLiveScanResult {
  /** true when any accepted mailbox/interaction frame implies a refetch. */
  changed: boolean;
  /** highest live-event cursor observed across mailbox/interaction frames. */
  latestCursor: string | null;
}

export function isMailboxLiveFrame(value: unknown): boolean {
  return (
    isMailboxMessageChangedLiveEventFrame(value) ||
    isMailboxDeliveryChangedLiveEventFrame(value) ||
    isPendingInteractionChangedLiveEventFrame(value)
  );
}

/** Accept a WS envelope if it is a canonical mailbox/interaction frame, or a
 *  legacy project-scoped envelope for this project. */
export function shouldAcceptMailboxWsEnvelope(env: unknown, projectId: string): env is WsEnvelope {
  if (!env || typeof env !== 'object') return false;
  if (isMailboxLiveFrame(env)) return true;
  return (env as { projectId?: unknown }).projectId === projectId;
}

function frameEvent(value: unknown): { id: string; cursor: string } | null {
  if (
    isMailboxMessageChangedLiveEventFrame(value) ||
    isMailboxDeliveryChangedLiveEventFrame(value) ||
    isPendingInteractionChangedLiveEventFrame(value)
  ) {
    return (value as { event: { id: string; cursor: string } }).event;
  }
  return null;
}

/** Scan WS events from `startIndex`, folding mailbox/interaction frames into a
 *  "should refetch" + latest-cursor result. Dedupes by `event.id`. */
export function scanMailboxLiveEvents(
  events: readonly unknown[],
  startIndex: number,
  seenLiveEventIds: Set<string> = new Set(),
  prior?: MailboxLiveScanResult,
): MailboxLiveScanResult {
  let changed = prior?.changed ?? false;
  let latestCursor = prior?.latestCursor ?? null;

  const start = Math.max(0, Math.min(startIndex, events.length));
  for (let i = start; i < events.length; i++) {
    const event = frameEvent(events[i]);
    if (!event) continue;
    latestCursor = event.cursor;
    if (seenLiveEventIds.has(event.id)) continue;
    seenLiveEventIds.add(event.id);
    changed = true;
  }

  return { changed, latestCursor };
}
