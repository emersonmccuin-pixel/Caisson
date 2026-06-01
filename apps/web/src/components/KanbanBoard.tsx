// Vendored from emersonmccuin-pixel/project-companion @ 6053ad6 (MIT)
// Source: apps/web/src/components/KanbanBoard.tsx
// Adapted for Caisson:
//  - api calls keyed by projectId (ULID), not slug
//  - live updates via useProjectWs envelope hint, not EventSource
//  - Section 2c: rebuilt card visual (no status chip, glyph + child-count
//    badge), click-to-open WorkItemDetailModal, sortable within-column drag
//    that PATCHes position, cross-column drag that POSTs to /move with version
//    + position, horizontal scroll affordance (fade + chevrons on overflow).

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isAreaChangedLiveEventFrame, isWorkItemChangedLiveEventFrame } from '@pc/contracts';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';

import type { Project, ProjectSettings, Stage } from '@/features/projects/client';
import { settingsApi } from '@/features/settings/client';
import { WorkItemConflictError, workItemsApi, type WorkItem } from '@/features/work-items/client';
import { WORK_ITEM_STATUS_GLYPH } from '@/features/work-items/status';

// Section 27 — local mirror of the server-side resolver in @pc/domain.
// Keeps the web bundle independent of the workspace package.
function resolveCancelledHidden(
  settings: Partial<ProjectSettings> | undefined,
  globalHide: boolean,
): boolean {
  const v = settings?.cancelledVisibility ?? 'use-global';
  if (v === 'force-visible') return false;
  if (v === 'force-hidden') return true;
  return globalHide;
}
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { CreateWorkItemModal } from './work-items/CreateWorkItemModal';
import { WorkItemDetailModal } from './work-items/WorkItemDetailModal';
import { AreaFilterRail } from './work-items/AreaFilterRail';
import { applyFilters } from './work-items/filter-sort';
import { WorkItemsToolbar } from './work-items/WorkItemsToolbar';
import { useWorkItemsView } from '@/store/work-items-view';
import { useProjectAreas } from '@/hooks/use-project-areas';

interface KanbanBoardProps {
  project: Project;
  events: WsEnvelope[];
}

// Built-in work-item type chip. `task` is the default and stays muted; bug /
// feature / spike get color-tinted pills so dogfood bug cards visually pop.
const TYPE_CHIP: Record<
  WorkItem['type'],
  { icon: string; label: string; className: string }
> = {
  task: { icon: '▢', label: 'Task', className: 'border-border text-muted-foreground' },
  bug: { icon: '🐛', label: 'Bug', className: 'border-destructive/40 bg-destructive/15 text-destructive' },
  feature: { icon: '✨', label: 'Feature', className: 'border-success/40 bg-success/15 text-success' },
  spike: { icon: '⚡', label: 'Spike', className: 'border-primary/40 bg-primary/15 text-primary' },
};

interface CreateModalState {
  stageId: string;
}

