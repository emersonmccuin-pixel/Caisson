// FD-19 — Areas tab (was Slice 010's Focus tab). The project's mental map:
// a grid of Area cards. Cards are DISPLAY-ONLY — name, description, open/done
// counts; click opens AreaDetailModal (name · summary · member list). Edit is
// a button inside the detail modal. Reorder stays on the card (it's about the
// grid, not the Area). "New Area" creates inline. Members fall back to
// Uncaptured on delete.
//
// Stop conditions (do NOT add): milestones, progress bars, auto-routing.

import { useMemo, useState } from 'react';

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';

/** Mirrors the Transform shape from @dnd-kit/core (not re-exported). */
interface DndTransform { x: number; y: number; scaleX: number; scaleY: number }

/** Mirrors CSS.Transform.toString from @dnd-kit/utilities (not a direct dep). */
function transformToStr(t: DndTransform | null): string | undefined {
  if (!t) return undefined;
  return `translate3d(${t.x}px, ${t.y}px, 0) scaleX(${t.scaleX}) scaleY(${t.scaleY})`;
}

import { areasApi, type Area } from '@/features/areas/client';
import type { Project } from '@/features/projects/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import type { WorkItemStatus } from '@/features/work-items/types';
import { useProjectAreas } from '@/hooks/use-project-areas';
import { useProjectWorkItems } from '@/hooks/use-project-work-items';
import { AreaDetailModal } from './AreaDetailModal';

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
  const [detailId, setDetailId] = useState<string | null>(null);
  const [showUncategorized, setShowUncategorized] = useState(false);

  // Optimistic ordering: maintained locally during drag, synced on drop.
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const sortedAreas = useMemo(
    () => [...areas].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [areas],
  );

  // If we have a local optimistic ordering, apply it on top of sorted areas.
  const displayAreas = useMemo(() => {
    if (!localOrder) return sortedAreas;
    const byId = new Map(sortedAreas.map((a) => [a.id, a]));
    return localOrder.flatMap((id) => {
      const a = byId.get(id);
      return a ? [a] : [];
    });
  }, [sortedAreas, localOrder]);

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

  const detailArea = detailId ? sortedAreas.find((a) => a.id === detailId) ?? null : null;

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

  // ── DnD sensors ──────────────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Small activation distance so a click still fires onOpen.
      activationConstraint: { distance: 5 },
    }),
  );

  function handleDragStart(event: DragStartEvent) {
    setDraggingId(String(event.active.id));
    // Snapshot current display order so overlay is correct.
    setLocalOrder(displayAreas.map((a) => a.id));
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setDraggingId(null);

    if (!over || active.id === over.id) {
      // No move — clear optimistic order so it reconciles on next refetch.
      setLocalOrder(null);
      return;
    }

    const current = localOrder ?? displayAreas.map((a) => a.id);
    const oldIdx = current.indexOf(String(active.id));
    const newIdx = current.indexOf(String(over.id));
    if (oldIdx < 0 || newIdx < 0) {
      setLocalOrder(null);
      return;
    }

    const reordered = arrayMove(current, oldIdx, newIdx);
    setLocalOrder(reordered);
    try {
      await areasApi.reorderAreas(project.id, reordered);
      refetch();
    } catch (e) {
      setError((e as Error).message);
      setLocalOrder(null);
    }
  }

  const draggingArea = draggingId ? sortedAreas.find((a) => a.id === draggingId) ?? null : null;

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

      {sortedAreas.length === 0 && (
        <div className="mb-3 border border-dashed border-border/20 px-4 py-5 text-center text-sm text-muted-foreground">
          No Areas yet. An Area is a project-scoped bucket — an outcome, a
          category, or a junk drawer.
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={(e) => void handleDragEnd(e)}
      >
        <SortableContext
          items={displayAreas.map((a) => a.id)}
          strategy={rectSortingStrategy}
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {displayAreas.map((area) => (
              <SortableAreaCard
                key={area.id}
                area={area}
                counts={countsByArea.byArea.get(area.id) ?? { open: 0, done: 0 }}
                onOpen={() => setDetailId(area.id)}
              />
            ))}
            {/* Uncategorized: always last, visually distinct, not draggable */}
            <UncategorizedCard
              counts={countsByArea.uncaptured}
              onOpen={() => setShowUncategorized(true)}
            />
          </div>
        </SortableContext>

        {/* Overlay: renders ghost card while dragging */}
        <DragOverlay>
          {draggingArea ? (
            <AreaCardContent
              area={draggingArea}
              counts={countsByArea.byArea.get(draggingArea.id) ?? { open: 0, done: 0 }}
              overlay
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      {detailArea && (
        <AreaDetailModal
          project={project}
          area={detailArea}
          workItems={workItems}
          openCount={countsByArea.byArea.get(detailArea.id)?.open ?? 0}
          doneCount={countsByArea.byArea.get(detailArea.id)?.done ?? 0}
          onClose={() => setDetailId(null)}
          onChanged={refetch}
        />
      )}

      {showUncategorized && (
        <AreaDetailModal
          project={project}
          workItems={workItems}
          openCount={countsByArea.uncaptured.open}
          doneCount={countsByArea.uncaptured.done}
          onClose={() => setShowUncategorized(false)}
          onChanged={refetch}
        />
      )}
    </div>
  );
}

// ── Uncategorized (non-sortable) ─────────────────────────────────────────────

function UncategorizedCard({
  counts,
  onOpen,
}: {
  counts: AreaCounts;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex cursor-pointer flex-col gap-2 border-2 border-dashed border-border bg-card p-3 text-left"
      title="Click to view tasks not assigned to any Area"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-muted-foreground">
          Uncategorized
        </span>
        <span className="shrink-0 border border-border bg-primary/10 px-1.5 py-0.5 text-[10px] text-foreground">
          {counts.open} open
        </span>
        <span className="shrink-0 border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {counts.done} done
        </span>
      </div>
      <p className="text-[12px] italic text-[var(--fg-dim)]">
        Tasks not assigned to any Area.
      </p>
    </button>
  );
}

// ── Card content (shared between sortable and drag-overlay) ──────────────────

function AreaCardContent({
  area,
  counts,
  overlay = false,
}: {
  area: Area;
  counts: AreaCounts;
  overlay?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-2 border-2 border-border bg-card p-3 ${overlay ? 'opacity-80 shadow-lg' : ''}`}
    >
      <div className="flex items-center gap-2">
        {/* Drag handle — grip icon */}
        <span
          className="shrink-0 text-[14px] leading-none text-[rgba(212,166,74,0.85)]"
          title="Drag to reorder"
          aria-hidden="true"
        >
          ⠿
        </span>
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
    </div>
  );
}

// ── Sortable wrapper ──────────────────────────────────────────────────────────

function SortableAreaCard({
  area,
  counts,
  onOpen,
}: {
  area: Area;
  counts: AreaCounts;
  onOpen: () => void;
}) {
  const {
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging: sortableIsDragging,
  } = useSortable({ id: area.id });

  const style: React.CSSProperties = {
    transform: transformToStr(transform),
    transition,
    opacity: sortableIsDragging ? 0.3 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      // Drag anywhere on the card to reorder; a click (no drag) opens it.
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onOpen();
      }}
      className="cursor-grab active:cursor-grabbing"
      title="Drag to reorder · click to open"
    >
      <AreaCardContent area={area} counts={counts} overlay={false} />
    </div>
  );
}
