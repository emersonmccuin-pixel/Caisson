// Two-pane Agents tab. Left: searchable list, grouped by "This project" +
// "Built-in" (stock specialists, read-only here — editing lives in Global
// Settings). Right: detail panel for the selected agent — description, stats,
// tools, knowledge (rendered markdown). PodDetailModal still handles deep
// edits (prompt body, settings, secrets, history); the "Edit" button in the
// right pane opens it.

import { useEffect, useMemo, useRef, useState } from 'react';

import type { Project, ULID } from '@/features/projects/client';
import { agentsApi, resolveModelLabel, type Pod, type PodBundle } from '@/features/agents/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { useProjectPods } from '@/hooks/use-project-pods';
import { useLiveEvents } from '@/store/live-store';
import { hasNewPodFrameFor } from '@/features/agents/pod-live-events';
import { formatToolLabel } from '@/lib/tool-labels';
import { Markdown } from './Markdown';
import { ContextTab } from './agents/ContextTab';
import { CreatePodModal } from './agents/CreatePodModal';
import { PodDetailModal } from './agents/PodDetailModal';

interface AgentsListProps {
  project: Project;
  events: WsEnvelope[];
}

export function AgentsList({ project, events }: AgentsListProps) {
  const { pods, refetch } = useProjectPods(project, events);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailModalPodId, setDetailModalPodId] = useState<string | null>(null);
  const [selectedPodId, setSelectedPodId] = useState<string | null>(null);
  // Built-in section is collapsed by default (Section 36+): user's own
  // project agents are the actionable surface; stock pods are reference
  // material the user reaches for occasionally. Top of the rail + collapsed
  // closed keeps them one click away without taking screen space.
  const [builtinCollapsed, setBuiltinCollapsed] = useState(true);
  const [filter, setFilter] = useState('');

  const { stockPods, projectPods } = useMemo(() => {
    const stock: Pod[] = [];
    const proj: Pod[] = [];
    for (const pod of pods) {
      if (pod.origin === 'stock') {
        stock.push(pod);
      } else {
        // Includes both private project pods and shared (shareable) pods that
        // are members of this project — the API already scopes the list.
        proj.push(pod);
      }
    }
    return { stockPods: stock, projectPods: proj };
  }, [pods]);

  // Auto-select a sensible default on project switch + when the current
  // selection disappears (deleted, project switch).
  useEffect(() => {
    setSelectedPodId(null);
    setFilter('');
  }, [project.id]);

  useEffect(() => {
    if (selectedPodId && pods.some((p) => p.id === selectedPodId)) return;
    const first = projectPods[0] ?? stockPods[0] ?? null;
    setSelectedPodId(first ? first.id : null);
  }, [pods, selectedPodId, projectPods, stockPods]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return { stock: stockPods, project: projectPods };
    const q = filter.trim().toLowerCase();
    const match = (p: Pod) =>
      p.name.toLowerCase().includes(q) ||
      (p.description ?? '').toLowerCase().includes(q);
    return {
      stock: stockPods.filter(match),
      project: projectPods.filter(match),
    };
  }, [filter, stockPods, projectPods]);

  const selectedPod = useMemo(
    () => (selectedPodId ? pods.find((p) => p.id === selectedPodId) ?? null : null),
    [selectedPodId, pods],
  );

  const detailModalPod = useMemo(
    () => (detailModalPodId ? pods.find((p) => p.id === detailModalPodId) ?? null : null),
    [detailModalPodId, pods],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex flex-1 items-center gap-2 border border-border bg-card px-2 py-1.5">
          <span aria-hidden className="text-muted-foreground">⌕</span>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter agents…"
            className="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="border border-primary bg-primary/30 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-primary/50"
        >
          + Add agent
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[300px_1fr] overflow-hidden">
        <aside className="overflow-y-auto border-r border-border">
          <ListSection
            title="Built-in"
            subtitle="Built-in — view-only."
            count={stockPods.length}
            filteredCount={filtered.stock.length}
            empty="No stock specialists."
            collapsed={builtinCollapsed}
            onToggle={() => setBuiltinCollapsed((c) => !c)}
          >
            {filtered.stock.map((pod) => (
              <ListRow
                key={pod.id}
                pod={pod}
                selected={pod.id === selectedPodId}
                onSelect={() => setSelectedPodId(pod.id)}
              />
            ))}
          </ListSection>

          <ListSection
            title="This project"
            count={projectPods.length}
            filteredCount={filtered.project.length}
            empty="No project agents yet."
            startExpanded
          >
            {filtered.project.map((pod) => (
              <ListRow
                key={pod.id}
                pod={pod}
                selected={pod.id === selectedPodId}
                onSelect={() => setSelectedPodId(pod.id)}
              />
            ))}
          </ListSection>
        </aside>

        <main className="overflow-y-auto">
          {selectedPod ? (
            <DetailPane
              pod={selectedPod}
              projectId={project.id}
              onEdit={() => setDetailModalPodId(selectedPod.id)}
              onPromoted={() => void refetch()}
              onDeleted={() => {
                setSelectedPodId(null);
                void refetch();
              }}
            />
          ) : (
            <EmptyDetail onAdd={() => setCreateOpen(true)} />
          )}
        </main>
      </div>

      {createOpen && (
        <CreatePodModal
          project={project}
          onClose={() => setCreateOpen(false)}
          onCreated={(newPod: Pod) => {
            setCreateOpen(false);
            setSelectedPodId(newPod.id);
            void refetch();
          }}
        />
      )}
      {detailModalPod && (
        <PodDetailModal
          pod={detailModalPod}
          readOnly={detailModalPod.origin === 'stock'}
          onClose={() => setDetailModalPodId(null)}
          onDeleted={() => {
            setDetailModalPodId(null);
            setSelectedPodId(null);
            void refetch();
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
  collapsed,
  onToggle,
  startExpanded: _startExpanded,
  children,
}: {
  title: string;
  subtitle?: string;
  count: number;
  filteredCount: number;
  empty: string;
  collapsed?: boolean;
  onToggle?: () => void;
  startExpanded?: boolean;
  children: React.ReactNode;
}) {
  const togglable = onToggle !== undefined;
  const open = togglable ? !collapsed : true;
  return (
    <section>
      <header
        role={togglable ? 'button' : undefined}
        tabIndex={togglable ? 0 : undefined}
        onClick={onToggle}
        onKeyDown={
          togglable
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onToggle?.();
                }
              }
            : undefined
        }
        className={
          'flex items-center justify-between gap-2 px-3 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground' +
          (togglable ? ' cursor-pointer select-none hover:text-foreground' : '')
        }
      >
        <span className="flex items-center gap-2">
          {togglable && (
            <span aria-hidden className="inline-block w-2 text-[8px]">
              {open ? '▼' : '▶'}
            </span>
          )}
          <span>{title}</span>
          <span className="border border-border px-1 text-[9px] font-normal">{count}</span>
          {subtitle && (
            <span className="text-[9px] font-normal normal-case tracking-normal opacity-80">
              {subtitle}
            </span>
          )}
        </span>
      </header>
      {open && (
        <>
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
        </>
      )}
    </section>
  );
}

function ListRow({
  pod,
  selected,
  onSelect,
}: {
  pod: Pod;
  selected: boolean;
  onSelect: () => void;
}) {
  // Section 36+ — only stock pods can drift from a canonical seed; custom
  // pods are user-authored from the start so the concept doesn't apply.
  // driftedFields === null on non-stock rows (or stock rows without
  // canonical content); [] on pristine; populated when customised.
  const customized = pod.driftedFields !== null && pod.driftedFields.length > 0;
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
          : 'border-transparent hover:bg-muted')
      }
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 truncate text-xs font-medium text-foreground">
          <span className="truncate">{pod.name}</span>
          {customized && (
            <span
              className="shrink-0 border border-amber-500/60 bg-amber-500/10 px-1 py-px text-[9px] uppercase tracking-wider text-amber-300"
              title={`Customized — drifted on: ${pod.driftedFields!.join(', ')}`}
            >
              Customized
            </span>
          )}
          {pod.shareable && (
            <span
              className="shrink-0 border border-sky-500/60 bg-sky-500/10 px-1 py-px text-[9px] uppercase tracking-wider text-sky-300"
              title={`Shared — in ${pod.memberProjectIds?.length ?? 0} project(s)`}
            >
              Shared · {pod.memberProjectIds?.length ?? 0}
            </span>
          )}
        </span>
        <span className="shrink-0 text-[9px] uppercase tracking-wider text-muted-foreground">
          {resolveModelLabel(pod.model)}
        </span>
      </div>
      {pod.description && (
        <div className="line-clamp-2 text-[11px] leading-tight text-muted-foreground">
          {pod.description}
        </div>
      )}
    </div>
  );
}

