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
import { workflowsApi, type V2RunDetail, type V2RunStatus, type V2RunSummary, type WorkflowRow } from '@/features/workflows/client';
import type { WsEnvelope, WsOutbound } from '@/features/runtime/ws-types';
import { useProjectWorkflows } from '@/hooks/use-project-workflows';
import { useProjectWorkflowV2Runs } from '@/hooks/use-project-workflow-v2-runs';
import { useLiveEvents } from '@/store/live-store';
import { useWorkflowsListNav } from '@/store/workflows-list-nav';
import { WorkflowBuilderModal } from './WorkflowBuilderModal';
import { WorkflowGraphV2 } from './WorkflowGraphV2';

interface WorkflowsListProps {
  project: Project;
  events: WsEnvelope[];
  send: (msg: WsOutbound) => boolean;
}

type StatusFilter = 'all' | 'enabled' | 'disabled' | 'invalid';
type TriggerFilter = 'all' | 'manual' | 'stage-on-entry' | 'schedule' | 'event';
type DetailTab = 'graph' | 'runs' | 'yaml';

export function WorkflowsList({ project, events, send }: WorkflowsListProps) {
  const { workflows, refetch } = useProjectWorkflows(project, events);
  const { runs } = useProjectWorkflowV2Runs(project, events);

  const [createOpen, setCreateOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<WorkflowRow | null>(null);
  const [selectedId, setSelectedId] = useState<ULID | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [triggerKind, setTriggerKind] = useState<TriggerFilter>('all');
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
    setSelectedId(null);
    setSelectedRunId(null);
    setFilter('');
    setStatus('all');
    setTriggerKind('all');
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
    const matchTrigger = (w: WorkflowRow) => {
      if (triggerKind === 'all') return true;
      const triggers = parsedTriggers(w);
      return triggers.some((t) => t.kind === triggerKind);
    };
    const apply = (rows: WorkflowRow[]) =>
      rows.filter((w) => matchText(w) && matchStatus(w) && matchTrigger(w));
    return { proj: apply(projectRows), glob: apply(globalRows) };
  }, [filter, status, triggerKind, projectRows, globalRows]);

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
          <ChipGroup
            label="Trigger"
            value={triggerKind}
            onChange={setTriggerKind}
            options={[
              { value: 'all', label: 'All' },
              { value: 'manual', label: 'Manual' },
              { value: 'stage-on-entry', label: 'Stage' },
              { value: 'schedule', label: 'Schedule' },
              { value: 'event', label: 'Event' },
            ]}
          />
        </div>
      </header>

      {actionErr && (
        <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {actionErr}
          <button onClick={() => setActionErr(null)} className="ml-2 underline">
            dismiss
          </button>
        </div>
      )}

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
              onEdit={() => setEditingRow(selectedRow)}
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

      {createOpen && (
        <WorkflowBuilderModal
          projectId={project.id}
          events={events}
          send={send}
          onClose={() => {
            setCreateOpen(false);
            refetch();
          }}
        />
      )}
      {editingRow && editingRow.parsedDefinition && (
        <WorkflowBuilderModal
          projectId={project.id}
          events={events}
          send={send}
          editingWorkflow={{
            id: editingRow.slug,
            def: editingRow.parsedDefinition as unknown as WorkflowV2.Workflow,
            yamlText: editingRow.yaml,
          }}
          onClose={() => {
            setEditingRow(null);
            refetch();
          }}
        />
      )}
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
  const triggers = parsedTriggers(row);
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
        {triggers.length > 0 && <span>·</span>}
        <span className="flex shrink-0 gap-1">
          {triggers.slice(0, 3).map((t, i) => (
            <span
              key={i}
              className="border border-border/60 px-1 text-[9px] uppercase tracking-wider"
              title={triggerLabel(t)}
            >
              {triggerShortLabel(t)}
            </span>
          ))}
        </span>
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
  const triggers = parsedTriggers(row);
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
              title="Fire this workflow with kind=manual"
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

        {triggers.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
              Triggers
            </span>
            {triggers.map((t, i) => (
              <span
                key={i}
                className="border border-border/60 bg-card px-2 py-0.5 text-[11px] text-foreground"
              >
                {triggerLabel(t)}
              </span>
            ))}
          </div>
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
        <span>{run.trigger}</span>
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
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRun(null);
    setLoadErr(null);
    void workflowsApi.getV2Run(project.id, runId)
      .then((res) => {
        if (!cancelled) setRun(res.run);
      })
      .catch((e: Error) => {
        if (!cancelled) setLoadErr(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, runId]);

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
        </div>
        <button
          type="button"
          onClick={onClose}
          className="border border-border bg-card px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Close run detail"
        >
          Close
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        {loadErr ? (
          <div className="p-4 text-xs text-destructive">
            Couldn't load run: {loadErr}
          </div>
        ) : !run || !def ? (
          <div className="p-4 text-xs text-muted-foreground">Loading run…</div>
        ) : (
          <WorkflowGraphV2 workflow={def} runState={liveDag} />
        )}
      </div>
    </div>
  );
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

interface TriggerLike {
  kind: string;
  stage?: string;
  cron?: string;
  source?: string;
}

function parsedTriggers(row: WorkflowRow): TriggerLike[] {
  const def = row.parsedDefinition as { triggers?: TriggerLike[] } | null;
  return def?.triggers ?? [];
}

function nodeCountOf(row: WorkflowRow): number {
  const def = row.parsedDefinition as { nodes?: unknown[] } | null;
  return def?.nodes?.length ?? 0;
}

function triggerShortLabel(t: TriggerLike): string {
  if (t.kind === 'manual') return 'manual';
  if (t.kind === 'stage-on-entry') return 'stage';
  if (t.kind === 'schedule') return 'cron';
  if (t.kind === 'event') return 'event';
  return t.kind;
}

function triggerLabel(t: TriggerLike): string {
  if (t.kind === 'stage-on-entry' && t.stage) return `on stage entry · ${t.stage}`;
  if (t.kind === 'manual') return 'manual';
  if (t.kind === 'schedule' && t.cron) return `cron · ${t.cron}`;
  if (t.kind === 'event' && t.source) return `event · ${t.source}`;
  return t.kind;
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
