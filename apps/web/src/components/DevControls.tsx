// DEV-RUN only — rendered in Shell.tsx under `import.meta.env.DEV` so Vite
// tree-shakes this component out of production bundles entirely.
//
// Provides:
//   • "restart" button — POSTs /api/dev/restart; supervisor respawns tsx on
//     exit 75. Shows active-agent count; arms a "force?" confirmation when
//     agents are live before proceeding.
//   • "reload" button — window.location.reload() to pick up rebuilt UI.
//   • Reconnecting state — fast-polls /api/dev/status until the server is
//     back up, then resumes normal 3-second polling.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { DevStatus } from '@/features/dev-controls/client';
import { devControlsApi } from '@/features/dev-controls/client';
import {
  isRevealHiddenChatRows,
  setRevealHiddenChatRows,
} from '@/features/chat/chatRendererFlag';

type Phase = 'idle' | 'restarting' | 'reconnecting';

export function DevControls() {
  const [status, setStatus] = useState<DevStatus | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [forceArmed, setForceArmed] = useState(false);

  // phaseRef lets the async tick function read the current phase without
  // stale closure capture.
  const phaseRef = useRef<Phase>('idle');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      timer = null;
      try {
        const s = await devControlsApi.getDevStatus();
        if (!mountedRef.current) return;
        setStatus(s);
        if (phaseRef.current === 'reconnecting') {
          phaseRef.current = 'idle';
          setPhase('idle');
        }
      } catch {
        // Server down or restarting — keep polling.
      }
      if (!mountedRef.current) return;
      const ms = phaseRef.current === 'reconnecting' ? 800 : 3_000;
      timer = setTimeout(() => { void tick(); }, ms);
    };

    void tick();

    return () => {
      mountedRef.current = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  const handleRestart = useCallback(async () => {
    if (phaseRef.current !== 'idle') return;
    const active = status?.activeAgents ?? 0;
    if (active > 0 && !forceArmed) {
      setForceArmed(true);
      return;
    }
    phaseRef.current = 'restarting';
    setPhase('restarting');
    setForceArmed(false);
    try {
      await devControlsApi.restartBackend(forceArmed ? true : undefined);
    } catch {
      // Expected — server is going down.
    }
    phaseRef.current = 'reconnecting';
    setPhase('reconnecting');
    setStatus(null);
  }, [status, forceArmed]);

  if (phase === 'restarting' || phase === 'reconnecting') {
    return (
      <div className="pointer-events-none fixed bottom-2 right-2 z-50">
        <div className="pointer-events-auto flex items-center gap-2 rounded border border-border bg-card/90 px-2 py-1 text-xs text-warning shadow-sm">
          {phase === 'restarting' ? 'restarting…' : 'reconnecting…'}
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-none fixed bottom-2 right-2 z-50">
      <div className="pointer-events-auto flex items-center gap-1.5 rounded border border-border bg-card/90 px-2 py-1 text-xs text-muted-foreground shadow-sm">
        {status !== null && status.activeAgents > 0 && (
          <>
            <span className="text-warning">
              {status.activeAgents}&nbsp;{status.activeAgents === 1 ? 'agent' : 'agents'}
            </span>
            <span className="select-none text-border">·</span>
          </>
        )}
        <button
          type="button"
          disabled={phase !== 'idle'}
          onClick={() => { void handleRestart(); }}
          className="hover:text-foreground disabled:opacity-50"
          title={forceArmed ? 'Agents active — click to force restart' : 'Restart backend'}
        >
          {forceArmed ? '⚠ force?' : 'restart'}
        </button>
        <span className="select-none text-border">·</span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="hover:text-foreground"
          title="Reload frontend"
        >
          reload
        </button>
        {/* ☠ S8c: the `canon` A/B toggle died with the legacy render path. */}
        <span className="select-none text-border">·</span>
        <button
          type="button"
          onClick={() => {
            setRevealHiddenChatRows(!isRevealHiddenChatRows());
            window.location.reload();
          }}
          className={isRevealHiddenChatRows() ? 'text-success hover:text-foreground' : 'hover:text-foreground'}
          title="Reveal policy-hidden rows in canonical chat (reloads)"
        >
          reveal{isRevealHiddenChatRows() ? ' ✓' : ' ✗'}
        </button>
      </div>
    </div>
  );
}
