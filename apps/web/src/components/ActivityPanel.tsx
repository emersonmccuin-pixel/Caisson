// Section 6 — Activity panel. Per-project scoped:
//   1. Running agents (top)
//   2. Running workflows
//   3. Workflow human-review inbox (pushed to bottom via mt-auto)
//   4. Failed recently (collapsed, 7-day window, very bottom)
//
// Section 32.3 — when collapsed, renders a 36px badge gutter instead of
// hiding the panel. Auto-swells when "waiting on you" or "failed recently"
// transitions from 0 → non-zero (running counts don't auto-swell — they
// resolve themselves).

import { useEffect, useMemo, useRef, useState } from 'react';

import type { Project } from '@/features/projects/client';
import {
  agentRunsApi,
  type AgentRunRecord,
  type AgentRunInspection,
} from '@/features/agent-runs/client';
import type { V2RunStatus, V2RunSummary } from '@/features/workflows/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { MailboxInbox } from '@/features/mailbox/MailboxInbox';
import { useProjectAgentRuns } from '@/hooks/use-project-agent-runs';
import { useProjectWorkflowV2Runs } from '@/hooks/use-project-workflow-v2-runs';
import { useActiveCenterTab } from '@/store/active-center-tab';
import { useAgentTranscript } from '@/store/agent-transcript';
import { useChatScrollTarget } from '@/store/chat-scroll-target';
import { useWorkflowsListNav } from '@/store/workflows-list-nav';

interface ActivityPanelProps {
  project: Project | null;
  events: WsEnvelope[];
  expanded: boolean;
  onExpand: () => void;
}

const ACTIVE_STATUSES = new Set<V2RunStatus>(['pending', 'running', 'paused']);

