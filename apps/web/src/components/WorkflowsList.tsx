// Section 19.18 — Two-pane Workflows tab. Mirrors AgentsList: left rail with
// "This project" + "Global" sections + filters, right detail pane with
// metadata header + tab strip (Graph · Runs · Raw YAML).
//
// Replaces the flat-sectioned `WorkflowList.tsx` (deleted in this commit).
// Surface reads `/api/workflows?projectId=…` via `useProjectWorkflows`.
//
// Scope guard for this commit:
// - Graph tab renders `WorkflowGraphV2` read-only against `row.parsedDefinition`.
// - Runs tab is wired to the existing `useProjectWorkflowV2Runs` feeder
//   (sidecar-backed; 19.20 will absorb the per-run viewer modal into this tab).
// - Section 19.19: Raw YAML tab is now an editable textarea. PUT routes
//   through `normaliseDef` (parse + validate + canonical serialize); failure
//   either lands as a 400 (slug rename / structural) or as a status='invalid'
//   row carrying `parseError` — both surface inline.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkflowV2 } from '@pc/domain';
import { isWorkflowRunChangedLivePayload } from '@pc/contracts';

import type { Project, ULID } from '@/features/projects/client';
import { workflowsApi, type V2RunDetail, type V2RunEvent, type V2RunStatus, type V2RunSummary, type WorkflowRow } from '@/features/workflows/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { useProjectWorkflows } from '@/hooks/use-project-workflows';
import { useProjectWorkflowV2Runs } from '@/hooks/use-project-workflow-v2-runs';
import { useLiveEntitySignature, useLiveEvents } from '@/store/live-store';
import { useWorkflowsListNav } from '@/store/workflows-list-nav';
import { CreateWorkflowModal } from './CreateWorkflowModal';
import { WorkflowGraphV2 } from './WorkflowGraphV2';

interface WorkflowsListProps {
  project: Project;
  events: WsEnvelope[];
}

type StatusFilter = 'all' | 'enabled' | 'disabled' | 'invalid';
type DetailTab = 'graph' | 'runs' | 'yaml';
// Top-level Workflows-tab view: the workflow library, or the cross-workflow run
// history (every run from every workflow in one filterable list).
type WorkflowsView = 'workflows' | 'runs';
type RunStatusFilter = 'all' | V2RunStatus;

