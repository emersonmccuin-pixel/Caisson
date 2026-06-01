/** Backoff schedule from legacy `apps/web/legacy/app.js:545` (Session F #4). */
export const RECONNECT_SCHEDULE_MS = [2_000, 5_000, 15_000, 30_000] as const;
// Ping every 5s; declare dead after 15s without any inbound traffic. Timeout
// must be > 2× interval so a single dropped pong doesn't false-trigger a
// reconnect (15 > 2 × 5 = 10 ✓). Tightened from 15 s / 45 s — the old values
// meant a tsx-watch reload or NAT timeout could leave a half-open socket
// undetected for up to 45 s, causing the "must refresh to see updates" UX bug.
export const WS_HEARTBEAT_INTERVAL_MS = 5_000;
export const WS_HEARTBEAT_TIMEOUT_MS = 15_000;

export interface WsHeartbeatPing {
  type: 'client-ping';
  nonce: string;
  sentAt: number;
}

export function nextBackoffMs(prevDelay: number): number {
  const idx = RECONNECT_SCHEDULE_MS.indexOf(prevDelay as (typeof RECONNECT_SCHEDULE_MS)[number]);
  if (idx === -1 || idx === RECONNECT_SCHEDULE_MS.length - 1) {
    return RECONNECT_SCHEDULE_MS[RECONNECT_SCHEDULE_MS.length - 1]!;
  }
  return RECONNECT_SCHEDULE_MS[idx + 1]!;
}

export function heartbeatTimedOut(
  lastInboundAt: number,
  now = Date.now(),
  timeoutMs = WS_HEARTBEAT_TIMEOUT_MS,
): boolean {
  return now - lastInboundAt >= timeoutMs;
}

export function createHeartbeatPing(
  now = Date.now(),
  random = Math.random,
): WsHeartbeatPing {
  return {
    type: 'client-ping',
    nonce: `${now}-${random().toString(36).slice(2)}`,
    sentAt: now,
  };
}