export function KanbanBoard({ project, events }: KanbanBoardProps) {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [createModal, setCreateModal] = useState<CreateModalState | null>(null);
  // Section 27 — read the global hideCancelledStage flag once on mount.
  // The per-project setting on `project.settings` overrides; the kanban
  // resolves both each render via `resolveCancelledHidden`.
  const [globalHideCancelled, setGlobalHideCancelled] = useState(false);
  useEffect(() => {
    let alive = true;
    void settingsApi.getSettings()
      .then((s) => {
        if (alive) setGlobalHideCancelled(s.hideCancelledStage === true);
      })
      .catch(() => {
        /* default `false` is safe */
      });
    return () => {
      alive = false;
    };
  }, []);
  const showAgentContracts = useWorkItemsView((s) => s.showAgentContracts);
  const showTopLevelOnly = useWorkItemsView((s) => s.showTopLevelOnly);
  const filters = useWorkItemsView((s) => s.filters);
  const areaFilter = useWorkItemsView((s) => s.areaFilter);
  // Slice 010 — Area list for the left rail. Refetch the work-item list on any
  // area frame too, since a deleted Area reassigns its items to Uncaptured
  // WITHOUT per-item work-item.changed facts (carry-forward).
  const { areas } = useProjectAreas(project, events);

  // Section 26.7. Agent-contract work items render only when the toggle is on.
  // Hidden rows still flow through child-count + parent lookups so non-agent
  // children of an agent contract remain visible (rare today; reserved for
  // Section 19's workflow-root-as-work-item).
  const hiddenAgentCount = useMemo(
    () => items.filter((i) => i.isAgentTask).length,
    [items],
  );
  // Section 37.6 — toolbar filters + sort apply on top of the agent-contract
  // visibility toggle. Sort affects within-stage ordering on the board; the
  // explicit `position` still wins for drag-and-drop reorders inside a stage,
  // so the toolbar sort only applies when the user hasn't manually reordered
  // (default 'activity' desc effectively becomes a tiebreaker on equal positions).
  // Kanban honors drag positions inside each column, so toolbar `sort` doesn't
  // apply here — only filters. Table view (37.7) is where sort is load-bearing.
  // Section 38 — "Parent items only" toggle hides child items (parentId != null).
  // Visibility-filtered (agent / top-level / toolbar) but NOT area-filtered —
  // this is the list the rail counts against so each bucket's count reflects
  // the same population the board would show under "All".
  const railItems = useMemo(() => {
    let base = showAgentContracts ? items : items.filter((i) => !i.isAgentTask);
    if (showTopLevelOnly) base = base.filter((i) => i.parentId == null);
    return applyFilters(base, filters);
  }, [items, showAgentContracts, showTopLevelOnly, filters]);

  const visibleItems = useMemo(
    () => applyFilters(railItems, { search: '', types: [], statuses: [], updatedWithin: 'all' }, undefined, areaFilter),
    [railItems, areaFilter],
  );

  const refetch = useCallback(() => {
    workItemsApi.workItems(project.id)
      .then(setItems)
      .catch((e) => setError((e as Error).message));
  }, [project.id]);

  useEffect(() => {
    setItems([]);
    refetch();
  }, [refetch]);

  // UI Spine step 3 — version-aware patch-in-place for work-item-changed
  // envelopes. Patches the known items map without a whole-list refetch;
  // only triggers refetch for new (unknown-id) or deleted items.
  const kanbanLastIdx = useRef(0);
  const kanbanItemsRef = useRef<WorkItem[]>([]);
  // Keep ref in sync with state so the effect below can read current ids.
  kanbanItemsRef.current = items;
  useEffect(() => {
    if (events.length < kanbanLastIdx.current) kanbanLastIdx.current = 0;
    const start = kanbanLastIdx.current;
    kanbanLastIdx.current = events.length;
    if (start >= events.length) return;

    const patches: WorkItem[] = [];
    const removes: string[] = [];

    for (let i = start; i < events.length; i++) {
      const env = events[i];
      // Slice 015b — consume the canonical relay `work-item.changed` frame.
      if (!isWorkItemChangedLiveEventFrame(env)) continue;
      if (env.event.projectId !== project.id) continue;
      const snapshot = env.event.payload.workItem;
      if (!snapshot || snapshot.projectId !== project.id) continue;
      const wi = snapshot as unknown as WorkItem;
      if (wi.deletedAt != null) removes.push(wi.id);
      else patches.push(wi);
    }

    if (patches.length === 0 && removes.length === 0) return;

    // Check for new ids before batching — use the ref so we read current state.
    const knownIds = new Set(kanbanItemsRef.current.map((i) => i.id));
    const hasNew = patches.some((wi) => !knownIds.has(wi.id));

    setItems((prev) => {
      let next = prev;
      for (const wi of patches) {
        const idx = next.findIndex((i) => i.id === wi.id);
        if (idx === -1) {
          next = [...next, wi];
        } else if (wi.version > (next[idx]?.version ?? 0)) {
          next = [...next.slice(0, idx), wi, ...next.slice(idx + 1)];
        }
      }
      for (const id of removes) {
        next = next.filter((i) => i.id !== id);
      }
      return next;
    });

    if (hasNew || removes.length > 0) refetch();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, project.id]);

  // Slice 010 carry-forward — deleting an Area reassigns its items to
  // Uncaptured WITHOUT per-item work-item.changed facts. Refetch the work-item
  // list on a `deleted` area frame so areaId on the affected cards reconciles.
  const areaDeleteLastIdx = useRef(0);
  useEffect(() => {
    if (events.length < areaDeleteLastIdx.current) areaDeleteLastIdx.current = 0;
    const start = areaDeleteLastIdx.current;
    areaDeleteLastIdx.current = events.length;
    if (start >= events.length) return;
    for (let i = start; i < events.length; i++) {
      const env = events[i];
      if (
        isAreaChangedLiveEventFrame(env) &&
        env.event.projectId === project.id &&
        env.event.payload.reason === 'deleted'
      ) {
        refetch();
        break;
      }
    }
  }, [events, project.id, refetch]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  // Section 27 — hide the cancelled-flagged stage when the resolved visibility
  // says so. Cards already living there stay reachable via direct links + via
  // the "Show archived" section in stages editor; this just keeps the column
  // off the board.
  const cancelledHidden = resolveCancelledHidden(project.settings, globalHideCancelled);
  const sortedStages = useMemo(() => {
    const sorted = [...project.stages].sort((a, b) => a.order - b.order);
    return cancelledHidden ? sorted.filter((s) => !s.isCancelled) : sorted;
  }, [project.stages, cancelledHidden]);

  // Pre-sort items by position within each stage. Stable across renders.
  // Uses `visibleItems` so the "See Agent Contracts" toggle (Section 26.7)
  // hides agent-task rows from each column when off.
  const itemsByStage = useMemo(() => {
    const map = new Map<string, WorkItem[]>();
    for (const stage of sortedStages) map.set(stage.id, []);
    for (const item of visibleItems) {
      const bucket = map.get(item.stageId);
      if (bucket) bucket.push(item);
    }
    for (const bucket of map.values()) bucket.sort((a, b) => a.position - b.position);
    return map;
  }, [visibleItems, sortedStages]);

  const childCountByParent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      if (item.parentId) counts.set(item.parentId, (counts.get(item.parentId) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const activeWiId = String(event.active.id);
    const overId = event.over?.id != null ? String(event.over.id) : null;
    if (!overId) return;

    const active = items.find((i) => i.id === activeWiId);
    if (!active) return;

    // Resolve drop target: another card (overId === some item.id) or a column
    // (overId === some stage.id). Stage drop = end of that column.
    const overItem = items.find((i) => i.id === overId);
    const targetStageId = overItem?.stageId ?? overId;
    const targetStage = sortedStages.find((s) => s.id === targetStageId);
    if (!targetStage) return;

    const sameStage = active.stageId === targetStage.id;
    const targetBucket = (itemsByStage.get(targetStage.id) ?? []).filter(
      (i) => i.id !== active.id,
    );
    const overIdx = overItem ? targetBucket.findIndex((i) => i.id === overItem.id) : targetBucket.length;
    if (sameStage && overItem && active.id === overItem.id) return;

    const newPosition = computePosition(targetBucket, overIdx);
    if (newPosition == null) return;
    if (sameStage && Math.abs(active.position - newPosition) < 1e-9) return;

    // Optimistic local reorder; server broadcast will reconcile via refetch.
    setItems((prev) =>
      prev.map((i) =>
        i.id === active.id ? { ...i, stageId: targetStage.id, position: newPosition } : i,
      ),
    );

    try {
      if (sameStage) {
        await workItemsApi.patchWorkItem(project.id, active.id, active.version, {
          position: newPosition,
        });
      } else {
        await workItemsApi.moveWorkItem(project.id, active.id, active.version, {
          stageId: targetStage.id,
          position: newPosition,
        });
      }
    } catch (e) {
      if (e instanceof WorkItemConflictError) {
        setError('This item changed elsewhere — refreshing.');
      } else {
        setError((e as Error).message);
      }
      refetch();
    }
  }

  const draggedItem = activeId ? items.find((i) => i.id === activeId) ?? null : null;
  const openItem = openItemId ? items.find((i) => i.id === openItemId) ?? null : null;

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex h-full">
        <AreaFilterRail areas={areas} items={railItems} />
        <div className="flex min-w-0 flex-1 flex-col">
        <WorkItemsToolbar hiddenAgentCount={hiddenAgentCount} />
        <div className="min-h-0 flex-1">
          <KanbanScrollContainer>
            {sortedStages.map((stage) => (
              <Column
                key={stage.id}
                stage={stage}
                items={itemsByStage.get(stage.id) ?? []}
                childCounts={childCountByParent}
                onItemClick={(id) => setOpenItemId(id)}
                onAddCard={() => setCreateModal({ stageId: stage.id })}
              />
            ))}
          </KanbanScrollContainer>
        </div>
        </div>
      </div>

      <DragOverlay>
        {draggedItem ? (
          <CardSurface
            item={draggedItem}
            childCount={childCountByParent.get(draggedItem.id) ?? 0}
            dragging
          />
        ) : null}
      </DragOverlay>

      {openItem && (
        <WorkItemDetailModal
          workItem={openItem}
          project={project}
          items={items}
          events={events}
          onClose={() => setOpenItemId(null)}
          onSwitchItem={(id) => setOpenItemId(id)}
          onItemCreated={(wi) =>
            setItems((prev) => (prev.some((p) => p.id === wi.id) ? prev : [...prev, wi]))
          }
        />
      )}

      {createModal && (
        <CreateWorkItemModal
          project={project}
          stageId={createModal.stageId}
          onClose={() => setCreateModal(null)}
          onCreated={(wi) =>
            setItems((prev) => (prev.some((p) => p.id === wi.id) ? prev : [...prev, wi]))
          }
        />
      )}

      {error && (
        <div className="fixed bottom-4 right-4 z-50 max-w-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}{' '}
          <button onClick={() => setError(null)} className="ml-2 underline">
            dismiss
          </button>
        </div>
      )}
    </DndContext>
  );
}

/** Compute a new `position` value such that the item lands at `targetIdx` in
 *  `bucket` (bucket excludes the dragged item, sorted ascending by position).
 *  Returns null when bucket is empty AND targetIdx is out of range (defensive
 *  — shouldn't happen). */
function computePosition(bucket: WorkItem[], targetIdx: number): number | null {
  if (bucket.length === 0) return 1;
  const clamped = Math.max(0, Math.min(targetIdx, bucket.length));
  if (clamped === 0) return bucket[0]!.position - 1;
  if (clamped >= bucket.length) return bucket[bucket.length - 1]!.position + 1;
  const prev = bucket[clamped - 1]!.position;
  const next = bucket[clamped]!.position;
  return (prev + next) / 2;
}

/** Horizontal scroll affordance: fade overlays + chevron buttons that appear
 *  when the row overflows. Refs tracked via a scroll/resize listener pair. */
function KanbanScrollContainer({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const overflow = el.scrollWidth > el.clientWidth + 1;
    setCanLeft(overflow && el.scrollLeft > 1);
    setCanRight(overflow && el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useLayoutEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    el.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      ro.disconnect();
    };
  }, [measure]);

  // Re-measure when children change (stages added / removed).
  useLayoutEffect(() => {
    measure();
  });

  function scrollByPage(direction: -1 | 1) {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: 'smooth' });
  }

  return (
    <div className="group relative h-full">
      <div
        ref={ref}
        className="flex h-full min-h-0 gap-4 overflow-x-auto overflow-y-hidden p-4 [scrollbar-gutter:stable]"
      >
        {children}
      </div>

      {/* Left fade + chevron */}
      <div
        aria-hidden
        className={
          'pointer-events-none absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-background to-transparent transition-opacity ' +
          (canLeft ? 'opacity-100' : 'opacity-0')
        }
      />
      {canLeft && (
        <button
          type="button"
          onClick={() => scrollByPage(-1)}
          aria-label="Scroll columns left"
          className="absolute left-2 top-1/2 z-10 -translate-y-1/2 border border-border bg-background/90 px-2 py-1 text-sm opacity-0 shadow-sm transition-opacity hover:bg-muted group-hover:opacity-100"
        >
          ‹
        </button>
      )}

      {/* Right fade + chevron */}
      <div
        aria-hidden
        className={
          'pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-background to-transparent transition-opacity ' +
          (canRight ? 'opacity-100' : 'opacity-0')
        }
      />
      {canRight && (
        <button
          type="button"
          onClick={() => scrollByPage(1)}
          aria-label="Scroll columns right"
          className="absolute right-2 top-1/2 z-10 -translate-y-1/2 border border-border bg-background/90 px-2 py-1 text-sm opacity-0 shadow-sm transition-opacity hover:bg-muted group-hover:opacity-100"
        >
          ›
        </button>
      )}
    </div>
  );
}

