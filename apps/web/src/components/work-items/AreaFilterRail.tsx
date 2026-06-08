// Slice 010 — left-panel Area filter rail for Kanban + Table. Single-select:
// All · each Area (by sortOrder) · Uncaptured, each with a live count of
// matching work items. Distinct from the top toolbar chips — this is an
// altitude/navigation element (the human's "big stuff" view), styled to match
// the app (monospace, border, muted text).

import { useMemo } from 'react';

import type { Area } from '@/features/areas/client';
import type { WorkItem } from '@/features/work-items/client';
import { useWorkItemsView, type AreaFilter } from '@/store/work-items-view';

interface Props {
  areas: Area[];
  /** The full (visibility-filtered but NOT area-filtered) work-item list used
   *  to compute per-bucket counts. */
  items: WorkItem[];
}

export function AreaFilterRail({ areas, items }: Props) {
  const areaFilter = useWorkItemsView((s) => s.areaFilter);
  const setAreaFilter = useWorkItemsView((s) => s.setAreaFilter);

  const sortedAreas = useMemo(
    () => [...areas].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [areas],
  );

  const { byArea, uncaptured, total } = useMemo(() => {
    const counts = new Map<string, number>();
    let uncap = 0;
    for (const wi of items) {
      if (wi.areaId == null) uncap += 1;
      else counts.set(wi.areaId, (counts.get(wi.areaId) ?? 0) + 1);
    }
    return { byArea: counts, uncaptured: uncap, total: items.length };
  }, [items]);

  return (
    <div className="flex h-full w-48 shrink-0 flex-col overflow-y-auto border-r border-border/30 bg-[var(--surface-1)] py-2">
      <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--fg-dim)]">
        Areas
      </div>
      <RailRow
        label="All"
        count={total}
        active={areaFilter == null}
        onClick={() => setAreaFilter(null)}
      />
      {sortedAreas.map((area) => (
        <RailRow
          key={area.id}
          label={area.name}
          count={byArea.get(area.id) ?? 0}
          active={areaFilter === area.id}
          onClick={() => setAreaFilter(area.id)}
        />
      ))}
      <RailRow
        label="Uncaptured"
        count={uncaptured}
        active={areaFilter === 'uncaptured'}
        onClick={() => setAreaFilter('uncaptured' as AreaFilter)}
        muted
      />
    </div>
  );
}

function RailRow({
  label,
  count,
  active,
  onClick,
  muted,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px] transition-colors ${
        active
          ? 'bg-primary/10 text-primary'
          : muted
            ? 'text-[var(--fg-dim)] hover:bg-muted/40 hover:text-foreground'
            : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground'
      }`}
      style={{
        borderLeft: `2px solid ${active ? 'var(--primary)' : 'transparent'}`,
      }}
    >
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-[var(--fg-dim)]">{count}</span>
    </button>
  );
}
