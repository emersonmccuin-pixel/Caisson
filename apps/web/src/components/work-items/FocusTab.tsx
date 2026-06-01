// Slice 010 — Focus tab. The human's "big stuff" altitude: a handful of Area
// cards, not a task firehose. Each card edits name + plain summary, reorders
// (up/down), and deletes (members fall back to Uncaptured). A "New Area"
// affordance creates. Member counts derive from the project work-item list.
//
// Stop conditions (do NOT add): milestones, progress bars, auto-routing.

import { useEffect, useMemo, useState } from 'react';

import { AreaConflictError, areasApi, type Area } from '@/features/areas/client';
import type { Project } from '@/features/projects/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { useProjectAreas } from '@/hooks/use-project-areas';
import { useProjectWorkItems } from '@/hooks/use-project-work-items';

interface Props {
  project: Project;
  events: WsEnvelope[];
}

export function FocusTab({ project, events }: Props) {
  const { areas, refetch } = useProjectAreas(project, events);
  const { workItems } = useProjectWorkItems(project, events);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sortedAreas = useMemo(
    () => [...areas].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [areas],
  );

  const countByArea = useMemo(() => {
    const m = new Map<string, number>();
    let uncap = 0;
    for (const wi of workItems) {
      if (wi.areaId == null) uncap += 1;
      else m.set(wi.areaId, (m.get(wi.areaId) ?? 0) + 1);
    }
    return { byArea: m, uncaptured: uncap };
  }, [workItems]);

  async function createArea() {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      await areasApi.createArea(project.id, { name });
      setNewName('');
      setCreating(false);
      refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reorder(area: Area, dir: -1 | 1) {
    const idx = sortedAreas.findIndex((a) => a.id === area.id);
    const swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= sortedAreas.length) return;
    const ids = sortedAreas.map((a) => a.id);
    [ids[idx], ids[swap]] = [ids[swap]!, ids[idx]!];
    try {
      await areasApi.reorderAreas(project.id, ids);
      refetch();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(area: Area) {
    if (
      !window.confirm(
        `Delete Area "${area.name}"?\n\nItems in this Area move to Uncaptured. No work items are deleted.`,
      )
    ) {
      return;
    }
    try {
      await areasApi.deleteArea(project.id, area.id);
      refetch();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="mx-auto h-full max-w-[1000px] overflow-y-auto px-7 py-6 pb-16">
      <div className="mb-4 flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-[0.08em] text-[var(--fg-dim)]">
          Areas · {sortedAreas.length}
        </div>
        {creating ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void createArea();
            }}
            className="flex items-center gap-2"
          >
            <input
              autoFocus
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Area name"
              className="border border-border bg-background px-2 py-1 text-[12px]"
            />
            <button
              type="submit"
              disabled={busy || !newName.trim()}
              className="border border-primary bg-primary/10 px-3 py-1 text-[11px] uppercase tracking-[0.06em] text-primary hover:bg-primary/20 disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create'}
            </button>
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setNewName('');
              }}
              className="px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="border border-primary px-3 py-1 text-[11px] uppercase tracking-[0.06em] text-primary hover:bg-primary/10"
          >
            + New Area
          </button>
        )}
      </div>

      {error && (
        <div className="mb-3 border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-3 underline"
          >
            dismiss
          </button>
        </div>
      )}

      {sortedAreas.length === 0 ? (
        <div className="border border-dashed border-border/30 px-4 py-10 text-center text-sm text-muted-foreground">
          No Areas yet. An Area is a project-scoped bucket — an outcome, a
          category, or a junk drawer. Everything starts in{' '}
          <span className="text-foreground">Uncaptured</span>.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {sortedAreas.map((area, idx) => (
            <AreaCard
              key={area.id}
              projectId={project.id}
              area={area}
              count={countByArea.byArea.get(area.id) ?? 0}
              isFirst={idx === 0}
              isLast={idx === sortedAreas.length - 1}
              onChanged={refetch}
              onReorder={(dir) => void reorder(area, dir)}
              onDelete={() => void remove(area)}
              onError={setError}
            />
          ))}
        </div>
      )}

      <div className="mt-4 text-[11px] text-[var(--fg-dim)]">
        Uncaptured · {countByArea.uncaptured} item
        {countByArea.uncaptured === 1 ? '' : 's'} not in any Area.
      </div>
    </div>
  );
}

function AreaCard({
  projectId,
  area,
  count,
  isFirst,
  isLast,
  onChanged,
  onReorder,
  onDelete,
  onError,
}: {
  projectId: string;
  area: Area;
  count: number;
  isFirst: boolean;
  isLast: boolean;
  onChanged: () => void;
  onReorder: (dir: -1 | 1) => void;
  onDelete: () => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState(area.name);
  const [summary, setSummary] = useState(area.summary);
  const [savingName, setSavingName] = useState(false);

  // Re-sync local drafts when the underlying area changes (e.g. live refetch).
  useEffect(() => {
    setName(area.name);
  }, [area.name]);
  useEffect(() => {
    setSummary(area.summary);
  }, [area.summary]);

  async function saveName() {
    const trimmed = name.trim();
    if (savingName || trimmed === area.name) return;
    if (!trimmed) {
      setName(area.name);
      return;
    }
    setSavingName(true);
    try {
      await areasApi.patchArea(projectId, area.id, {
        expectedVersion: area.version,
        name: trimmed,
      });
      onChanged();
    } catch (e) {
      handleAreaError(e, area, setName, onError);
    } finally {
      setSavingName(false);
    }
  }

  async function saveSummary() {
    if (summary === area.summary) return;
    try {
      await areasApi.patchArea(projectId, area.id, {
        expectedVersion: area.version,
        summary,
      });
      onChanged();
    } catch (e) {
      handleAreaError(e, area, setSummary, onError, 'summary');
    }
  }

  return (
    <div className="flex flex-col gap-2 border border-border/40 bg-card p-3">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void saveName()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          className="min-w-0 flex-1 border-b border-transparent bg-transparent text-[14px] font-semibold text-foreground outline-none hover:border-border/40 focus:border-primary"
          aria-label="Area name"
        />
        <span className="shrink-0 border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {count}
        </span>
      </div>

      <textarea
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        onBlur={() => void saveSummary()}
        rows={3}
        placeholder="What's this Area about? (plain summary)"
        className="w-full resize-y border border-border/30 bg-background px-2 py-1 text-[12px] leading-relaxed text-foreground"
      />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onReorder(-1)}
            disabled={isFirst}
            className="border border-border/40 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:border-border hover:text-foreground disabled:opacity-30"
            aria-label="Move up"
            title="Move up"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => onReorder(1)}
            disabled={isLast}
            className="border border-border/40 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:border-border hover:text-foreground disabled:opacity-30"
            aria-label="Move down"
            title="Move down"
          >
            ↓
          </button>
        </div>
        <button
          type="button"
          onClick={onDelete}
          className="border border-destructive/40 px-2 py-0.5 text-[11px] text-destructive hover:bg-destructive/10"
          title="Delete Area — items move to Uncaptured"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function handleAreaError(
  e: unknown,
  area: Area,
  resetLocal: (v: string) => void,
  onError: (msg: string) => void,
  field: 'name' | 'summary' = 'name',
) {
  if (e instanceof AreaConflictError) {
    onError(`"${area.name}" changed elsewhere — reloaded.`);
    resetLocal(field === 'name' ? e.current.name : e.current.summary);
  } else {
    onError((e as Error).message);
  }
}