function Column({
  stage,
  items,
  childCounts,
  onItemClick,
  onAddCard,
}: {
  stage: Stage;
  items: WorkItem[];
  childCounts: Map<string, number>;
  onItemClick: (id: string) => void;
  onAddCard: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const ids = useMemo(() => items.map((i) => i.id), [items]);

  return (
    <div
      ref={setNodeRef}
      data-stage-id={stage.id}
      className={
        'flex h-full min-h-0 min-w-[14rem] flex-1 basis-0 flex-col overflow-hidden border bg-card p-3 transition-colors ' +
        (isOver ? 'border-primary' : 'border-border')
      }
    >
      <div className="mb-2 flex shrink-0 items-center justify-between text-xs font-semibold uppercase tracking-wider text-foreground">
        <span className="flex items-center gap-1.5">
          <span>{stage.name}</span>
          {/* Section 27 — small flag badge so the user can see which column
              carries which role without opening project settings. */}
          {stage.isNew && <StageFlagBadge label="New" tone="primary" glyph="✱" />}
          {stage.isDone && <StageFlagBadge label="Done" tone="success" glyph="✓" />}
          {stage.isCancelled && (
            <StageFlagBadge label="Cancelled" tone="muted" glyph="✗" />
          )}
        </span>
        <span className="text-xs font-normal text-muted-foreground">{items.length}</span>
      </div>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
          <div className="flex flex-col gap-2">
            {items.map((item) => (
              <SortableCard
                key={item.id}
                item={item}
                childCount={childCounts.get(item.id) ?? 0}
                onClick={() => onItemClick(item.id)}
              />
            ))}
          </div>
        </div>
      </SortableContext>
      <button
        onClick={onAddCard}
        className="mt-2 shrink-0 px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        + Add card
      </button>
    </div>
  );
}

// Section 27 — small badge rendered next to flag-bearing column titles.
function StageFlagBadge({
  label,
  tone,
  glyph,
}: {
  label: string;
  tone: 'primary' | 'success' | 'muted';
  glyph: string;
}) {
  const toneClass =
    tone === 'success'
      ? 'border-success/40 bg-success/15 text-success'
      : tone === 'primary'
        ? 'border-primary/40 bg-primary/15 text-primary'
        : 'border-border bg-muted text-muted-foreground';
  return (
    <span
      className={`inline-flex items-center gap-0.5 border px-1 py-px text-[9px] font-medium normal-case tracking-wide ${toneClass}`}
      title={`This stage is the project's "${label}" stage.`}
    >
      <span aria-hidden>{glyph}</span>
      <span>{label}</span>
    </span>
  );
}

function SortableCard({
  item,
  childCount,
  onClick,
}: {
  item: WorkItem;
  childCount: number;
  onClick: () => void;
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: item.id,
  });
  const style = {
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
      : undefined,
    transition,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      onClick={onClick}
      className={
        'cursor-grab select-none border border-border bg-background p-2 text-sm text-foreground hover:border-primary/60 ' +
        (isDragging ? 'opacity-30' : '')
      }
    >
      <CardContent item={item} childCount={childCount} />
    </div>
  );
}