export function WorkflowsList({ project, events }: WorkflowsListProps) {
  const { workflows, refetch } = useProjectWorkflows(project, events);
  const { runs } = useProjectWorkflowV2Runs(project, events);

  const [view, setView] = useState<WorkflowsView>('workflows');
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<ULID | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [tab, setTab] = useState<DetailTab>('graph');
  const [actionErr, setActionErr] = useState<string | null>(null);

  // Cross-tab navigation directive — set by ActivityPanel / future callers
  // via `useWorkflowsListNav.openTo`. We watch `nav` (generation counter) so
  // re-issuing the same directive still triggers selection.
  const navSlug = useWorkflowsListNav((s) => s.workflowSlug);
  const navRunId = useWorkflowsListNav((s) => s.runId);
  const navTab = useWorkflowsListNav((s) => s.tab);
  const navGen = useWorkflowsListNav((s) => s.nav);
  const consumeNav = useWorkflowsListNav((s) => s.consume);

  // Clear selection + filters on project switch.
  useEffect(() => {
    setView('workflows');
    setSelectedId(null);
    setSelectedRunId(null);
    setFilter('');
    setStatus('all');
    setTab('graph');
    setActionErr(null);
  }, [project.id]);

  // Consume cross-tab nav directives. Runs once per `navGen` bump.
  useEffect(() => {
    if (navGen === 0 || !navSlug) return;
    const target = workflows.find((w) => w.slug === navSlug);
    if (!target) {
      // Workflow list hasn't loaded the target yet — leave the directive in
      // place so a subsequent render (when `workflows` arrives) consumes it.
      return;
    }
    // A nav directive targets a specific workflow → snap back to the library.
    setView('workflows');
    setSelectedId(target.id);
    if (navRunId) setSelectedRunId(navRunId);
    if (navTab) setTab(navTab);
    consumeNav();
    // Intentionally key only on navGen + workflows-len so the effect fires
    // exactly when (a) a new directive lands, or (b) workflows finishes
    // loading after a directive landed first.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navGen, workflows.length]);

  // Split rows by scope.
  const { projectRows, globalRows } = useMemo(() => {
    const proj: WorkflowRow[] = [];
    const glob: WorkflowRow[] = [];
    for (const w of workflows) {
      if (w.scope === 'project') proj.push(w);
      else glob.push(w);
    }
    return { projectRows: proj, globalRows: glob };
  }, [workflows]);

  // Auto-select on first load / when the current selection vanishes. Skip
  // when a nav directive is pending — otherwise auto-select races the
  // nav-consume effect and clobbers it with the first row on remount (the
  // ActivityPanel → Workflows handoff symptom).
  useEffect(() => {
    if (selectedId && workflows.some((w) => w.id === selectedId)) return;
    if (navSlug) return;
    const first = projectRows[0] ?? globalRows[0] ?? null;
    setSelectedId(first ? first.id : null);
  }, [workflows, selectedId, projectRows, globalRows, navSlug]);

  // Centralised rail-click handler: switching workflows drops the selected
  // run (runs are per-workflow). Done as a handler, NOT a useEffect keyed on
  // selectedId — the nav-directive effect also sets selectedId + selectedRunId
  // together, and an effect-based clear would run AFTER the nav effect and
  // clobber the just-set runId.
  function selectWorkflow(id: ULID) {
    if (id !== selectedId) setSelectedRunId(null);
    setSelectedId(id);
  }

  // Apply filters.
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matchText = (w: WorkflowRow) =>
      !q ||
      w.name.toLowerCase().includes(q) ||
      w.slug.toLowerCase().includes(q) ||
      (w.description ?? '').toLowerCase().includes(q);
    const matchStatus = (w: WorkflowRow) => {
      if (status === 'all') return true;
      if (status === 'invalid') return w.status === 'invalid';
      if (status === 'disabled') return w.disabled;
      if (status === 'enabled') return !w.disabled && w.status === 'active';
      return true;
    };
    const apply = (rows: WorkflowRow[]) =>
      rows.filter((w) => matchText(w) && matchStatus(w));
    return { proj: apply(projectRows), glob: apply(globalRows) };
  }, [filter, status, projectRows, globalRows]);

  const selectedRow = useMemo(
    () => (selectedId ? workflows.find((w) => w.id === selectedId) ?? null : null),
    [selectedId, workflows],
  );

  // Per-workflow run summaries (matched by slug — `V2RunSummary.workflowId`
  // carries the YAML slug, not the DB ULID).
  const runsForSelected = useMemo<V2RunSummary[]>(() => {
    if (!selectedRow) return [];
    return runs
      .filter((r) => r.workflowId === selectedRow.slug)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }, [selectedRow, runs]);

  async function onRunNow(row: WorkflowRow) {
    setActionErr(null);
    try {
      const fireBody = row.scope === 'global' ? { projectId: project.id } : {};
      await workflowsApi.fireWorkflowRow(row.id, fireBody);
    } catch (e) {
      setActionErr(`Run now failed: ${(e as Error).message}`);
    }
  }

  async function onDuplicate(row: WorkflowRow) {
    setActionErr(null);
    try {
      const created = await workflowsApi.duplicateWorkflowRow(row.id);
      setSelectedId(created.id);
      refetch();
    } catch (e) {
      setActionErr(`Duplicate failed: ${(e as Error).message}`);
    }
  }

  async function onToggleDisabled(row: WorkflowRow) {
    setActionErr(null);
    try {
      await workflowsApi.updateWorkflowRow(row.id, { disabled: !row.disabled });
      refetch();
    } catch (e) {
      setActionErr(`Update failed: ${(e as Error).message}`);
    }
  }

  async function onPromote(row: WorkflowRow) {
    setActionErr(null);
    const ok = window.confirm(
      `Promote "${row.name}" to the global pool?\n\nIt becomes available in every project. The local copy is removed from this project.`,
    );
    if (!ok) return;
    try {
      await workflowsApi.promoteWorkflowToGlobal(row.id);
      refetch();
    } catch (e) {
      setActionErr(`Promote failed: ${(e as Error).message}`);
    }
  }

  async function onDelete(row: WorkflowRow, cancel: boolean, skipConfirm = false) {
    if (!skipConfirm) {
      const ok = window.confirm(
        `Delete "${row.name}"?\n\nThis removes the workflow from ${row.scope === 'global' ? 'the global pool (every project loses access)' : 'this project'}. The action is reversible — the row is archived, not destroyed.`,
      );
      if (!ok) return;
    }
    setActionErr(null);
    try {
      await workflowsApi.deleteWorkflowRow(row.id, { cancel });
      if (selectedId === row.id) setSelectedId(null);
      refetch();
    } catch (e) {
      const err = e as Error & { kind?: string; inFlight?: number };
      if (err.kind === 'in-flight-runs') {
        const proceed = window.confirm(
          `${row.name} has ${err.inFlight ?? 'some'} in-flight run(s). Cancel them and delete?`,
        );
        if (proceed) {
          await onDelete(row, true, true);
          return;
        }
      }
      setActionErr(`Delete failed: ${err.message}`);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <header className="flex flex-col gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-1">
          <ViewTab active={view === 'workflows'} onClick={() => setView('workflows')}>
            Workflows
          </ViewTab>
          <ViewTab active={view === 'runs'} onClick={() => setView('runs')}>
            Runs
            {runs.length > 0 && (
              <span className="ml-1.5 border border-border px-1 text-[9px]">{runs.length}</span>
            )}
          </ViewTab>
        </div>
        {view === 'workflows' && (
          <>
            <div className="flex items-center gap-3">
              <div className="flex flex-1 items-center gap-2 border border-border bg-card px-2 py-1.5">
                <span aria-hidden className="text-muted-foreground">⌕</span>
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter workflows…"
                  className="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                />
              </div>
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                className="border border-primary bg-primary/30 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-primary/50"
              >
                + New workflow
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-wider text-muted-foreground">
              <ChipGroup
                label="Status"
                value={status}
                onChange={setStatus}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'enabled', label: 'Enabled' },
                  { value: 'disabled', label: 'Disabled' },
                  { value: 'invalid', label: 'Invalid' },
                ]}
              />
            </div>
          </>
        )}
      </header>

      {actionErr && (
        <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {actionErr}
          <button onClick={() => setActionErr(null)} className="ml-2 underline">
            dismiss
          </button>
        </div>
      )}

      {view === 'runs' ? (
        <RunsHistoryView project={project} runs={runs} workflows={workflows} />
      ) : (
      <div className="grid min-h-0 flex-1 grid-cols-[300px_1fr] overflow-hidden">
        <aside className="overflow-y-auto border-r border-border">
          <ListSection
            title="This project"
            count={projectRows.length}
            filteredCount={filtered.proj.length}
            empty="No workflows in this project yet."
          >
            {filtered.proj.map((row) => (
              <ListRow
                key={row.id}
                row={row}
                runs={runs.filter((r) => r.workflowId === row.slug)}
                selected={row.id === selectedId}
                onSelect={() => selectWorkflow(row.id)}
              />
            ))}
          </ListSection>

          <ListSection
            title="Global"
            subtitle="Available to every project."
            count={globalRows.length}
            filteredCount={filtered.glob.length}
            empty="No global workflows yet."
          >
            {filtered.glob.map((row) => (
              <ListRow
                key={row.id}
                row={row}
                runs={runs.filter((r) => r.workflowId === row.slug)}
                selected={row.id === selectedId}
                onSelect={() => selectWorkflow(row.id)}
              />
            ))}
          </ListSection>
        </aside>

        <main className="overflow-y-auto">
          {selectedRow ? (
            <DetailPane
              project={project}
              row={selectedRow}
              runs={runsForSelected}
              tab={tab}
              setTab={setTab}
              selectedRunId={selectedRunId}
              setSelectedRunId={setSelectedRunId}
              onEdit={() => setTab('yaml')}
              onRunNow={() => void onRunNow(selectedRow)}
              onDuplicate={() => void onDuplicate(selectedRow)}
              onToggleDisabled={() => void onToggleDisabled(selectedRow)}
              onPromote={() => void onPromote(selectedRow)}
              onDelete={() => void onDelete(selectedRow, false)}
              onSaved={refetch}
            />
          ) : (
            <EmptyDetail onAdd={() => setCreateOpen(true)} />
          )}
        </main>
      </div>
      )}

      {createOpen && (
        <CreateWorkflowModal
          project={project}
          onClose={() => setCreateOpen(false)}
          onCreated={(row) => {
            setCreateOpen(false);
            setSelectedId(row.id);
            setTab('yaml');
            refetch();
          }}
        />
      )}
    </div>
  );
}

