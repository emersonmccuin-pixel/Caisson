// Command (step 5) — the cross-project right rail. Same shape as the per-project
// ActivityPanel, but UNSCOPED: running agents + workflows + the inbox aggregated
// across EVERY project, each row labelled with its project so you can see the
// whole board at once.
//
// First cut: a 5s poll over each project's running-agents + workflow-runs
// endpoints (running activity is low-frequency; the per-project ActivityPanel's
// live-WS-merge can be ported later if the poll feels laggy). The inbox rides
// MailboxInbox's existing { all: true } scope, so it's already live.

import { useEffect, useMemo, useState } from 'react';

import { COMMAND_PROJECT_SLUG } from '@pc/contracts';

import type { Project } from '@/features/projects/client';
import { agentRunsApi, type AgentRunRecord } from '@/features/agent-runs/client';
import { workflowsApi, type V2RunStatus, type V2RunSummary } from '@/features/workflows/client';
import { MailboxInbox } from '@/features/mailbox/MailboxInbox';
import { useAgentTranscript } from '@/store/agent-transcript';
import { QuickTasksPanel } from './work-items/QuickTasksPanel';

const ACTIVE_STATUSES = new Set<V2RunStatus>(['pending', 'running', 'paused']);

interface Props {
  projects: Project[];
  expanded: boolean;
  onExpand: () => void;
}

export function CommandActivityPanel({ projects, expanded, onExpand }: Props) {
  const openTranscript = useAgentTranscript((s) => s.open);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const projectNames = useMemo(
    () => Object.fromEntries(projects.map((p) => [p.id, p.name])) as Record<string, string>,
    [projects],
  );

  const [agentRuns, setAgentRuns] = useState<AgentRunRecord[]>([]);
  const [workflowRuns, setWorkflowRuns] = useState<V2RunSummary[]>([]);

  const commandProject = useMemo(
    () => projects.find((p) => p.slug === COMMAND_PROJECT_SLUG) ?? null,
    [projects],
  );

  const projectIdsKey = projects.map((p) => p.id).join(',');
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const results = await Promise.all(
        projects.map(async (p) => {
          const [a, w] = await Promise.all([
            agentRunsApi.listAgentRuns(p.id).catch(() => [] as AgentRunRecord[]),
            workflowsApi
              .listV2WorkflowRuns(p.id)
              .then((r) => r.runs)
              .catch(() => [] as V2RunSummary[]),
          ]);
          return { a, w };
        }),
      );
      if (cancelled) return;
      setAgentRuns(results.flatMap((r) => r.a));
      setWorkflowRuns(results.flatMap((r) => r.w).filter((r) => ACTIVE_STATUSES.has(r.status)));
    }
    void load();
    const id = setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectIdsKey]);

  const waitingCount = workflowRuns.filter((r) => r.status === 'paused').length;

  if (!expanded) {
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
          activity · all
        </span>
        <GutterBadge count={agentRuns.length} tone="muted" />
        <GutterBadge count={workflowRuns.length} tone="muted" />
        <GutterBadge count={waitingCount} tone={waitingCount > 0 ? 'warning' : 'muted'} />
        <span className="mt-auto text-xs text-[var(--fg-dim)]">«</span>
      </button>
    );
  }

  return (
    <div className="flex h-full flex-col border-l border-border bg-card">
      <div className="border-b border-border px-3 py-2 text-sm uppercase tracking-wider text-muted-foreground">
        Activity · all projects
      </div>
      <div className="flex flex-1 flex-col overflow-y-auto min-h-0">
        <InboxRegion projectNames={projectNames} />
        <Region title="Running agents" count={agentRuns.length} empty="No agents running anywhere.">
          {agentRuns.map((run) => (
            <Row
              key={run.runId}
              title={run.agentName}
              project={projectNames[run.projectId] ?? run.projectId}
              elapsed={formatElapsed(nowMs - run.startedAt)}
              onClick={() => openTranscript(run.runId, run)}
            />
          ))}
        </Region>
        <Region
          title="Running workflows"
          count={workflowRuns.length}
          empty="No workflows running anywhere."
        >
          {workflowRuns.map((run) => (
            <Row
              key={run.id}
              title={run.workflowName || run.workflowId}
              project={projectNames[run.projectId] ?? run.projectId}
              elapsed={formatElapsed(nowMs - (run.startedAt ?? run.createdAt))}
              badge={run.status === 'paused' ? 'awaiting human' : undefined}
            />
          ))}
        </Region>
      </div>
      {commandProject && <QuickTasksPanel commandProject={commandProject} />}
    </div>
  );
}

function InboxRegion({ projectNames }: { projectNames: Record<string, string> }) {
  const [count, setCount] = useState(0);
  return (
    <section className="border-b border-border">
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Inbox · all projects
        </span>
        <span className="bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
          {count}
        </span>
      </div>
      <div className="px-3 pb-2">
        <MailboxInbox scope={{ all: true }} onVisibleCount={setCount} projectNames={projectNames} />
      </div>
    </section>
  );
}

function Region({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-border">
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        <span className="bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
          {count}
        </span>
      </div>
      {count === 0 ? (
        <div className="px-3 pb-2 text-[11px] italic text-muted-foreground/70">{empty}</div>
      ) : (
        <ul className="divide-y divide-border/50">{children}</ul>
      )}
    </section>
  );
}

function Row({
  title,
  project,
  elapsed,
  badge,
  onClick,
}: {
  title: string;
  project: string;
  elapsed: string;
  badge?: string;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{title}</div>
        <div className="shrink-0 font-mono text-[10px] text-muted-foreground">{elapsed}</div>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="truncate">{project}</span>
        {badge && (
          <span className="shrink-0 border border-amber-500/40 bg-amber-500/10 px-1 py-px text-[9px] uppercase tracking-wider text-amber-600 dark:text-amber-400">
            {badge}
          </span>
        )}
      </div>
    </>
  );
  return (
    <li>
      {onClick ? (
        <button type="button" onClick={onClick} className="block w-full px-3 py-2 text-left hover:bg-muted/40">
          {inner}
        </button>
      ) : (
        <div className="px-3 py-2">{inner}</div>
      )}
    </li>
  );
}

function GutterBadge({ count, tone }: { count: number; tone: 'muted' | 'warning' }) {
  const cls =
    tone === 'warning'
      ? 'border-warning text-warning bg-[rgba(216,166,74,0.10)]'
      : 'border-border text-[var(--fg-dim)]';
  return (
    <span
      className={`inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full border px-1 text-[11px] ${cls}`}
    >
      {count}
    </span>
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