/** Visual-only card body — shared between the live sortable card and the
 *  DragOverlay clone. */
function CardSurface({
  item,
  childCount,
  dragging,
}: {
  item: WorkItem;
  childCount: number;
  dragging?: boolean;
}) {
  return (
    <div
      className={
        'cursor-grabbing select-none border border-primary bg-background p-2 text-sm text-foreground shadow-md ' +
        (dragging ? '' : '')
      }
    >
      <CardContent item={item} childCount={childCount} />
    </div>
  );
}

function CardContent({ item, childCount }: { item: WorkItem; childCount: number }) {
  const status = item.status ?? 'pending';
  const glyph =
    status === 'pending' || status === 'complete' ? null : WORK_ITEM_STATUS_GLYPH[status];
  const typeChip = TYPE_CHIP[item.type ?? 'task'];
  return (
    <div className="flex flex-col gap-0.5">
      {/* Section 35 — uppercase callsign label sits above the title; agent
          contracts render no label since they don't have a callsign. */}
      {item.callsign && (
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {item.callsign}
        </span>
      )}
      <div className="flex items-start gap-2">
        <span className="line-clamp-2 min-w-0 flex-1 break-words">{item.title}</span>
        <div className="flex shrink-0 items-center gap-1">
          {item.type && item.type !== 'task' && (
            <span
              className={'border px-1 text-[10px] leading-tight ' + typeChip.className}
              title={typeChip.label}
              aria-label={typeChip.label}
            >
              <span aria-hidden="true">{typeChip.icon}</span> {typeChip.label}
            </span>
          )}
          {childCount > 0 && (
            <span
              className="border border-border px-1 text-[10px] text-muted-foreground"
              title={`${childCount} child${childCount === 1 ? '' : 'ren'}`}
            >
              ↳ {childCount}
            </span>
          )}
          {glyph && (
            <span
              className={'text-sm leading-none ' + glyph.className}
              title={item.statusReason ?? status}
              aria-label={status}
            >
              {glyph.glyph}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
