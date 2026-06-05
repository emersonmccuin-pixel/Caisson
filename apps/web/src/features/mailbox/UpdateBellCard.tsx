// Compact "update available" card pinned to the top of the Inbox bell panel
// when the desktop auto-updater has a pending update. It mirrors the staged
// flow in Settings → Updates (download → progress → restart & install) against
// the SAME useDesktopUpdates verbs — one update path, two views. Desktop-only;
// the bell renders this only while an update is actually pending, so the
// browser / dev-run cases never reach here.

import { useState } from 'react';
import { Download } from 'lucide-react';

import type { DesktopUpdates } from '@/hooks/use-desktop-updates';

/** True while the updater has something the user can act on. */
export function isUpdatePending(updates: DesktopUpdates): boolean {
  const s = updates.state?.status;
  return s === 'available' || s === 'downloading' || s === 'downloaded';
}

export function UpdateBellCard({ updates }: { updates: DesktopUpdates }) {
  const { state, download, install } = updates;
  const [busy, setBusy] = useState(false);
  if (!state) return null;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-3 flex flex-col gap-2 border border-primary/40 bg-primary/10 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
        <Download className="h-3 w-3" />
        Caisson update
      </div>

      {state.status === 'available' && (
        <>
          <div className="text-xs text-foreground">
            Version <span className="font-medium">{state.availableVersion}</span> is available.
          </div>
          <button
            type="button"
            onClick={() => void run(download)}
            disabled={busy}
            className="self-start bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Download update
          </button>
        </>
      )}

      {state.status === 'downloading' && (
        <>
          <div className="text-xs text-foreground">
            Downloading {state.availableVersion}… {state.percent ?? 0}%
          </div>
          <div className="relative h-1.5 w-full overflow-hidden bg-muted">
            <div
              className="absolute inset-y-0 left-0 bg-primary transition-[width]"
              style={{ width: `${state.percent ?? 0}%` }}
            />
          </div>
        </>
      )}

      {state.status === 'downloaded' && (
        <>
          <div className="text-xs text-foreground">
            Version <span className="font-medium">{state.availableVersion}</span> is ready. Caisson
            will restart to finish installing.
          </div>
          <button
            type="button"
            onClick={() => void install()}
            className="self-start bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            Restart &amp; install
          </button>
        </>
      )}
    </div>
  );
}
