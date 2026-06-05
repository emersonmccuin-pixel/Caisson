// Section 16b.8.3 — Activity Panel live-transcript modal for a running agent.
//
// Opens when the user clicks a Running agents card. Renders a slide-in panel
// (same pattern as WorkflowDrawer) with:
//   - Header: agent name + sessionId + worktreeDir + status pill
//   - Body: live transcript of JSONL events forwarded by the server as
//     `{ type: 'agent-jsonl-event', runId, event }` envelopes
//
// On open, the modal backfills prior events through
// `GET /api/projects/:projectId/agent-runs/:runId/events`, then appends live
// `agent-jsonl-event` envelopes from the project's WS stream.
//
// Modal dismiss contract: explicit Close button only — no Escape, no backdrop
// click. Per `feedback_modals_explicit_close_only`.

import { useEffect, useMemo, useRef, useState } from 'react';

import { agentRunsApi, type AgentRunRecord } from '@/features/agent-runs/client';
import {
  agentTranscriptEmptyMessage,
  mergeAgentTranscriptEvents,
  type AgentTranscriptLoadStatus,
} from '@/features/agent-runs/transcript';
import { TranscriptRow } from '@/features/agent-runs/TranscriptRow';
import type { AgentRunTranscriptStatus } from '@/features/agent-runs/types';
import type { JsonlEvent, WsEnvelope } from '@/features/runtime/ws-types';

interface AgentTranscriptModalProps {
  run: AgentRunRecord;
  events: WsEnvelope[];
  onClose: () => void;
}

export function AgentTranscriptModal({ run, events, onClose }: AgentTranscriptModalProps) {
  const [backfill, setBackfill] = useState<{
    status: AgentTranscriptLoadStatus;
    transcriptStatus: AgentRunTranscriptStatus | null;
    events: JsonlEvent[];
    jsonlPath: string | null;
    error: string | null;
  }>({
    status: 'loading',
    transcriptStatus: null,
    events: [],
    jsonlPath: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    setBackfill({
      status: 'loading',
      transcriptStatus: null,
      events: [],
      jsonlPath: null,
      error: null,
    });
    agentRunsApi
      .getAgentRunEvents(run.projectId, run.runId)
      .then((response) => {
        if (cancelled) return;
        setBackfill({
          status: 'ready',
          transcriptStatus: response.transcriptStatus,
          events: response.events as JsonlEvent[],
          jsonlPath: response.jsonlPath,
          error: null,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setBackfill({
          status: 'error',
          transcriptStatus: null,
          events: [],
          jsonlPath: null,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [run.projectId, run.runId]);

  const transcriptItems = useMemo(
    () =>
      mergeAgentTranscriptEvents({
        runId: run.runId,
        backfillEvents: backfill.events,
        events,
      }),
    [backfill.events, events, run.runId],
  );

  // Auto-scroll body to bottom when new events arrive.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [transcriptItems.length]);

  const statusPillClasses =
    run.status === 'paused'
      ? 'bg-warning/25 text-warning'
      : run.status === 'spawning'
        ? 'bg-muted text-muted-foreground'
        : 'bg-primary/20 text-primary';

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal
      aria-label="Agent transcript"
    >
      <div className="flex-1 bg-black/40" aria-hidden="true" />
      <aside className="flex h-full w-full max-w-6xl flex-col border-l border-border bg-card shadow-2xl">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Agent
            </div>
            <div className="flex items-baseline gap-2">
              <div className="truncate text-sm font-semibold text-foreground">
                {run.agentName}
              </div>
              <span
                className={`shrink-0 px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${statusPillClasses}`}
              >
                {run.status}
              </span>
            </div>
            <div
              className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
              title={run.sessionId}
            >
              session: {run.sessionId}
            </div>
            <div
              className="truncate font-mono text-[11px] text-muted-foreground"
              title={run.worktreeDir}
            >
              cwd: {run.worktreeDir}
            </div>
            {backfill.jsonlPath && (
              <div
                className="truncate font-mono text-[11px] text-muted-foreground"
                title={backfill.jsonlPath}
              >
                jsonl: {backfill.jsonlPath}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close transcript"
            className="shrink-0 border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-muted"
          >
            ✕ Close
          </button>
        </header>

        <div
          ref={bodyRef}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
        >
          {transcriptItems.length === 0 ? (
            <div
              className={`text-xs italic text-muted-foreground${
                run.status === 'queued' || run.status === 'spawning' || run.status === 'running'
                  ? ' animate-pulse'
                  : ''
              }`}
            >
              {agentTranscriptEmptyMessage({
                loadStatus: backfill.status,
                transcriptStatus: backfill.transcriptStatus,
                runStatus: run.status,
              })}
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {transcriptItems.map((item) => (
                <TranscriptRow key={item.key} event={item.event} />
              ))}
            </ul>
          )}
          {backfill.status === 'error' && (
            <div className="mt-3 text-xs text-destructive">
              Backfill unavailable: {backfill.error}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