// ── Top-level view toggle (Workflows · Runs) ───────────────────────────────

function ViewTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex items-center px-3 py-1.5 text-xs font-medium ' +
        (active
          ? 'border-b-2 border-primary text-foreground'
          : 'border-b-2 border-transparent text-muted-foreground hover:text-foreground')
      }
    >
      {children}
    </button>
  );
}

// ── Cross-workflow run history ──────────────────────────────────────────────

/** Every run from every workflow in this project, newest first, filterable by
 *  status. The failed-run home (failed runs no longer ping the human inbox —
 *  user decision 2026-06-05). Reuses RunInlineDetail (graph + diary + the
 *  "Resume from failed step" action) for the expanded row. */
function RunsHistoryView({
  project,
  runs,
  workflows,
}: {
  project: Project;
  runs: V2RunSummary[];
  workflows: WorkflowRow[];
}) {
  const [statusFilter, setStatusFilter] = useState<RunStatusFilter>('all');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  // slug → workflow row (for the expanded run's parsed definition + graph).
  const rowBySlug = useMemo(() => {
    const m = new Map<string, WorkflowRow>();
    for (const w of workflows) m.set(w.slug, w);
    return m;
  }, [workflows]);

  const sorted = useMemo(
    () => [...runs].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
    [runs],
  );
  const filtered = useMemo(
    () => (statusFilter === 'all' ? sorted : sorted.filter((r) => r.status === statusFilter)),
    [sorted, statusFilter],
  );

  // Per-status counts for the filter chip labels.
  const counts = useMemo(() => {
    const c: Partial<Record<V2RunStatus, number>> = {};
    for (const r of runs) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [runs]);

  const selectedRun = useMemo(
    () => (selectedRunId ? runs.find((r) => r.id === selectedRunId) ?? null : null),
    [runs, selectedRunId],
  );
  const selectedRow = selectedRun ? rowBySlug.get(selectedRun.workflowId) ?? null : null;

  const chip = (value: RunStatusFilter, label: string) => {
    const n = value === 'all' ? runs.length : counts[value] ?? 0;
    return { value, label: n > 0 ? `${label} (${n})` : label };
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        <ChipGroup
          label="Status"
          value={statusFilter}
          onChange={(v) => {
            setStatusFilter(v);
            setSelectedRunId(null);
          }}
          options={[
            chip('all', 'All'),
            chip('running', 'Running'),
            chip('paused', 'Paused'),
            chip('completed', 'Completed'),
            chip('failed', 'Failed'),
            chip('cancelled', 'Cancelled'),
          ]}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="flex h-full items-center justify-center p-8 text-center text-xs text-muted-foreground">
          <div>
            {runs.length === 0
              ? 'No workflow runs yet.'
              : `No ${statusFilter === 'all' ? '' : `${statusFilter} `}runs.`}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex flex-col overflow-y-auto">
            {filtered.map((r) => (
              <RunHistoryRow
                key={r.id}
                project={project}
                run={r}
                selected={r.id === selectedRunId}
                onSelect={() => setSelectedRunId(r.id === selectedRunId ? null : r.id)}
              />
            ))}
          </div>
          {selectedRunId && selectedRow && selectedRow.parsedDefinition && (
            <RunInlineDetail
              project={project}
              row={selectedRow}
              runId={selectedRunId}
              onClose={() => setSelectedRunId(null)}
            />
          )}
          {selectedRunId && (!selectedRow || !selectedRow.parsedDefinition) && (
            <div className="border-t border-border bg-card p-4 text-xs text-muted-foreground">
              This run's workflow definition is unavailable (the workflow may have
              been deleted), so the run graph can't be shown.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RunHistoryRow({
  project,
  run,
  selected,
  onSelect,
}: {
  project: Project;
  run: V2RunSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const started = run.startedAt ?? run.createdAt;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Resume straight off the row (FD-14 door). Completed steps are kept and any
  // definition edits are picked up. stopPropagation so it doesn't toggle the
  // expanded detail. Errors render inline so the row stays retryable.
  async function resume(e: React.MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await workflowsApi.resumeV2Run(project.id as ULID, run.id);
      setMsg(`Resumed${res.defChanged ? ' with your edits' : ''}.`);
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
      setTimeout(() => setMsg(null), 5000);
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={
        'flex cursor-pointer items-center justify-between gap-3 border-b border-border/40 border-l-2 px-4 py-2.5 text-xs transition-colors ' +
        (selected ? 'border-l-primary bg-muted' : 'border-l-transparent hover:bg-muted/40')
      }
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusPill status={run.status} />
        <span className="truncate font-medium text-foreground">{run.workflowName}</span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
          {run.id.slice(-8)}
        </span>
        {run.workItemId && (
          <span className="shrink-0 border border-border/60 px-1 text-[9px] uppercase tracking-wider text-muted-foreground">
            wi {run.workItemId.slice(-6)}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {msg && <span className="bg-muted px-1.5 py-0.5 text-[10px] text-foreground">{msg}</span>}
        {run.status === 'failed' && (
          <button
            type="button"
            disabled={busy}
            onClick={resume}
            className="border border-primary/50 bg-primary/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-primary hover:bg-primary/20 disabled:opacity-50"
            title="Re-runs the failed steps; completed work is kept. Picks up definition edits."
          >
            {busy ? 'Resuming…' : 'Resume'}
          </button>
        )}
        <span className="text-[10px] tabular-nums text-muted-foreground/60">
          {formatRelativeTime(started)}
        </span>
      </div>
    </div>
  );
}

// ── Left list ────────────────────────────────────────────────────────────

function ListSection({
  title,
  subtitle,
  count,
  filteredCount,
  empty,
  children,
}: {
  title: string;
  subtitle?: string;
  count: number;
  filteredCount: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <header className="flex items-center justify-between gap-2 px-3 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        <span className="flex items-center gap-2">
          <span>{title}</span>
          <span className="border border-border px-1 text-[9px] font-normal">{count}</span>
          {subtitle && (
            <span className="text-[9px] font-normal normal-case tracking-normal opacity-80">
              {subtitle}
            </span>
          )}
        </span>
      </header>
      {count === 0 ? (
        <div className="mx-3 mb-2 border border-dashed border-border px-2 py-3 text-center text-[10px] text-muted-foreground">
          {empty}
        </div>
      ) : filteredCount === 0 ? (
        <div className="mx-3 mb-2 px-2 py-2 text-center text-[10px] text-muted-foreground">
          no matches
        </div>
      ) : (
        <div className="flex flex-col">{children}</div>
      )}
    </section>
  );
}

function ListRow({
  row,
  runs,
  selected,
  onSelect,
}: {
  row: WorkflowRow;
  runs: V2RunSummary[];
  selected: boolean;
  onSelect: () => void;
}) {
  const runningCount = runs.filter(
    (r) => r.status === 'running' || r.status === 'paused',
  ).length;
  const isInvalid = row.status === 'invalid';
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={
        'flex cursor-pointer flex-col gap-0.5 border-l-2 px-3 py-2 transition-colors ' +
        (selected
          ? 'border-primary bg-muted'
          : 'border-transparent hover:bg-muted') +
        (row.disabled ? ' saturate-0' : '')
      }
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 truncate text-xs font-medium text-foreground">
          <span className="truncate">{row.name}</span>
          {row.disabled && (
            <span className="shrink-0 bg-foreground/80 px-1 py-px text-[9px] uppercase tracking-wider text-background">
              Paused
            </span>
          )}
          {isInvalid && (
            <span className="shrink-0 border border-destructive/60 bg-destructive/10 px-1 py-px text-[9px] uppercase tracking-wider text-destructive">
              Invalid
            </span>
          )}
        </span>
        {runningCount > 0 && (
          <span className="shrink-0 bg-primary/20 px-1 py-px text-[9px] uppercase tracking-wider text-primary">
            {runningCount} running
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <span className="truncate">{row.slug}</span>
      </div>
      {row.description && (
        <div className="line-clamp-2 text-[11px] leading-tight text-muted-foreground">
          {row.description}
        </div>
      )}
    </div>
  );
}

// ── Right detail pane ────────────────────────────────────────────────────

function DetailPane({
  project,
  row,
  runs,
  tab,
  setTab,
  selectedRunId,
  setSelectedRunId,
  onEdit,
  onRunNow,
  onDuplicate,
  onToggleDisabled,
  onPromote,
  onDelete,
  onSaved,
}: {
  project: Project;
  row: WorkflowRow;
  runs: V2RunSummary[];
  tab: DetailTab;
  setTab: (t: DetailTab) => void;
  selectedRunId: string | null;
  setSelectedRunId: (id: string | null) => void;
  onEdit: () => void;
  onRunNow: () => void;
  onDuplicate: () => void;
  onToggleDisabled: () => void;
  onPromote: () => void;
  onDelete: () => void;
  onSaved: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const nodeCount = nodeCountOf(row);
  const isProject = row.scope === 'project';
  const isInvalid = row.status === 'invalid';

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-col gap-3 border-b border-border px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold text-foreground">{row.name}</h2>
              {isProject ? (
                <span className="border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
                  project
                </span>
              ) : (
                <span className="border border-success/40 bg-success/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-success">
                  global
                </span>
              )}
              {row.disabled && (
                <span className="bg-foreground/80 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-background">
                  Paused
                </span>
              )}
              {isInvalid && (
                <span className="border border-destructive/60 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-destructive">
                  Invalid
                </span>
              )}
            </div>
            <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
              <span>{row.slug}</span>
              <span>·</span>
              <span>{nodeCount} node{nodeCount === 1 ? '' : 's'}</span>
              <span>·</span>
              <span>{runs.length} run{runs.length === 1 ? '' : 's'}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onRunNow}
              disabled={row.disabled || isInvalid}
              className="border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              title="Fire this workflow now"
            >
              Run now
            </button>
            <button
              type="button"
              onClick={onEdit}
              disabled={isInvalid}
              className="border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              Edit
            </button>
            <RowMenu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              row={row}
              onDuplicate={() => {
                setMenuOpen(false);
                onDuplicate();
              }}
              onToggleDisabled={() => {
                setMenuOpen(false);
                onToggleDisabled();
              }}
              onPromote={() => {
                setMenuOpen(false);
                onPromote();
              }}
              onDelete={() => {
                setMenuOpen(false);
                onDelete();
              }}
            />
          </div>
        </div>

        {row.description && (
          <p className="max-w-3xl text-sm text-muted-foreground">{row.description}</p>
        )}

      </header>

      <nav className="flex items-center gap-1 border-b border-border px-4 pt-2">
        <TabButton active={tab === 'graph'} onClick={() => setTab('graph')}>
          Graph
        </TabButton>
        <TabButton active={tab === 'runs'} onClick={() => setTab('runs')}>
          Runs
          {runs.length > 0 && (
            <span className="ml-1.5 border border-border px-1 text-[9px]">{runs.length}</span>
          )}
        </TabButton>
        <TabButton active={tab === 'yaml'} onClick={() => setTab('yaml')}>
          Raw YAML
        </TabButton>
      </nav>

      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'graph' && <GraphTab row={row} />}
        {tab === 'runs' && (
          <RunsTab
            project={project}
            row={row}
            runs={runs}
            selectedRunId={selectedRunId}
            setSelectedRunId={setSelectedRunId}
          />
        )}
        {tab === 'yaml' && <YamlTab row={row} onSaved={onSaved} />}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex items-center border-b-2 px-3 py-2 text-xs ' +
        (active
          ? 'border-primary font-medium text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground')
      }
    >
      {children}
    </button>
  );
}

// ── Tabs ─────────────────────────────────────────────────────────────────

function GraphTab({ row }: { row: WorkflowRow }) {
  if (row.status === 'invalid' || !row.parsedDefinition) {
    return (
      <div className="p-6">
        <div className="border border-destructive bg-destructive/10 p-4 text-sm">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-destructive">
            Invalid workflow
          </div>
          <pre className="whitespace-pre-wrap break-words font-mono text-xs text-destructive">
            {row.parseError ?? '(no parse error recorded)'}
          </pre>
          <p className="mt-3 text-xs text-muted-foreground">
            Re-open this workflow in the builder to fix the validation errors,
            or edit the Raw YAML tab directly.
          </p>
        </div>
      </div>
    );
  }
  const wf = row.parsedDefinition as unknown as WorkflowV2.Workflow;
  return (
    <div className="h-full">
      <WorkflowGraphV2 workflow={wf} />
    </div>
  );
}

function RunsTab({
  project,
  row,
  runs,
  selectedRunId,
  setSelectedRunId,
}: {
  project: Project;
  row: WorkflowRow;
  runs: V2RunSummary[];
  selectedRunId: string | null;
  setSelectedRunId: (id: string | null) => void;
}) {
  // Auto-scroll the selected row into view when the selection lands from a
  // cross-tab nav directive (the row may be off-screen if there are many).
  const selectedRowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selectedRunId) return;
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedRunId]);

  if (runs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-xs text-muted-foreground">
        <div>
          No runs yet for <span className="font-mono">{row.slug}</span>.
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-col overflow-y-auto">
        {runs.map((r) => (
          <RunRow
            key={r.id}
            run={r}
            selected={r.id === selectedRunId}
            onSelect={() =>
              setSelectedRunId(r.id === selectedRunId ? null : r.id)
            }
            innerRef={r.id === selectedRunId ? selectedRowRef : undefined}
          />
        ))}
      </div>
      {selectedRunId && row.parsedDefinition && (
        <RunInlineDetail
          project={project}
          row={row}
          runId={selectedRunId}
          onClose={() => setSelectedRunId(null)}
        />
      )}
    </div>
  );
}

