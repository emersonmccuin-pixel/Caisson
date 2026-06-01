// T1.1 — tiny agent-host liveness pill. Reads the durable global `host-health`
// live-event (one store slot, constant entityId) and renders connected/
// reconnecting/down. The frame rides `broadcastAll` to every socket, so it
// updates in every tab without a refetch.

import { useMemo } from 'react';

import { isHostHealthChangedLivePayload, type HostHealthSnapshot } from '@pc/contracts';
import { useLiveGlobalEvents, useLiveGlobalSignature } from '@/store/live-store';

const STYLES: Record<HostHealthSnapshot['state'], { dot: string; label: string }> = {
  connected: { dot: 'bg-green-500', label: 'host' },
  reconnecting: { dot: 'bg-amber-500', label: 'host reconnecting' },
  down: { dot: 'bg-red-500', label: 'host down' },
};

export function HostHealthPill() {
  // Subscribe to the signature so the component re-renders only when a
  // host-health frame actually lands; read the latest frame via the selector.
  useLiveGlobalSignature('host-health');
  const events = useLiveGlobalEvents('host-health');
  const health = useMemo<HostHealthSnapshot | null>(() => {
    const ev = events[events.length - 1];
    if (ev && isHostHealthChangedLivePayload(ev.payload)) return ev.payload.health;
    return null;
  }, [events]);

  if (!health) return null;
  const style = STYLES[health.state];
  const title =
    health.state === 'connected'
      ? `agent host connected (host ${health.hostId ?? '?'}, pid ${health.pid ?? '?'})`
      : `agent host ${health.state}${health.lastError ? `: ${health.lastError}` : ''}`;

  return (
    <span className="flex items-center gap-1.5" title={title} data-testid="host-health-pill">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${style.dot}`} />
      <span className="text-[var(--fg-dim)]">{style.label}</span>
    </span>
  );
}
