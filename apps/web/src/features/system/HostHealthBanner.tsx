// T2.3-A — app-level agent-host banner. Reads the SAME global `host-health`
// live-event the pill reads (one store slot, constant entityId) and shows ONE
// loud strip when the host is degraded — instead of a pile of identical failed
// agent cards. `connected` (or no frame yet) renders nothing; the pill stays the
// always-on chip. The frame rides `broadcastAll`, so every tab flips together.
// The pure render decision lives in `host-health-banner-view.ts` (unit-tested).

import { useMemo } from 'react';

import { useLiveGlobalEvents, useLiveGlobalSignature } from '@/store/live-store';
import { latestHostHealthError, pickHostHealthBanner } from './host-health-banner-view';

export function HostHealthBanner() {
  // Re-render only when a host-health frame lands; read the latest via selector.
  useLiveGlobalSignature('host-health');
  const events = useLiveGlobalEvents('host-health');
  const view = useMemo(() => pickHostHealthBanner(events), [events]);
  const lastError = useMemo(() => latestHostHealthError(events), [events]);

  if (!view) return null;
  return (
    <div
      data-testid="host-health-banner"
      data-tone={view.tone}
      title={lastError}
      className="flex items-center gap-2 border-b border-warning/60 bg-warning/10 px-3 py-1.5 text-xs text-warning"
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          view.tone === 'down' ? 'bg-red-500' : 'bg-amber-500'
        }`}
      />
      <span>{view.message}</span>
    </div>
  );
}
