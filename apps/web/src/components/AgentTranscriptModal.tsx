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

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  agentRunsApi,
  type AgentRunInspection,
  type AgentRunRecord,
} from '@/features/agent-runs/client';
import {
  agentTranscriptEmptyMessage,
  mergeAgentTranscriptEvents,
  type AgentTranscriptLoadStatus,
} from '@/features/agent-runs/transcript';
import { RichAgentTranscript } from '@/features/agent-runs/RichAgentTranscript';
import type { AgentRunTranscriptStatus } from '@/features/agent-runs/types';
import { agentsApi, type Pod } from '@/features/agents/client';
import { PodDetailModal } from '@/components/agents/PodDetailModal';
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

  const nonTerminal =
    run.status === 'queued' ||
    run.status === 'spawning' ||
    run.status === 'running' ||
    run.status === 'paused';

  // Liveness diagnostics (pid/idle/last action) — moved up from the list card's
  // Inspect. Loaded on open, refreshable, and polled while the run is live.
  const [inspection, setInspection] = useState<AgentRunInspection | null>(null);
  const loadInspection = useCallback(() => {
    agentRunsApi
      .inspectAgentRun(run.projectId, run.runId)
      .then(setInspection)
      .catch(() => {
        /* diagnostics are best-effort — never block the transcript */
      });
  }, [run.projectId, run.runId]);

  useEffect(() => {
    loadInspection();
    if (!nonTerminal) return;
    const t = setInterval(loadInspection, 5000);
    return () => clearInterval(t);
  }, [loadInspection, nonTerminal]);

  // Run controls — Cancel (graceful) + Force-kill (wedged/phantom run), moved
  // off the list card onto this top bar.
  const [cancelling, setCancelling] = useState(false);
  const [killing, setKilling] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const handleCancel = useCallback(async () => {
    if (cancelling) return;
    setCancelling(true);
    setActionMsg(null);
    try {
      await agentRunsApi.cancelAgentRun(run.projectId, run.runId);
      setActionMsg('Cancel requested.');
    } catch (err) {
      setActionMsg(`Cancel failed: ${(err as Error).message}`);
    } finally {
      setCancelling(false);
    }
  }, [cancelling, run.projectId, run.runId]);

  const handleKill = useCallback(async () => {
    if (killing) return;
    setKilling(true);
    setActionMsg(null);
    try {
      const res = await agentRunsApi.killAgentRun(run.projectId, run.runId);
      setActionMsg(res.ok ? 'Force-killed.' : `Force-kill failed: ${res.error ?? 'unknown'}`);
    } catch (err) {
      setActionMsg(`Force-kill failed: ${(err as Error).message}`);
    } finally {
      setKilling(false);
    }
  }, [killing, run.projectId, run.runId]);

  // Open the project-scoped agent (pod) behind this run — prompt · knowledge ·
  // settings. Resolve by name, preferring a project-scoped match.
  const [pod, setPod] = useState<Pod | null>(null);
  const [podErr, setPodErr] = useState<string | null>(null);
  const [podLoading, setPodLoading] = useState(false);
  const openPod = useCallback(async () => {
    if (podLoading) return;
    setPodLoading(true);
    setPodErr(null);
    try {
      const pods = await agentsApi.listPods(run.projectId);
      const named = pods.filter((p) => p.name === run.agentName);
      const match = named.find((p) => p.scope === 'project') ?? named[0] ?? null;
      if (!match) setPodErr(`No agent named "${run.agentName}" found in this project.`);
      else setPod(match);
    } catch (err) {
      setPodErr(`Couldn't open agent: ${(err as Error).message}`);
    } finally {
      setPodLoading(false);
    }
  }, [podLoading, run.projectId, run.agentName]);

  const processLabel =
    inspection == null
      ? '…'
      : inspection.pid === null
        ? 'no pid'
        : inspection.processAlive
          ? `pid ${inspection.pid} · alive`
          : `pid ${inspection.pid} · dead`;
  const idleLabel =
    inspection?.idleMs == null ? '—' : formatIdle(inspection.idleMs);

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
        <header className="shrink-0 border-b border-border bg-muted/30 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Agent
              </div>
              <div className="flex items-center gap-2">
                {/* Click → the project agent's details (prompt · knowledge · settings). */}
                <button
                  type="button"
                  onClick={() => void openPod()}
                  disabled={podLoading}
                  title="Open this agent's details — prompt, knowledge, settings"
                  className="truncate text-sm font-semibold text-foreground underline decoration-dotted underline-offset-4 hover:text-primary disabled:opacity-60"
                >
                  {run.agentName}
                </button>
                <span
                  className={`shrink-0 px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${statusPillClasses}`}
                >
                  {run.status}
                </span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {nonTerminal && (
                <button
                  type="button"
                  onClick={() => void handleCancel()}
                  disabled={cancelling}
                  className="border border-border bg-card px-2 py-1 text-xs hover:bg-destructive/15 hover:text-destructive disabled:opacity-50"
                >
                  {cancelling ? 'Cancelling…' : 'Cancel'}
                </button>
              )}
              {nonTerminal && (
                <button
                  type="button"
                  onClick={() => void handleKill()}
                  disabled={killing}
                  title="Force-kill the OS process and finalize the run (for a wedged/phantom run)"
                  className="border border-destructive/50 bg-card px-2 py-1 text-xs text-destructive hover:bg-destructive/15 disabled:opacity-50"
                >
                  {killing ? '…' : 'Force-kill'}
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close transcript"
                className="border border-border bg-card px-2 py-1 text-xs font-medium hover:bg-muted"
              >
                ✕ Close
              </button>
            </div>
          </div>

          {/* Liveness diagnostics — moved up from the list card's Inspect. */}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <span>
              process: <span className="font-mono text-foreground/80">{processLabel}</span>
            </span>
            <span>
              idle: <span className="font-mono text-foreground/80">{idleLabel}</span>
            </span>
            <span>
              last action:{' '}
              <span className="font-mono text-foreground/80">
                {inspection?.lastAction?.kind ?? '—'}
              </span>
            </span>
            <button
              type="button"
              onClick={loadInspection}
              className="border border-border bg-card px-1.5 py-0.5 text-[10px] uppercase tracking-wider hover:bg-muted"
            >
              Refresh
            </button>
          </div>

          {actionMsg && <div className="mt-1 text-[11px] text-foreground/80">{actionMsg}</div>}
          {podErr && <div className="mt-1 text-[11px] text-destructive">{podErr}</div>}

          {/* Secondary identity. */}
          <div
            className="mt-1.5 truncate font-mono text-[10px] text-muted-foreground/80"
            title={run.sessionId}
          >
            session: {run.sessionId}
          </div>
          <div
            className="truncate font-mono text-[10px] text-muted-foreground/80"
            title={run.worktreeDir}
          >
            cwd: {run.worktreeDir}
          </div>
          {backfill.jsonlPath && (
            <div
              className="truncate font-mono text-[10px] text-muted-foreground/80"
              title={backfill.jsonlPath}
            >
              jsonl: {backfill.jsonlPath}
            </div>
          )}
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          <RichAgentTranscript
            projectId={run.projectId}
            sessionId={run.sessionId}
            items={transcriptItems}
            emptyState={
              <span
                className={
                  run.status === 'queued' || run.status === 'spawning' || run.status === 'running'
                    ? 'animate-pulse'
                    : ''
                }
              >
                {agentTranscriptEmptyMessage({
                  loadStatus: backfill.status,
                  transcriptStatus: backfill.transcriptStatus,
                  runStatus: run.status,
                })}
              </span>
            }
          />
          {backfill.status === 'error' && (
            <div className="shrink-0 border-t border-border px-4 py-2 text-xs text-destructive">
              Backfill unavailable: {backfill.error}
            </div>
          )}
        </div>
      </aside>
      {pod && (
        <PodDetailModal
          pod={pod}
          readOnly={pod.origin === 'stock'}
          onClose={() => setPod(null)}
          onDeleted={() => setPod(null)}
        />
      )}
    </div>
  );
}

/** Compact idle duration for the diagnostics row. */
function formatIdle(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