export function ActivityPanel({
  project,
  events,
  expanded,
  onExpand,
}: ActivityPanelProps) {
  // Single 5s tick so elapsed-time strings re-render without per-card timers.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  // 28.5 — transcript-modal state lifted to a Shell-level zustand store
  // (mirrors the WorkflowDrawer pattern) so the chat-side
  // AgentDispatchGroupBubble can open it from a different tab.
  const openTranscript = useAgentTranscript((s) => s.open);

  const { runs } = useProjectWorkflowV2Runs(project, events);
  const activeRuns = useMemo(
    () => runs.filter((r) => ACTIVE_STATUSES.has(r.status)),
    [runs],
  );
  const pausedRuns = useMemo(
    () => runs.filter((r) => r.status === 'paused'),
    [runs],
  );
  const { runs: agentRuns } = useProjectAgentRuns(project, events);

  const sevenDaysAgoMsEpoch = nowMs - 7 * 24 * 60 * 60 * 1000;
  const dismissedRunIds = useDismissedRunIds(project);
  const recentFailedRuns = useMemo(
    () =>
      runs
        .filter((r) => r.status === 'failed' || r.status === 'cancelled')
        .filter((r) => {
          const completed = r.endedAt ?? r.startedAt ?? r.createdAt;
          return completed >= sevenDaysAgoMsEpoch;
        })
        .filter((r) => !dismissedRunIds.has(r.id))
        .sort((a, b) => {
          const ta = a.endedAt ?? a.startedAt ?? a.createdAt;
          const tb = b.endedAt ?? b.startedAt ?? b.createdAt;
          return tb - ta;
        }),
    [runs, sevenDaysAgoMsEpoch, dismissedRunIds],
  );
  // Section 32.3 — auto-swell on first non-zero "waiting on you" or
  // "failed". Running counts don't auto-swell (they resolve themselves).
  const waitingCount = pausedRuns.length;
  const failedCount = recentFailedRuns.length;
  const prevWaiting = useRef(waitingCount);
  const prevFailed = useRef(failedCount);
  useEffect(() => {
    if (expanded) {
      prevWaiting.current = waitingCount;
      prevFailed.current = failedCount;
      return;
    }
    if (
      (waitingCount > 0 && prevWaiting.current === 0) ||
      (failedCount > 0 && prevFailed.current === 0)
    ) {
      onExpand();
    }
    prevWaiting.current = waitingCount;
    prevFailed.current = failedCount;
  }, [waitingCount, failedCount, expanded, onExpand]);

  if (!expanded) {
    return (
      <ActivityGutter
        agentsCount={agentRuns.length}
        workflowsCount={activeRuns.length}
        waitingCount={waitingCount}
        failedCount={failedCount}
        onExpand={onExpand}
      />
    );
  }

  return (
    <div className="flex h-full flex-col border-l border-border bg-card">
      <Header />
      {project === null ? (
        <div className="flex-1 px-3 py-2 text-xs text-muted-foreground">
          No project selected.
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-y-auto">
          <MailboxRegion project={project} />
          <RunningAgentsRegion
            project={project}
            runs={agentRuns}
            nowMs={nowMs}
            onOpenTranscript={openTranscript}
          />
          <RunningWorkflowsRegion
            project={project}
            runs={activeRuns}
            nowMs={nowMs}
          />
          <div className="mt-auto">
            <HumanReviewRegion
              project={project}
              pausedRuns={pausedRuns}
              nowMs={nowMs}
            />
            <FailedRecentlyRegion
              project={project}
              runs={recentFailedRuns}
              nowMs={nowMs}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ActivityGutter({
  agentsCount,
  workflowsCount,
  waitingCount,
  failedCount,
  onExpand,
}: {
  agentsCount: number;
  workflowsCount: number;
  waitingCount: number;
  failedCount: number;
  onExpand: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onExpand}
      title="Expand activity panel"
      className="flex h-full w-full flex-col items-center gap-3 border-l border-border bg-card py-3 hover:bg-muted/40"
    >
      <span
        className="text-[9px] uppercase tracking-[0.18em] text-muted-foreground"
        style={{ writingMode: 'vertical-rl', textOrientation: 'mixed' }}
      >
        activity
      </span>
      <GutterBadge label="Running agents" count={agentsCount} tone="muted" />
      <GutterBadge label="Running workflows" count={workflowsCount} tone="muted" />
      <GutterBadge
        label="Waiting on you"
        count={waitingCount}
        tone={waitingCount > 0 ? 'warning' : 'muted'}
      />
      <GutterBadge
        label="Failed recently"
        count={failedCount}
        tone={failedCount > 0 ? 'danger' : 'muted'}
      />
      <span className="mt-auto text-xs text-[var(--fg-dim)]">«</span>
    </button>
  );
}

function GutterBadge({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: 'muted' | 'warning' | 'danger';
}) {
  const cls =
    tone === 'warning'
      ? 'border-warning text-warning bg-[rgba(216,166,74,0.10)]'
      : tone === 'danger'
        ? 'border-destructive text-destructive bg-[rgba(199,74,58,0.10)]'
        : 'border-border text-[var(--fg-dim)]';
  return (
    <span
      title={`${label} · ${count}`}
      className={`inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full border px-1 text-[11px] ${cls}`}
    >
      {count}
    </span>
  );
}

function Header() {
  return (
    <div className="border-b border-border px-3 py-2 text-sm uppercase tracking-wider text-muted-foreground">
      Activity
    </div>
  );
}

function RegionShell({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-border">
      <div className="flex items-center justify-between px-3 py-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </div>
        {badge !== undefined && (
          <div className="bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
            {badge}
          </div>
        )}
      </div>
      <div>{children}</div>
    </section>
  );
}

function EmptyRegion({ text }: { text: string }) {
  return <div className="px-3 pb-2 text-[11px] italic text-muted-foreground/70">{text}</div>;
}

function RunningWorkflowsRegion({
  runs,
  nowMs,
}: {
  project: Project;
  runs: V2RunSummary[];
  nowMs: number;
}) {
  return (
    <RegionShell title="Running workflows" badge={String(runs.length)}>
      {runs.length === 0 ? (
        <EmptyRegion text="No workflows running." />
      ) : (
        <ul className="divide-y divide-border/50">
          {runs.map((run) => (
            <RunningWorkflowCard key={run.id} run={run} nowMs={nowMs} />
          ))}
        </ul>
      )}
    </RegionShell>
  );
}

function RunningWorkflowCard({
  run,
  nowMs,
}: {
  run: V2RunSummary;
  nowMs: number;
}) {
  // 19.12 — cancel button removed; v2 has no run-cancel endpoint yet (the
  // v1 endpoint died with the v1 routes). Re-add when the v2 cancel ships.
  // 19.20 — modal viewer removed; click now navigates to the Workflows tab
  // with the run selected inline.
  const setTab = useActiveCenterTab((s) => s.setTab);
  const openTo = useWorkflowsListNav((s) => s.openTo);

  const startedAt = run.startedAt ?? run.createdAt;
  const elapsed = formatElapsed(nowMs - startedAt);
  const statusLabel =
    run.status === 'paused'
      ? 'paused'
      : run.status === 'pending'
        ? 'starting…'
        : 'running';

  return (
    <li>
      <button
        type="button"
        onClick={() => {
          setTab('workflows');
          openTo({ workflowSlug: run.workflowId, runId: run.id, tab: 'runs' });
        }}
        className="block w-full px-3 py-2 text-left hover:bg-muted/40"
      >
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
            {run.workflowName || run.workflowId}
          </div>
          <div className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {elapsed}
          </div>
        </div>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {statusLabel}
        </div>
      </button>
    </li>
  );
}

function MailboxRegion({
  project,
}: {
  project: Project;
}) {
  const [expanded, setExpanded] = useState(true);
  const [count, setCount] = useState(0);

  return (
    <section className="border-b border-border">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-1.5 hover:bg-muted/40"
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-muted-foreground">
            {expanded ? '▾' : '▸'}
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Inbox
          </span>
        </div>
        <div className="bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
          {count}
        </div>
      </button>
      {/* Keep mounted when collapsed so the count stays live. */}
      <div className={expanded ? 'px-3 pb-2' : 'hidden'}>
        <MailboxInbox
          scope={{ projectId: project.id }}
          onVisibleCount={setCount}
        />
      </div>
    </section>
  );
}

function RunningAgentsRegion({
  project,
  runs,
  nowMs,
  onOpenTranscript,
}: {
  project: Project;
  runs: AgentRunRecord[];
  nowMs: number;
  onOpenTranscript: (runId: string) => void;
}) {
  return (
    <RegionShell title="Running agents" badge={String(runs.length)}>
      {runs.length === 0 ? (
        <EmptyRegion text="No agents running." />
      ) : (
        <ul className="divide-y divide-border/50">
          {runs.map((run) => (
            <RunningAgentCard
              key={run.runId}
              run={run}
              projectId={project.id}
              nowMs={nowMs}
              onOpenTranscript={onOpenTranscript}
            />
          ))}
        </ul>
      )}
    </RegionShell>
  );
}

function RunningAgentCard({
  run,
  projectId,
  nowMs,
  onOpenTranscript,
}: {
  run: AgentRunRecord;
  projectId: string;
  nowMs: number;
  onOpenTranscript: (runId: string) => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  const [cancelErr, setCancelErr] = useState<string | null>(null);
  const [killing, setKilling] = useState(false);
  const [killErr, setKillErr] = useState<string | null>(null);
  const [showInspect, setShowInspect] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [inspectErr, setInspectErr] = useState<string | null>(null);
  const [inspection, setInspection] = useState<AgentRunInspection | null>(null);

  const elapsed = formatElapsed(nowMs - run.startedAt);
  const statusLabel =
    run.status === 'spawning'
      ? 'starting…'
      : run.status === 'paused'
        ? 'paused'
        : 'running';

  async function handleCancel(e: React.MouseEvent) {
    e.stopPropagation();
    if (cancelling) return;
    setCancelling(true);
    setCancelErr(null);
    try {
      await agentRunsApi.cancelAgentRun(projectId, run.runId);
    } catch (err) {
      setCancelErr((err as Error).message);
      setCancelling(false);
    }
    // No setCancelling(false) on success — the terminal `agent-run-changed`
    // envelope drops the row from the map, unmounting this card.
  }

  async function loadInspection() {
    setInspecting(true);
    setInspectErr(null);
    try {
      setInspection(await agentRunsApi.inspectAgentRun(projectId, run.runId));
    } catch (err) {
      setInspectErr((err as Error).message);
    } finally {
      setInspecting(false);
    }
  }

  function handleToggleInspect(e: React.MouseEvent) {
    e.stopPropagation();
    const next = !showInspect;
    setShowInspect(next);
    if (next) void loadInspection();
  }

  async function handleKill(e: React.MouseEvent) {
    e.stopPropagation();
    if (killing) return;
    setKilling(true);
    setKillErr(null);
    try {
      const res = await agentRunsApi.killAgentRun(projectId, run.runId);
      if (!res.ok) {
        setKillErr(res.error ?? 'kill failed');
        setKilling(false);
      }
    } catch (err) {
      setKillErr((err as Error).message);
      setKilling(false);
    }
    // On success the terminal `agent-run-changed` envelope unmounts this card.
  }

  return (
    <li>
      {/* role=button (not <button>) so the inner action <button>s aren't
          invalid nested-interactive descendants. */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpenTranscript(run.runId)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpenTranscript(run.runId);
          }
        }}
        className="block w-full cursor-pointer px-3 py-2 text-left hover:bg-muted/40"
        aria-label={`Open transcript for ${run.agentName}`}
      >
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
            {run.agentName}
          </div>
          <div className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {elapsed}
          </div>
        </div>
        <div className="mt-0.5 flex items-baseline justify-between gap-2">
          <div className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {statusLabel}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={handleToggleInspect}
              aria-expanded={showInspect}
              className="border border-border bg-card px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-muted"
            >
              {showInspect ? 'Hide' : 'Inspect'}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={cancelling}
              className="border border-border bg-card px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-destructive/20 hover:text-destructive disabled:opacity-50"
            >
              {cancelling ? '…' : 'Cancel'}
            </button>
          </div>
        </div>
        {cancelErr && (
          <div className="mt-1 text-[10px] text-destructive">cancel failed: {cancelErr}</div>
        )}

        {showInspect && (
          <div
            className="mt-1.5 border-t border-border pt-1.5 text-[10px] text-muted-foreground"
            onClick={(e) => e.stopPropagation()}
          >
            {inspecting && <div>inspecting…</div>}
            {inspectErr && <div className="text-destructive">inspect failed: {inspectErr}</div>}
            {inspection && (
              <div className="flex flex-col gap-0.5">
                <div className="flex justify-between gap-2">
                  <span>process</span>
                  <span className="font-mono">
                    {inspection.pid === null
                      ? 'no pid'
                      : inspection.processAlive
                        ? `pid ${inspection.pid} · alive`
                        : `pid ${inspection.pid} · DEAD`}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span>idle</span>
                  <span className="font-mono">
                    {inspection.idleMs === null ? '—' : formatElapsed(inspection.idleMs)}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span>last action</span>
                  <span className="truncate font-mono">{inspection.lastAction?.kind ?? '—'}</span>
                </div>
              </div>
            )}
            <div className="mt-1.5 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void loadInspection()}
                disabled={inspecting}
                className="border border-border bg-card px-1.5 py-0.5 uppercase tracking-wider hover:bg-muted disabled:opacity-50"
              >
                Refresh
              </button>
              <button
                type="button"
                onClick={handleKill}
                disabled={killing}
                className="border border-destructive/60 bg-card px-1.5 py-0.5 uppercase tracking-wider text-destructive hover:bg-destructive/20 disabled:opacity-50"
                title="Force-kill the OS process and finalize the run (works on a wedged/phantom run)"
              >
                {killing ? '…' : 'Force-kill'}
              </button>
            </div>
            {killErr && <div className="mt-1 text-destructive">kill failed: {killErr}</div>}
          </div>
        )}
      </div>
    </li>
  );
}

function formatElapsed(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}


function HumanReviewRegion({
  pausedRuns,
  nowMs,
}: {
  project: Project;
  pausedRuns: V2RunSummary[];
  nowMs: number;
}) {
  // 19.12 — paused v2 runs land here. The old v1 `/api/projects/:id/approvals`
  // endpoint (per-approval-node scroll-to-chat-bubble) is gone; click jumps
  // to chat (orchestrator tab) where the human-review prompt sits as a bubble.
  // 19.20 — modal viewer removed; we drop the dual setTab+openViewer call.
  // Per-approval-bubble navigation re-enters when v2 surfaces a pending-asks
  // LIST endpoint (none today).
  const setTab = useActiveCenterTab((s) => s.setTab);
  // requestScrollTo retained for the future per-approval navigation path; not
  // used in v1 of this region.
  void useChatScrollTarget;

  if (pausedRuns.length === 0) {
    return (
      <RegionShell title="Waiting on you" badge="0">
        <EmptyRegion text="Nothing waiting for your input." />
      </RegionShell>
    );
  }

  return (
    <RegionShell title="Waiting on you" badge={String(pausedRuns.length)}>
      <ul className="divide-y divide-border/50">
        {pausedRuns.map((run) => {
          const startedAt = run.startedAt ?? run.createdAt;
          const waiting = formatElapsed(nowMs - startedAt);
          return (
            <li key={run.id}>
              <button
                type="button"
                onClick={() => setTab('orchestrator')}
                className="block w-full px-3 py-2 text-left hover:bg-muted/40"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                    {run.workflowName || run.workflowId}
                  </div>
                  <div className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {waiting}
                  </div>
                </div>
                <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  paused — review in chat
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </RegionShell>
  );
}

function useDismissedRunIds(project: Project | null): Set<string> {
  const [ids, setIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!project) {
      setIds(new Set());
      return;
    }
    let cancelled = false;
    void agentRunsApi.listFailedRunDismissals(project.id).then((list) => {
      if (!cancelled) setIds(new Set(list));
    });
    return () => {
      cancelled = true;
    };
  }, [project?.id]);

  // Expose a setter via the same hook so the region can optimistically add
  // dismissed ids; re-fetch on next mount keeps server-of-truth canonical.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ runId: string }>).detail;
      if (!detail?.runId) return;
      setIds((prev) => {
        if (prev.has(detail.runId)) return prev;
        const next = new Set(prev);
        next.add(detail.runId);
        return next;
      });
    };
    window.addEventListener('pc:failed-run-dismissed', handler as EventListener);
    return () => {
      window.removeEventListener('pc:failed-run-dismissed', handler as EventListener);
    };
  }, []);

  return ids;
}

function FailedRecentlyRegion({
  project,
  runs,
  nowMs,
}: {
  project: Project;
  runs: V2RunSummary[];
  nowMs: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const setTab = useActiveCenterTab((s) => s.setTab);
  const openTo = useWorkflowsListNav((s) => s.openTo);

  async function handleDismiss(runId: string) {
    // Optimistic: emit the dismissal event so the hook drops it from the
    // list before the round-trip lands.
    window.dispatchEvent(
      new CustomEvent('pc:failed-run-dismissed', { detail: { runId } }),
    );
    try {
      await agentRunsApi.dismissFailedRun(project.id, runId);
    } catch {
      /* best-effort; user can re-click if it failed */
    }
  }

  if (runs.length === 0) {
    return (
      <RegionShell title="Failed recently" badge="0">
        <EmptyRegion text="No failures in the last 7 days." />
      </RegionShell>
    );
  }

  return (
    <section className="border-b border-border">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-1.5 hover:bg-muted/40"
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-muted-foreground">
            {expanded ? '▾' : '▸'}
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Failed recently
          </span>
        </div>
        <div className="bg-destructive/20 px-1.5 py-0.5 text-[10px] font-mono text-destructive">
          {runs.length}
        </div>
      </button>
      {expanded && (
        <ul className="divide-y divide-border/50">
          {runs.map((run) => {
            const endedAt = run.endedAt ?? run.startedAt ?? run.createdAt;
            const when = formatElapsed(nowMs - endedAt);
            const stepLabel = run.lastReason
              ? `${run.status}: ${run.lastReason}`
              : run.status;
            return (
              <li key={run.id} className="flex items-baseline gap-2 px-3 py-2">
                <button
                  type="button"
                  onClick={() => {
                    setTab('workflows');
                    openTo({
                      workflowSlug: run.workflowId,
                      runId: run.id,
                      tab: 'runs',
                    });
                  }}
                  className="min-w-0 flex-1 text-left hover:underline"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
                      {run.workflowName || run.workflowId}
                    </div>
                    <div className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {when} ago
                    </div>
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {stepLabel}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => void handleDismiss(run.id)}
                  className="shrink-0 border border-border bg-card px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="Hide this failure from the list"
                >
                  Dismiss
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
