// FD-19 — Areas tab (was Slice 010's Focus tab). The project's mental map:
// a grid of Area cards. Cards are DISPLAY-ONLY — name, description, open/done
// counts; click opens AreaEditModal where all editing (name, description,
// delete) happens. Reorder stays on the card (it's about the grid, not the
// Area). "New Area" creates inline. Members fall back to Uncaptured on delete.
//
// Stop conditions (do NOT add): milestones, progress bars, auto-routing.

import { useMemo, useState } from 'react';

import { areasApi, type Area } from '@/features/areas/client';
import type { Project } from '@/features/projects/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import type { WorkItemStatus } from '@/features/work-items/types';
import { useProjectAreas } from '@/hooks/use-project-areas';
import { useProjectWorkItems } from '@/hooks/use-project-work-items';
import { AreaEditModal } from './AreaEditModal';

interface Props {
  project: Project;
  events: WsEnvelope[];
}

interface AreaCounts {
  open: number;
  done: number;
}

/** done = completed; open = still in play. cancelled/archived count as neither. */
function bucketOf(status: WorkItemStatus): 'open' | 'done' | null {
  if (status === 'complete') return 'done';
  if (status === 'cancelled' || status === 'archived') return null;
  return 'open';
}

export function AreasTab({ project, events }: Props) {
  const { areas, refetch } = useProjectAreas(project, events);
  const { workItems } = useProjectWorkItems(project, events);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const sortedAreas = useMemo(
    () => [...areas].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [areas],
  );

  const countsByArea = useMemo(() => {
    const m = new Map<string, AreaCounts>();
    const uncaptured: AreaCounts = { open: 0, done: 0 };
    for (const wi of workItems) {
      const bucket = bucketOf(wi.status);
      if (!bucket) continue;
      if (wi.areaId == null) {
        uncaptured[bucket] += 1;
        continue;
      }
      const c = m.get(wi.areaId) ?? { open: 0, done: 0 };
      c[bucket] += 1;
      m.set(wi.areaId, c);
    }
    return { byArea: m, uncaptured };
  }, [workItems]);

  const editingArea = editingId ? sortedAreas.find((a) => a.id === editingId) ?? null : null;

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
              area={area}
              counts={countsByArea.byArea.get(area.id) ?? { open: 0, done: 0 }}
              isFirst={idx === 0}
              isLast={idx === sortedAreas.length - 1}
              onOpen={() => setEditingId(area.id)}
              onReorder={(dir) => void reorder(area, dir)}
            />
          ))}
        </div>
      )}

      <div className="mt-4 text-[11px] text-[var(--fg-dim)]">
        Uncaptured · {countsByArea.uncaptured.open} open ·{' '}
        {countsByArea.uncaptured.done} done — not in any Area.
      </div>

      {editingArea && (
        <AreaEditModal
          projectId={project.id}
          area={editingArea}
          openCount={countsByArea.byArea.get(editingArea.id)?.open ?? 0}
          doneCount={countsByArea.byArea.get(editingArea.id)?.done ?? 0}
          onClose={() => setEditingId(null)}
          onChanged={refetch}
        />
      )}
    </div>
  );
}

function AreaCard({
  area,
  counts,
  isFirst,
  isLast,
  onOpen,
  onReorder,
}: {
  area: Area;
  counts: AreaCounts;
  isFirst: boolean;
  isLast: boolean;
  onOpen: () => void;
  onReorder: (dir: -1 | 1) => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex cursor-pointer flex-col gap-2 border border-border/40 bg-card p-3 text-left hover:border-primary/60"
      title="Click to edit this Area"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-foreground">
          {area.name}
        </span>
        <span className="shrink-0 border border-border bg-primary/10 px-1.5 py-0.5 text-[10px] text-foreground">
          {counts.open} open
        </span>
        <span className="shrink-0 border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {counts.done} done
        </span>
      </div>

      {area.summary ? (
        <p className="line-clamp-3 whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground">
          {area.summary}
        </p>
      ) : (
        <p className="text-[12px] italic text-[var(--fg-dim)]">
          No description yet — click to add one.
        </p>
      )}

      <div className="flex items-center gap-1">
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onReorder(-1);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation();
              onReorder(-1);
            }
          }}
          aria-disabled={isFirst}
          className={`border border-border/40 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:border-border hover:text-foreground ${
            isFirst ? 'pointer-events-none opacity-30' : ''
          }`}
          aria-label="Move up"
          title="Move up"
        >
          ↑
        </span>
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onReorder(1);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation();
              onReorder(1);
            }
          }}
          aria-disabled={isLast}
          className={`border border-border/40 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:border-border hover:text-foreground ${
            isLast ? 'pointer-events-none opacity-30' : ''
          }`}
          aria-label="Move down"
          title="Move down"
        >
          ↓
        </span>
      </div>
    </button>
  );
}
