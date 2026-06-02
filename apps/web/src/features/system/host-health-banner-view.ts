// T2.3-A — pure render decision for the app-level host-health banner. Kept in
// its own (React/store-free) module so the render matrix is unit-testable
// without a DOM and without resolving the `@/` store alias at test time.

import { isHostHealthChangedLivePayload, type HostHealthSnapshot, type LiveEvent } from '@pc/contracts';

export interface HostHealthBannerView {
  message: string;
  /** down = host can't be reached at all; reconnecting = degraded-but-recovering. */
  tone: 'down' | 'reconnecting';
}

/** Latest host-health frame → a banner view, or null when connected / no frame
 *  yet (the banner is the loud degraded-state strip; the pill is always-on). */
export function pickHostHealthBanner(events: readonly LiveEvent[]): HostHealthBannerView | null {
  const ev = events[events.length - 1];
  if (!ev || !isHostHealthChangedLivePayload(ev.payload)) return null;
  const health: HostHealthSnapshot = ev.payload.health;
  if (health.state === 'connected') return null;
  if (health.state === 'down') {
    return { message: "Agent host unreachable — agents can't be dispatched", tone: 'down' };
  }
  return { message: 'Reconnecting to agent host…', tone: 'reconnecting' };
}

/** The `lastError` of the latest frame, when degraded (for the banner tooltip). */
export function latestHostHealthError(events: readonly LiveEvent[]): string | undefined {
  const ev = events[events.length - 1];
  if (ev && isHostHealthChangedLivePayload(ev.payload)) {
    const h = ev.payload.health;
    return h.state !== 'connected' ? h.lastError : undefined;
  }
  return undefined;
}