// ── Right detail pane ────────────────────────────────────────────────────

function DetailPane({
  pod,
  projectId,
  onEdit,
  onPromoted,
  onDeleted,
}: {
  pod: Pod;
  projectId: string;
  onEdit: () => void;
  onPromoted: () => void;
  onDeleted: () => void;
}) {
  const [bundle, setBundle] = useState<PodBundle | null>(null);
  const [bundleLoading, setBundleLoading] = useState(true);
  const [bundleErr, setBundleErr] = useState<string | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  const isStock = pod.origin === 'stock';
  // Non-stock pods (private or shared) that are visible in this project.
  const isProject = pod.origin !== 'stock';

  const loadBundle = useMemo(() => {
    return () => {
      setBundleLoading(true);
      setBundleErr(null);
      return agentsApi.getPod(pod.id)
        .then((b) => {
          setBundle(b);
          setBundleLoading(false);
        })
        .catch((e: unknown) => {
          setBundleErr((e as Error).message);
          setBundleLoading(false);
        });
    };
  }, [pod.id]);

  useEffect(() => {
    let cancelled = false;
    setBundle(null);
    setActionErr(null);
    setConfirmingDelete(false);
    setBundleLoading(true);
    setBundleErr(null);
    agentsApi.getPod(pod.id)
      .then((b) => {
        if (!cancelled) {
          setBundle(b);
          setBundleLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setBundleErr((e as Error).message);
          setBundleLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pod.id]);

  // T3.2b — refetch the bundle when a NEW `pod` frame off the identity-keyed
  // live store says THIS pod changed (typically a nested mutation — knowledge
  // add/edit/delete from elsewhere). The selector unions global-scope pods so a
  // stock/global pod change still reloads. Version-keyed → fires once per frame.
  const podEvents = useLiveEvents('pod', projectId);
  const podSeenRef = useRef<Map<string, number | string>>(new Map());
  useEffect(() => {
    if (hasNewPodFrameFor(podEvents, pod.id, podSeenRef.current)) void loadBundle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [podEvents, pod.id]);

  const stats = useMemo(() => {
    return {
      model: resolveModelLabel(pod.model),
      effort: pod.effort ?? '—',
      maxTurns: pod.maxTurns != null ? String(pod.maxTurns) : '∞',
      tools: pod.tools.length,
      contextDocs: bundle?.contextDocs.length ?? null,
      edited: formatRelativeTime(pod.updatedAt),
    };
  }, [pod, bundle]);

  async function promote() {
    if (promoting) return;
    const ok = window.confirm(
      `Make "${pod.name}" shareable?\n\nIt's added to the shared library and can then be attached to other projects. It stays in this project.`,
    );
    if (!ok) return;
    setPromoting(true);
    setActionErr(null);
    try {
      await agentsApi.promotePodToGlobal(pod.id);
      onPromoted();
    } catch (e) {
      setActionErr((e as Error).message);
    } finally {
      setPromoting(false);
    }
  }

  async function deletePod() {
    setActionErr(null);
    try {
      await agentsApi.deletePod(pod.id);
      onDeleted();
    } catch (e) {
      const err = e as Error & { kind?: string };
      setActionErr(err.message);
      setConfirmingDelete(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <header className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-lg font-semibold text-foreground">{pod.name}</h2>
              {isStock && (
                <span className="border border-success/40 bg-success/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-success">
                  stock
                </span>
              )}
              {isProject && !pod.shareable && (
                <span className="border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
                  project
                </span>
              )}
              {pod.shareable && (
                <span className="border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-sky-400">
                  shared · {pod.memberProjectIds?.length ?? 0}
                </span>
              )}
              {isStock && (
                <span className="bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  read-only
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onEdit}
            className="border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted"
          >
            {isStock ? 'Open' : 'Edit'}
          </button>
        </header>

        {pod.description && (
          <p className="mb-5 max-w-3xl text-sm text-muted-foreground">{pod.description}</p>
        )}

        <div className="mb-6 grid grid-cols-2 gap-px border border-border/40 bg-border/40 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Model" value={stats.model} />
          <Stat label="Effort" value={stats.effort} />
          <Stat label="Max turns" value={stats.maxTurns} />
          <Stat label="Tools" value={String(stats.tools)} />
          <Stat
            label="Context docs"
            value={stats.contextDocs != null ? String(stats.contextDocs) : '…'}
          />
          <Stat label="Edited" value={stats.edited} />
        </div>

        <DetailSection title="Tools">
          {pod.tools.length === 0 ? (
            <div className="text-[11px] text-muted-foreground">No tools allowed.</div>
          ) : (
            <div className="flex flex-wrap gap-1">
              {pod.tools.map((t) => (
                <span
                  key={t}
                  title={t}
                  className="border border-border/60 bg-card px-2 py-0.5 text-[11px] text-foreground"
                >
                  {formatToolLabel(t)}
                </span>
              ))}
            </div>
          )}
        </DetailSection>

        <DetailSection title="Context docs">
          <ContextTab
            podId={pod.id as ULID}
            bundle={bundle}
            loading={bundleLoading}
            error={bundleErr}
            onChanged={() => void loadBundle()}
            readOnly={isStock}
            collapseDocsByDefault
            previewLineCount={3}
          />
        </DetailSection>

        <DetailSection title="Prompt">
          {pod.prompt ? (
            <Markdown text={pod.prompt} />
          ) : (
            <div className="text-[11px] italic text-muted-foreground">(no prompt)</div>
          )}
        </DetailSection>
      </div>

      {actionErr && (
        <div className="border-t border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {actionErr}
          <button onClick={() => setActionErr(null)} className="ml-2 underline">
            dismiss
          </button>
        </div>
      )}

      {isProject && (
        <footer className="flex items-center justify-between gap-2 border-t border-border px-6 py-3">
          {confirmingDelete ? (
            <div className="flex w-full items-center justify-between gap-3">
              <span className="text-xs text-foreground">
                Delete <span className="font-medium">{pod.name}</span>? Removes the agent and
                its context docs from this project.
              </span>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void deletePod()}
                  className="border border-destructive/60 bg-card px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10"
                >
                  Delete agent
                </button>
              </div>
            </div>
          ) : (
            <>
              {pod.shareable ? (
                <span className="text-xs text-sky-400">
                  Shared — in {pod.memberProjectIds?.length ?? 0} project(s). Manage in the Membership tab.
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => void promote()}
                  disabled={promoting}
                  className="border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
                  title="Add this agent to the shared library so it can be attached to other projects"
                >
                  {promoting ? 'Making shareable…' : 'Make shareable'}
                </button>
              )}
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="border border-destructive/60 bg-card px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10"
              >
                Delete
              </button>
            </>
          )}
        </footer>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card px-3 py-2">
      <div className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 text-sm font-medium text-foreground">{value}</div>
    </div>
  );
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-5">
      <div className="mb-2 border-b border-border/40 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      {children}
    </section>
  );
}

function EmptyDetail({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-xs text-muted-foreground">
      <div className="max-w-xs">
        <p>No agent selected.</p>
        <p className="mt-1">
          Pick one from the list, or{' '}
          <button onClick={onAdd} className="underline hover:text-foreground">
            add a new agent
          </button>
          .
        </p>
      </div>
    </div>
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
