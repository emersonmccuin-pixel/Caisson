import { useEffect, useRef, useState } from 'react';

import type { WsStatus } from '@/features/runtime/ws-types';
import { STALL_WARN_MS } from '@/features/chat/runtimeState';

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem.toString().padStart(2, '0')}s`;
}

export function ThinkingIndicator({
  elapsedMs,
  interruptedAt,
  activity,
  lastEnvelopeAt,
  wsStatus,
}: {
  elapsedMs: number;
  interruptedAt: number | null;
  activity: string | null;
  lastEnvelopeAt: number;
  wsStatus?: WsStatus;
}) {
  const [sinceInterrupt, setSinceInterrupt] = useState(0);
  useEffect(() => {
    if (interruptedAt === null) {
      setSinceInterrupt(0);
      return;
    }
    const tick = () => setSinceInterrupt(Date.now() - interruptedAt);
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [interruptedAt]);

  // Live "ms since last envelope" so the activity readout reflects real
  // movement and a stall becomes visible (the counter keeps climbing).
  // Read lastEnvelopeAt through a ref + run this interval ONCE. While the agent
  // is thinking it streams a burst of envelopes, each bumping lastEnvelopeAt; a
  // [lastEnvelopeAt] dep tore down + recreated this interval (and fired an
  // immediate setState) per frame, and that re-subscribe storm tripped React's
  // "Maximum update depth" and froze the UI. The ref keeps the readout current
  // without re-subscribing.
  const lastEnvelopeAtRef = useRef(lastEnvelopeAt);
  lastEnvelopeAtRef.current = lastEnvelopeAt;
  const [sinceEnvelope, setSinceEnvelope] = useState(0);
  useEffect(() => {
    const tick = () => setSinceEnvelope(Date.now() - lastEnvelopeAtRef.current);
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, []);

  // Connection lost mid-turn: don't pretend the agent is working. The socket
  // dropped (server restart / network blip) and reconnects on a backoff.
  const disconnected = wsStatus === 'closed' || wsStatus === 'connecting';
  if (disconnected) {
    return (
      <div className="self-start flex flex-col gap-1 border border-warning/60 bg-warning/10 px-3 py-1.5 text-xs text-warning">
        <div className="flex items-center gap-2">
          <span className="thinking-dots inline-flex items-center gap-0.5">
            <span className="thinking-dot" />
            <span className="thinking-dot" />
            <span className="thinking-dot" />
          </span>
          <span>Reconnecting to the app…</span>
        </div>
        <div className="text-[10px] uppercase tracking-wider opacity-90">
          Lost the connection to the local server — retrying. Your chat resumes once it's back.
        </div>
      </div>
    );
  }

  const interrupting = interruptedAt !== null;
  const stuck = interrupting && sinceInterrupt > 5_000;
  const stalled = !interrupting && sinceEnvelope > STALL_WARN_MS;
  const showAgo = !interrupting && sinceEnvelope > 4_000;
  return (
    <div
      className={
        'self-start flex flex-col gap-1 border px-3 py-1.5 text-xs ' +
        (interrupting || stalled
          ? 'border-warning/60 bg-warning/10 text-warning'
          : 'border-border bg-card text-muted-foreground')
      }
    >
      <div className="flex items-center gap-2">
        <span className="thinking-dots inline-flex items-center gap-0.5">
          <span className="thinking-dot" />
          <span className="thinking-dot" />
          <span className="thinking-dot" />
        </span>
        <span>{interrupting ? 'Interrupting' : 'Thinking'}</span>
        <span className="font-mono tabular-nums opacity-80">
          {interrupting ? formatElapsed(sinceInterrupt) : formatElapsed(elapsedMs)}
        </span>
      </div>
      {!interrupting && activity && (
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="min-w-0 truncate font-mono opacity-90" title={activity}>
            {activity}
          </span>
          {showAgo && (
            <span className="shrink-0 tabular-nums opacity-70">
              · updated {formatElapsed(sinceEnvelope)} ago
            </span>
          )}
        </div>
      )}
      {stalled && (
        <div className="text-[10px] uppercase tracking-wider opacity-90">
          No updates for {formatElapsed(sinceEnvelope)} — Claude may have stopped. Use "+ New session" to reset if it doesn't recover.
        </div>
      )}
      {stuck && (
        <div className="text-[10px] uppercase tracking-wider opacity-90">
          Claude isn't responding to the interrupt — click it again, or use "+ New session" if stuck.
        </div>
      )}
    </div>
  );
}
