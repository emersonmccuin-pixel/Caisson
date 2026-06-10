// pc-pty-chat-355 — Focus view in the WORK section.
//
// Shows all starred/focused work items (focusedAt != null) across every project,
// nested: Project → Area → Work items.
//
// Hierarchy always reads true: a focused work item appears under its real project
// and real area even when neither the project nor the area is itself starred.
//
// Live: refetches when work-item or project frames change in the live store
// (which is the write path for setFocus mutations via the live relay).

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { Area } from '@/features/areas/client';
import { areasApi } from '@/features/areas/client';
import type { Project } from '@/features/projects/client';
import { workItemsApi, type WorkItem } from '@/features/work-items/client';
import {
  useLiveEntitySignatureAllProjects,
  useLiveGlobalSignature,
} from '@/store/live-store';
import { buildFocusTree, type FocusProject } from './focus-group';

interface Props {
  projects: Project[];
}

export function FocusTab({ projects }: Props) {
  const [focusedItems, setFocusedItems] = useState<WorkItem[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Live-update signatures: refetch when any work-item or project focus changes.
  const wiSig = useLiveEntitySignatureAllProjects('work-item');
  const projSig = useLiveGlobalSignature('project');

  const projectIds = projects.map((p) => p.id).join(',');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [items, ...areaGroups] = await Promise.all([
        workItemsApi.focusedWorkItems(),
        ...projects.map((p) =>
          areasApi.listAreas(p.id).catch(() => [] as Area[]),
        ),
      ]);
      setFocusedItems(items);
      setAreas(areaGroups.flat());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectIds]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // Refetch when a work-item or project focus frame lands.
  useEffect(() => {
    if (wiSig || projSig) void load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wiSig, projSig]);

  const tree = useMemo(
    () => buildFocusTree(focusedItems, projects, areas),
    [focusedItems, projects, areas],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-7 py-6 text-sm text-destructive">{error}</div>
    );
  }

  if (tree.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <div className="text-2xl text-muted-foreground/30">★</div>
        <p className="text-sm text-muted-foreground">
          Nothing in focus yet. Use the Command planner (or the star on any
          work item) to mark what matters right now.
        </p>
      </div>
    );
  }

  return (
    <div className="pc-work-content mx-auto h-full max-w-[900px] overflow-y-auto px-7 py-6 pb-16">
      <div className="mb-4 text-[11px] uppercase tracking-[0.08em] text-[var(--fg-dim)]">
        Focus · {focusedItems.length} {focusedItems.length === 1 ? 'item' : 'items'}
      </div>
      <div className="flex flex-col gap-6">
        {tree.map((proj) => (
          <ProjectSection key={proj.id} proj={proj} />
        ))}
      </div>
    </div>
  );
}

function ProjectSection({ proj }: { proj: FocusProject }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10px] text-amber-500" aria-hidden>★</span>
        <span className="text-[13px] font-semibold text-foreground">{proj.name}</span>
      </div>
      <div className="flex flex-col gap-3 pl-4">
        {proj.areas.map((area) => (
          <AreaSection key={area.id ?? '__uncategorized__'} area={area} />
        ))}
      </div>
    </div>
  );
}

function AreaSection({ area }: { area: FocusProject['areas'][number] }) {
  return (
    <div>
      <div className="mb-1 text-[11px] uppercase tracking-[0.07em] text-muted-foreground">
        {area.name}
      </div>
      <ul className="flex flex-col gap-1 pl-3">
        {area.items.map((item) => (
          <FocusItemRow key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}

function FocusItemRow({ item }: { item: FocusProject['areas'][number]['items'][number] }) {
  return (
    <li className="flex items-baseline gap-2 border-l border-primary/30 pl-3 py-0.5">
      {item.callsign && (
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {item.callsign}
        </span>
      )}
      <span className="min-w-0 flex-1 text-[13px] text-foreground">{item.title}</span>
      <StatusBadge status={item.status} />
    </li>
  );
}

const STATUS_CLASS: Record<string, string> = {
  pending:               'border-border text-muted-foreground',
  'in-progress':         'border-primary/50 text-primary',
  'awaiting-verification': 'border-amber-500/50 text-amber-600 dark:text-amber-400',
  blocked:               'border-destructive/50 text-destructive',
  complete:              'border-border/30 text-muted-foreground/50',
  failed:                'border-destructive/30 text-destructive/60',
  cancelled:             'border-border/20 text-muted-foreground/40',
  archived:              'border-border/20 text-muted-foreground/40',
};

function StatusBadge({ status }: { status: string }) {
  const cls = STATUS_CLASS[status] ?? 'border-border text-muted-foreground';
  return (
    <span
      className={`shrink-0 border px-1.5 py-px text-[10px] uppercase tracking-[0.04em] ${cls}`}
    >
      {status}
    </span>
  );
}
