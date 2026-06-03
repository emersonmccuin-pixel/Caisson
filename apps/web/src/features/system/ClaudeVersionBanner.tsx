// FD-22 — Claude Code version-pin warning strip. PC is tested against ONE
// exact CC version (preflight's `pinnedVersion`); a different installed
// version gets a loud warning + one-click "install the tested version" — never
// a hard wall (a dev machine may run ahead deliberately). Checks once per app
// load; spawned sessions can't drift mid-run (DISABLE_AUTOUPDATER).

import { useEffect, useState } from 'react';

import { settingsApi, type ClaudePreflight } from '@/features/settings/client';

export function ClaudeVersionBanner() {
  const [claude, setClaude] = useState<ClaudePreflight | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    settingsApi
      .getPreflight()
      .then((p) => {
        if (!cancelled) setClaude(p.claude);
      })
      .catch(() => {
        /* preflight unreachable — the host-health banner owns that story */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Only warn on a confirmed mismatch. not-found / too-old / unreadable are
  // onboarding's problem, not this strip's.
  if (dismissed || !claude || claude.pinnedMatch !== false || !claude.version) return null;

  async function installPinned() {
    setInstalling(true);
    setError(null);
    try {
      const r = await settingsApi.installClaude();
      setClaude(r.preflight.claude); // match → banner disappears
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div
      data-testid="claude-version-banner"
      className="flex items-center justify-between gap-3 border-b border-warning/60 bg-warning/10 px-3 py-1.5 text-xs text-warning"
    >
      <span className="flex items-center gap-2">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
        <span>
          Claude Code {claude.version} is installed, but Caisson is tested with{' '}
          {claude.pinnedVersion} — agents and chats may misbehave on an untested version.
          {error ? ` Install failed: ${error}` : ''}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <button
          onClick={installPinned}
          disabled={installing}
          className="border border-warning/60 px-2 py-0.5 text-warning hover:bg-warning/20 disabled:opacity-50"
        >
          {installing ? 'Installing…' : `Install ${claude.pinnedVersion}`}
        </button>
        <button onClick={() => setDismissed(true)} className="text-warning hover:text-foreground">
          dismiss
        </button>
      </span>
    </div>
  );
}
