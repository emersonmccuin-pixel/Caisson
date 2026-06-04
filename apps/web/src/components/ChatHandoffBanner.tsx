// S2 / FD-21 — authoring-handoff banner. Replaces the transient modal Claude
// sessions: create surfaces show this strip pointing at the one orchestrator
// chat instead of spawning their own popup session. No prefill, no auto-send —
// just navigation (Emerson 2026-06-04: "a banner ... and a link to open chat,
// nothing more").

import { useActiveCenterTab } from '@/store/active-center-tab';

export function ChatHandoffBanner({
  children,
  onNavigate,
}: {
  /** Plain-English pitch, e.g. "You can create a workflow through conversation in chat." */
  children: React.ReactNode;
  /** Called after navigating (close the hosting modal). */
  onNavigate?: () => void;
}) {
  const setCenterTab = useActiveCenterTab((s) => s.setTab);
  return (
    <div className="flex items-center justify-between gap-3 border border-primary/40 bg-primary/10 px-3 py-2 text-xs">
      <div className="flex items-center gap-2 text-foreground">
        <span aria-hidden>💬</span>
        <span>{children}</span>
      </div>
      <button
        type="button"
        onClick={() => {
          setCenterTab('orchestrator');
          onNavigate?.();
        }}
        className="shrink-0 border border-primary bg-primary/30 px-3 py-1 font-medium text-foreground hover:bg-primary/50"
      >
        Open chat →
      </button>
    </div>
  );
}
