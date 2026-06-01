// SessionsRail — left-rail body when the rail mode is "sessions". Lists the
// active project's orchestrator sessions (most recent first); clicking one
// puts the Orchestrator into read-only view of that session's events.
// "Live" is just the active session — click it to return to the WS stream.

import { useEffect, useState } from 'react';

import { isLiveEventFrame } from '@pc/contracts';

import type { Project } from '@/features/projects/client';
import { runtimeApi, type OrchestratorSession, type SessionTransitionResponse } from '@/features/runtime/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { useViewingSession } from '@/store/viewing-session';

interface SessionsRailProps {
  project: Project | null;
  /** WS event stream for the active project. We watch for session-changed
   *  envelopes so a fresh "New session" surfaces here without a refetch. */
  events: WsEnvelope[];
  applySessionTransition: (transition: SessionTransitionResponse) => void;
}

export function SessionsRail({
  project,
  events,
  applySessionTransition,
}: SessionsRailProps) {
  const [sessions, setSessions] = useState<OrchestratorSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const viewing = useViewingSession((s) => (project ? s.bySlug[project.slug] ?? null : null));
  const setViewing = useViewingSession((s) => s.setViewing);

  async function handleResume(targetId: string) {
    if (!project || resumingId) return;
    setResumingId(targetId);
    setResumeError(null);
    try {
      const transition = await runtimeApi.resumeSession(project.id, targetId);
      applySessionTransition(transition);
      // Clear the read-only-viewing state so the panel snaps back to the live
      // chat (which is now the resumed conversation).
      setViewing(project.slug, null);
    } catch (err) {
      setResumeError((err as Error).message);
    } finally {
      setResumingId(null);
    }
  }

  useEffect(() => {
    if (!project) {
      setSessions([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    runtimeApi.listSessions(project.id)
      .then((rows) => {
        if (!cancelled) setSessions(rows);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  // Refetch when the chat fires a session-changed (new / resume) or the
  // canonical session.title.changed relay frame so the row's title + ordering
  // stay live.
  useEffect(() => {
    if (!project) return;
    const last = [...events].reverse().find(
      (e) =>
        e.type === 'session-changed' ||
        // Slice 015b — canonical relay session.title.changed frame.
        (isLiveEventFrame(e) && e.event.entity === 'session-title'),
    );
    if (!last) return;
    runtimeApi.listSessions(project.id)
      .then(setSessions)
      .catch(() => {});
  }, [events, project?.id]);

  if (!project) {
    return (
      <div className="flex h-full flex-col bg-card text-foreground">
        <div className="px-3 py-3 text-xs text-muted-foreground">
          Select a project to see its chat history.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-card text-foreground">
      <div className="flex-1 overflow-y-auto">
        {loading && sessions.length === 0 && (
          <div className="px-3 py-3 text-xs text-muted-foreground">Loading…</div>
        )}
        {error && (
          <div className="px-3 py-3 text-xs text-red-400">Error: {error}</div>
        )}
        {!loading && !error && sessions.length === 0 && (
          <div className="px-3 py-3 text-xs text-muted-foreground">No sessions yet.</div>
        )}
        {resumeError && (
          <div className="px-3 py-2 text-xs text-red-400">Couldn't resume: {resumeError}</div>
        )}
        {sessions.map((s) => {
          const isActive = s.status === 'active';
          const isViewing = viewing === s.id;
          const isLive = isActive && viewing === null;
          const isResuming = resumingId === s.id;
          return (
            <div
              key={s.id}
              data-testid="session-row"
              data-session-id={s.id}
              data-session-status={s.status}
              className={
                'group flex items-center border-l-2 ' +
                (isViewing || isLive
                  ? 'border-primary bg-muted'
                  : 'border-transparent hover:bg-muted')
              }
            >
              <button
                onClick={() => {
                  setViewing(project.slug, isActive ? null : s.id);
                }}
                title={titleForSession(s)}
                className={
                  'min-w-0 flex-1 px-3 py-1.5 text-left text-xs ' +
                  (isViewing || isLive
                    ? 'text-primary'
                    : 'text-foreground/80')
                }
              >
                <div className="flex items-center gap-1.5">
                  {isActive && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" title="active" />
                  )}
                  <span className="truncate">{titleForSession(s)}</span>
                </div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  {formatStarted(s.startedAt)}{isLive ? ' · live' : isViewing ? ' · viewing' : ''}
                </div>
              </button>
              {!isActive && (
                <button
                  data-testid="session-resume"
                  onClick={() => handleResume(s.id)}
                  disabled={isResuming || resumingId !== null}
                  title="Resume this conversation as the live chat"
                  className={
                    'mr-2 shrink-0 rounded border border-border bg-card px-2 py-0.5 text-[10px] ' +
                    'text-foreground/80 hover:bg-accent hover:text-accent-foreground ' +
                    'disabled:opacity-40 disabled:cursor-wait ' +
                    'opacity-0 group-hover:opacity-100 ' +
                    (isResuming ? 'opacity-100' : '')
                  }
                >
                  {isResuming ? 'Resuming…' : 'Resume'}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function titleForSession(s: OrchestratorSession): string {
  return s.title?.trim() || 'Untitled session';
}

function formatStarted(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
