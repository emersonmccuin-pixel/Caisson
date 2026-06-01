// Section 31.7 — walk the WS envelope stream and push `statusline-snapshot`
// payloads into the per-project statusline store. Mount once at Shell level
// alongside the rich-link invalidator.

import { useEffect, useRef } from 'react';

import { runtimeApi } from '@/features/runtime/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { useOrchestratorTelemetry } from '@/store/orchestrator-telemetry';
import { type StatuslineSnapshot, useStatuslineStore } from '@/store/statusline';
import { useWsEpoch } from '@/store/ws-epoch';

function publishContextPct(snapshot: StatuslineSnapshot | null): void {
  useOrchestratorTelemetry
    .getState()
    .setContextUsedPct(snapshot?.contextWindow?.usedPercentage ?? null);
}

export function useStatuslineSync(projectId: string | null, events: WsEnvelope[]): void {
  const lastIdx = useRef(0);
  // Statusline is a separate-channel snapshot (not on the durable outbox) and
  // is NOT re-pushed on the WS connect handshake — it lands only when CC's
  // statusLine hook POSTs. So on a same-project reconnect (blip), re-fetch the
  // server's cached snapshot keyed off the WS epoch, the same reconcile signal
  // resource-list hooks use. Without this an idle reconnected tab can hold a
  // stale snapshot until the next CC refresh.
  const wsEpoch = useWsEpoch((s) => (projectId ? (s.byProject[projectId] ?? 0) : 0));

  // Reset envelope-scan cursor when project changes; also prime the store
  // with the server's latest cached snapshot so the rail isn't blank on
  // first paint after the user opens PC mid-session, and re-prime on reconnect.
  useEffect(() => {
    lastIdx.current = 0;
    if (!projectId) {
      publishContextPct(null);
      return;
    }
    let cancelled = false;
    runtimeApi.getStatuslineSnapshot(projectId)
      .then((snap) => {
        if (cancelled || !snap) return;
        const typed = snap as StatuslineSnapshot;
        useStatuslineStore.getState().set(projectId, typed);
        publishContextPct(typed);
      })
      .catch(() => {
        /* best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, wsEpoch]);

  useEffect(() => {
    if (!projectId) return;
    for (let i = lastIdx.current; i < events.length; i++) {
      const env = events[i];
      if (!env || typeof env !== 'object') continue;
      if (env.type === 'statusline-snapshot') {
        const snap = (env as { snapshot?: StatuslineSnapshot }).snapshot;
        if (snap) {
          useStatuslineStore.getState().set(projectId, snap);
          publishContextPct(snap);
        }
      }
    }
    lastIdx.current = events.length;
  }, [events, projectId]);
}
