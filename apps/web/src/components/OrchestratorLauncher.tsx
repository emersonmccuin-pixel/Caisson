// Start-Chat launcher. Shown when a project has no chat open in this view
// (every boot/refresh + after Close Chat). Nothing spawns until the user picks
// "Start Chat" (fresh) or resumes a past session from the scrollable history
// cutout — that's what stops the orchestrator-per-project boot spawn storm.

import { useEffect, useState } from 'react';

import type { ULID } from '@/features/projects/types';
import { runtimeApi, type OrchestratorSession } from '@/features/runtime/client';

interface OrchestratorLauncherProps {
  projectId: ULID;
  projectName: string;
  starting: boolean;
  resumingId: string | null;
  onStartChat: () => void;
  onResumeSession: (sessionId: ULID) => void;
}

function whenLabel(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function OrchestratorLauncher({
  projectId,
  projectName,
  starting,
  resumingId,
  onStartChat,
  onResumeSession,
}: OrchestratorLauncherProps) {
  const [sessions, setSessions] = useState<OrchestratorSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSessions(null);
    setError(null);
    runtimeApi
      .listSessions(projectId)
      .then((rows) => {
        if (!cancelled) setSessions(rows);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const busy = starting || resumingId !== null;

  return (
    <div className="flex h-full min-h-0 items-stretch gap-6 overflow-hidden p-6">
      {/* Start panel — fills the left, CTA centered */}
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{projectName}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            No chat is running. Start a new one, or resume a past session.
          </p>
        </div>
        <button
          onClick={onStartChat}
          disabled={busy}
          className="rounded-lg border-2 border-primary bg-primary px-8 py-3 text-base font-semibold text-primary-foreground shadow-lg shadow-primary/30 ring-2 ring-primary/20 ring-offset-2 ring-offset-background transition-all hover:bg-primary/90 hover:shadow-primary/40 disabled:opacity-50"
        >
          {starting ? 'Starting…' : 'Start Chat'}
        </button>
      </div>

      {/* History cutout — wide, hugging the right edge */}
      <div className="flex w-[34rem] max-w-[60%] flex-col rounded-lg border border-border bg-card/40">
        <div className="border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Previous sessions
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <div className="p-3 text-xs text-red-400">Couldn't load history: {error}</div>
          ) : sessions === null ? (
            <div className="p-3 text-xs text-muted-foreground">Loading…</div>
          ) : sessions.length === 0 ? (
            <div className="p-3 text-xs text-muted-foreground">No past sessions yet.</div>
          ) : (
            <ul className="divide-y divide-border">
              {sessions.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => onResumeSession(s.id)}
                    disabled={busy}
                    title="Resume this conversation as the live chat"
                    className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                  >
                    <span className="line-clamp-1 text-sm text-foreground">
                      {s.title?.trim() || 'Untitled session'}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {resumingId === s.id ? 'Resuming…' : whenLabel(s.startedAt)}
                      {s.status === 'active' ? ' · active' : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
