// Dev-instance build marker — shows which commit/branch the staged server is
// running so the tester always knows they're on the right code.
//
// Fetches /api/dev/status once on mount (the build info doesn't change at
// runtime). Renders nothing when:
//   • The endpoint returns 404 (packaged build — dev controls off)
//   • The response carries no buildSha (plain pnpm dev with no env set)
//   • The fetch throws (network error, API not yet up)

import { useEffect, useState } from 'react';

import { parseBuildMarker, type BuildMarkerView } from './build-marker-view';

export function BuildMarker() {
  const [view, setView] = useState<BuildMarkerView | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/dev/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) setView(parseBuildMarker(data));
      })
      .catch(() => {
        /* API unreachable — stay hidden */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!view) return null;

  const label = view.branch ? `${view.branch} @ ${view.sha}` : view.sha;

  return (
    <div
      data-testid="build-marker"
      className="flex items-center gap-2 border-b border-muted bg-muted/30 px-3 py-1 text-xs text-muted-foreground"
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-sky-500" />
      <span>dev-instance — {label}</span>
    </div>
  );
}