function RunRow({
  run,
  selected,
  onSelect,
  innerRef,
}: {
  run: V2RunSummary;
  selected: boolean;
  onSelect: () => void;
  innerRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const started = run.startedAt ?? run.createdAt;
  return (
    <div
      ref={innerRef}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={
        'flex cursor-pointer items-center justify-between gap-3 border-b border-border/40 border-l-2 px-4 py-2.5 text-xs transition-colors ' +
        (selected
          ? 'border-l-primary bg-muted'
          : 'border-l-transparent hover:bg-muted/40')
      }
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusPill status={run.status} />
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {run.id.slice(-12)}
        </span>
        {run.workItemId && (
          <span className="border border-border/60 px-1 text-[9px] uppercase tracking-wider text-muted-foreground">
            wi {run.workItemId.slice(-6)}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3 text-[10px] text-muted-foreground">
        <span>{formatRelativeTime(started)}</span>
      </div>
    </div>
  );
}

/** 19.20 — inline replacement for the old WorkflowV2RunViewer modal. Loads
 *  the run's dagState once, then overlays the live `workflow-run` snapshot from
 *  the identity-keyed live store so the graph overlay + status pill update as
 *  nodes complete / fail. Reuses the workflow row's already-parsed def — no
 *  second def fetch needed.
 *
 *  Slice 018 straggler fix: this used to scan the chat-timeline `events[]` for a
 *  `workflow-v2-run-changed` envelope that the server deleted (015b) — and which
 *  never reached `events[]` anyway, since live-event frames now feed the store
 *  only. That left the run stuck "running" until a manual refresh. The store's
 *  run-changed payload carries the full `WorkflowRunDto` (dagState + status). */
function RunInlineDetail({
  project,
  row,
  runId,
  onClose,
}: {
  project: Project;
  row: WorkflowRow;
  runId: string;
  onClose: () => void;
}) {
  const [run, setRun] = useState<V2RunDetail | null>(null);
  const [diary, setDiary] = useState<V2RunEvent[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRun(null);
    setDiary([]);
    setLoadErr(null);
    void workflowsApi.getV2Run(project.id, runId)
      .then((res) => {
        if (cancelled) return;
        setRun(res.run);
        setDiary(res.events ?? []);
      })
      .catch((e: Error) => {
        if (!cancelled) setLoadErr(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, runId]);

  // M3a — the run diary is a first-class live fact (`workflow.run.event`).
  // The store keeps the latest line per run (identity-keyed); the signature
  // flips on every genuine new line → refetch the full ordered diary once.
  const diarySig = useLiveEntitySignature('workflow-run-event', project.id);
  useEffect(() => {
    if (!diarySig) return;
    let cancelled = false;
    void workflowsApi.getV2Run(project.id, runId)
      .then((res) => {
        if (cancelled) return;
        setRun(res.run);
        setDiary(res.events ?? []);
      })
      .catch(() => {
        /* transient — the next line or reopen converges it */
      });
    return () => {
      cancelled = true;
    };
  }, [diarySig, project.id, runId]);

  // Latest live run snapshot for THIS run from the identity-keyed store (the
  // version-deduped run-changed frame carries the full DTO incl. dagState).
  const liveRunFrames = useLiveEvents('workflow-run', project.id);
  const liveRun = useMemo(() => {
    for (const ev of liveRunFrames) {
      if (ev.entityId !== runId) continue;
      if (!isWorkflowRunChangedLivePayload(ev.payload)) continue;
      return ev.payload.run ?? null;
    }
    return null;
  }, [liveRunFrames, runId]);

  // Overlay the live snapshot when it is at least as fresh as the loaded run
  // (rev-gated so a stale store frame never regresses a newer fetch).
  const liveDag = useMemo<WorkflowV2.WorkflowDagState | null>(() => {
    if (!run) return null;
    if (liveRun && liveRun.rev >= run.rev) {
      return liveRun.dagState as unknown as WorkflowV2.WorkflowDagState;
    }
    return run.dagState as unknown as WorkflowV2.WorkflowDagState;
  }, [run, liveRun]);

  const liveStatus = useMemo<V2RunStatus | null>(() => {
    if (!run) return null;
    if (liveRun && liveRun.rev >= run.rev) return liveRun.status as V2RunStatus;
    return run.status;
  }, [run, liveRun]);

  const def = row.parsedDefinition as unknown as WorkflowV2.Workflow | null;

  // M6 slice C — FD-11 lifecycle controls. Cancel: any non-terminal run.
  // Resume: failed runs only ("fix it and resume" — keeps completed steps,
  // picks up definition edits). Transient confirmation per action.
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const isNonTerminal =
    liveStatus === 'pending' || liveStatus === 'running' || liveStatus === 'paused';
  const isFailed = liveStatus === 'failed';
  async function runAction(kind: 'cancel' | 'resume') {
    if (actionBusy) return;
    setActionBusy(true);
    setActionMsg(null);
    try {
      if (kind === 'cancel') {
        await workflowsApi.cancelV2Run(project.id, runId);
        setActionMsg('Run cancelled.');
      } else {
        const res = await workflowsApi.resumeV2Run(project.id, runId);
        setActionMsg(`Resumed${res.defChanged ? ' with your definition edits' : ''}.`);
      }
    } catch (e) {
      setActionMsg((e as Error).message);
    } finally {
      setActionBusy(false);
      setTimeout(() => setActionMsg(null), 5000);
    }
  }

  return (
    <div className="flex min-h-[280px] flex-1 flex-col border-t border-border bg-card">
      <header className="flex items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Run
          </span>
          <span className="truncate font-mono text-[11px] text-foreground">
            {runId}
          </span>
          {liveStatus && <StatusPill status={liveStatus} />}
          {actionMsg && (
            <span className="bg-muted px-1.5 py-0.5 text-[10px] text-foreground">{actionMsg}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isNonTerminal && (
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => void runAction('cancel')}
              className="border border-destructive/50 bg-destructive/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-destructive hover:bg-destructive/20 disabled:opacity-50"
            >
              Cancel run
            </button>
          )}
          {isFailed && (
            <button
              type="button"
              disabled={actionBusy}
              onClick={() => void runAction('resume')}
              className="border border-primary/50 bg-primary/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-primary hover:bg-primary/20 disabled:opacity-50"
              title="Re-runs the failed steps; completed work is kept. Picks up definition edits."
            >
              Resume from failed step
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="border border-border bg-card px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close run detail"
          >
            Close
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {loadErr ? (
          <div className="p-4 text-xs text-destructive">
            Couldn't load run: {loadErr}
          </div>
        ) : !run || !def ? (
          <div className="p-4 text-xs text-muted-foreground">Loading run…</div>
        ) : (
          <>
            <div className="min-w-0 flex-1 overflow-hidden">
              <WorkflowGraphV2 workflow={def} runState={liveDag} />
            </div>
            <RunDiary diary={diary} />
          </>
        )}
      </div>
    </div>
  );
}

/** M3a — the run diary timeline (FD-11: "a frozen run is never a mystery").
 *  One plain-English line per `workflow_run_events` row, oldest first; live
 *  lines land via the workflow.run.event refetch in RunInlineDetail. */
function RunDiary({ diary }: { diary: V2RunEvent[] }) {
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [diary.length]);

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-muted/20">
      <div className="border-b border-border px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Run diary
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {diary.length === 0 ? (
          <div className="text-[11px] italic text-muted-foreground/70">
            No diary entries yet.
          </div>
        ) : (
          <ol className="space-y-1.5">
            {diary.map((ev) => (
              <li key={ev.id} className="text-[11px] leading-snug">
                <span className="mr-1.5 font-mono text-[10px] text-muted-foreground">
                  {new Date(ev.at).toLocaleTimeString()}
                </span>
                <span className={diaryTone(ev.type)}>{diaryLine(ev)}</span>
              </li>
            ))}
          </ol>
        )}
        <div ref={endRef} />
      </div>
    </aside>
  );
}

/** Web twin of the pc_get_workflow_run renderer (different surface, same
 *  vocabulary — compact for the panel; the tool's prose is for the chat). */
function diaryLine(ev: V2RunEvent): string {
  const node = ev.nodeId ? `"${ev.nodeId}"` : '';
  const d = ev.data ?? {};
  switch (ev.type) {
    case 'workflow_started': return 'Run started.';
    case 'workflow_completed': return 'Run completed.';
    case 'workflow_failed': return 'Run failed.';
    case 'workflow_cancelled': return 'Run cancelled.';
    case 'run_interrupted': return 'Run interrupted — server restarted mid-flight.';
    case 'node_started': return `Step ${node} started.`;
    case 'node_completed': return `Step ${node} completed.`;
    case 'node_failed': return `Step ${node} failed${d.error ? ` — ${String(d.error)}` : ''}.`;
    case 'node_skipped': return `Step ${node} skipped${d.reason ? ` (${String(d.reason)})` : ''}.`;
    case 'agent_dispatched': return `Step ${node}: agent ${String(d.agent ?? '?')} dispatched.`;
    case 'review_requested': return `Review requested at ${node}.`;
    case 'review_approved': return `Review ${node} approved.`;
    case 'review_rejected': return `Review ${node} rejected — sent back.`;
    case 'iteration_ceiling_hit': return `Loop ceiling hit at ${node} — escalated to a human.`;
    case 'run_resumed':
      return `Run resumed from its failed step${d.defChanged ? ' (picked up definition edits)' : ''}.`;
    case 'card_moved':
      return d.error
        ? `Card move to "${String(d.stage ?? '?')}" failed.`
        : `Card moved to "${String(d.stage ?? '?')}".`;
    default: return `${ev.type}${node ? ` ${node}` : ''}.`;
  }
}

function diaryTone(type: string): string {
  if (type === 'workflow_failed' || type === 'node_failed' || type === 'run_interrupted') {
    return 'text-destructive';
  }
  if (type === 'workflow_completed') return 'text-foreground font-medium';
  if (type === 'review_rejected' || type === 'iteration_ceiling_hit') return 'text-amber-600';
  return 'text-foreground/90';
}

function YamlTab({ row, onSaved }: { row: WorkflowRow; onSaved: () => void }) {
  // Local draft layered on top of the server's `row.yaml`. The textarea is the
  // editor; Save → PUT /api/workflows/:id with `{ yaml }`; server re-parses +
  // re-validates + reconciles `parsedDefinition` + bumps `yamlHash`. On
  // success the server may have reformatted (canonical-form YAML), so we
  // re-baseline from the response — what the user sees in the editor matches
  // the DB.
  //
  // Three failure modes the user might see here:
  //   1. Structural / slug-rename → 400 → thrown Error → red banner above the
  //      editor, draft preserved so the user can fix it.
  //   2. YAML parses but validation fails → server returns 200 with
  //      `status='invalid'` + `parseError`. We surface the parseError in the
  //      same red banner; the row IS persisted invalid, matching the same
  //      shape the rail / Graph tab already use for invalid rows.
  //   3. Already-invalid row on entry → row.parseError is non-null; we show
  //      it above the editor as a starting-point warning.
  const [draft, setDraft] = useState(row.yaml);
  const [baselineYaml, setBaselineYaml] = useState(row.yaml);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(row.parseError ?? null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Adopt server-side updates. If the user has unsaved edits, leave the draft
  // alone — they probably want to keep typing. Re-baseline silently so the
  // dirty check stays honest.
  useEffect(() => {
    if (row.yaml === baselineYaml) return;
    const dirtyNow = draft !== baselineYaml;
    setBaselineYaml(row.yaml);
    if (!dirtyNow) {
      setDraft(row.yaml);
      setError(row.parseError ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.yaml, row.parseError]);

  // Reset on row switch.
  useEffect(() => {
    setDraft(row.yaml);
    setBaselineYaml(row.yaml);
    setError(row.parseError ?? null);
    setSavedAt(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id]);

  const dirty = draft !== baselineYaml;

  async function save() {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await workflowsApi.updateWorkflowRow(row.id, {
        yaml: draft,
        reason: 'ui-raw-yaml-edit',
      });
      // Server may have canonicalised — re-seed from the response.
      setBaselineYaml(updated.yaml);
      setDraft(updated.yaml);
      setSavedAt(Date.now());
      if (updated.status === 'invalid') {
        setError(updated.parseError ?? 'Workflow is invalid.');
      }
      // Belt-and-suspenders: the relay `workflow.definition.changed` frame is
      // the primary refresh path, but if the WS reconnects between Save firing
      // and the frame arriving, the list-level row stays stale. A direct
      // refetch here keeps the rail + detail header in lockstep with the
      // persisted row regardless of WS reliability.
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function revert() {
    setDraft(baselineYaml);
    setError(row.parseError ?? null);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span className="flex items-center gap-2">
          <span>Raw YAML</span>
          {dirty ? (
            <span className="border border-warning/60 bg-warning/15 px-1 py-px text-warning">
              unsaved
            </span>
          ) : savedAt ? (
            <span className="border border-success/60 bg-success/15 px-1 py-px text-success">
              saved
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-2">
          <button
            type="button"
            onClick={revert}
            disabled={!dirty || busy}
            className="border border-border bg-card px-2 py-1 text-[10px] uppercase tracking-wider hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            Revert
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || busy}
            className="border border-primary bg-primary/30 px-2 py-1 text-[10px] uppercase tracking-wider text-foreground hover:bg-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </span>
      </div>

      {error && (
        <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-destructive">
            {row.status === 'invalid' && !dirty ? 'Workflow is invalid' : 'Save error'}
          </div>
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-destructive">
            {error}
          </pre>
        </div>
      )}

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        className="flex-1 resize-none bg-background p-4 font-mono text-xs text-foreground outline-none"
        placeholder="version: 2&#10;id: my-workflow&#10;name: My workflow&#10;nodes: …"
      />
    </div>
  );
}

// ── Row menu (⋯) ─────────────────────────────────────────────────────────

function RowMenu({
  open,
  onOpenChange,
  row,
  onDuplicate,
  onToggleDisabled,
  onPromote,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  row: WorkflowRow;
  onDuplicate: () => void;
  onToggleDisabled: () => void;
  onPromote: () => void;
  onDelete: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (wrapRef.current.contains(e.target as Node)) return;
      onOpenChange(false);
    };
    // Defer one tick so the same click that opened the menu doesn't dismiss.
    const t = setTimeout(() => {
      window.addEventListener('mousedown', onDown);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpenChange(!open);
        }}
        className="border border-border bg-card px-2 py-1.5 text-sm leading-none hover:bg-muted"
        aria-label="Workflow actions"
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 flex min-w-[180px] flex-col border border-border bg-card text-xs shadow-lg">
          <MenuItem onClick={onDuplicate}>Duplicate</MenuItem>
          <MenuItem onClick={onToggleDisabled}>
            {row.disabled ? 'Enable' : 'Disable'}
          </MenuItem>
          {row.scope === 'project' && (
            <MenuItem onClick={onPromote}>Promote to global</MenuItem>
          )}
          <MenuItem onClick={onDelete} destructive>
            Delete
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  onClick,
  destructive,
  children,
}: {
  onClick: () => void;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={
        'px-3 py-2 text-left hover:bg-muted ' +
        (destructive ? 'text-destructive' : 'text-foreground')
      }
    >
      {children}
    </button>
  );
}

// ── Filter chip group ────────────────────────────────────────────────────

function ChipGroup<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-muted-foreground">{label}:</span>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={
            'border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ' +
            (value === o.value
              ? 'border-primary bg-primary/20 text-foreground'
              : 'border-border/60 text-muted-foreground hover:bg-muted hover:text-foreground')
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────

function EmptyDetail({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-xs text-muted-foreground">
      <div className="max-w-xs">
        <p>No workflow selected.</p>
        <p className="mt-1">
          Pick one from the list, or{' '}
          <button onClick={onAdd} className="underline hover:text-foreground">
            create a new workflow
          </button>
          .
        </p>
      </div>
    </div>
  );
}

// ── Pure helpers ─────────────────────────────────────────────────────────

function nodeCountOf(row: WorkflowRow): number {
  const def = row.parsedDefinition as { nodes?: unknown[] } | null;
  return def?.nodes?.length ?? 0;
}

function StatusPill({ status }: { status: V2RunStatus }) {
  const cls =
    status === 'running'
      ? 'bg-primary/20 text-primary'
      : status === 'paused'
        ? 'bg-warning/25 text-warning'
        : status === 'completed'
          ? 'bg-foreground/15 text-foreground'
          : status === 'failed'
            ? 'bg-destructive/20 text-destructive'
            : status === 'cancelled'
              ? 'bg-muted text-muted-foreground'
              : 'bg-muted text-muted-foreground';
  return (
    <span className={`px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider ${cls}`}>
      {status}
    </span>
  );
}

function formatRelativeTime(epochMs: number): string {
  const diffSec = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}min ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}
