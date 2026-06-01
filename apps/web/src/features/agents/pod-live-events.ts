// T3.2b — pure decision helper for the AgentsList DetailPane pod-bundle reload.
// Returns true iff the store holds a NEW `pod` frame (newer version/cursor than
// `seen` records) whose payload podId matches the open pod. Mutates `seen` so a
// later unrelated re-render can't re-trigger. Extracted for tsx --test.

import { isPodChangedLivePayload, type LiveEvent } from '@pc/contracts';

function markerOf(ev: LiveEvent): number | string {
  return ev.version ?? ev.cursor;
}

export function hasNewPodFrameFor(
  events: LiveEvent[],
  podId: string,
  seen: Map<string, number | string>,
): boolean {
  let fire = false;
  for (const ev of events) {
    if (!ev.entityId) continue;
    const marker = markerOf(ev);
    if (seen.get(ev.entityId) === marker) continue;
    seen.set(ev.entityId, marker);
    if (isPodChangedLivePayload(ev.payload) && ev.payload.podId === podId) {
      fire = true;
    }
  }
  return fire;
}
