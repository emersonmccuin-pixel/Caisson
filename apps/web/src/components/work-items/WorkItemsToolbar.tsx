// Section 37.5 — shared filter/search/sort toolbar for Kanban (37.6) +
// Table (37.7). Pure UI; state lives in useWorkItemsView. Filters apply
// client-side downstream where the list is rendered.
//
// v1 chips (only those backed by real data):
//   Search · Type · Status · Updated · Sort · Clear all
// Deferred until backing data exists:
//   Initiative (needs 37.2 initiative-list endpoint)
//   Assignee (needs an assignment query)
//   Tag (needs a tags column on work_items)

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { WORK_ITEM_TYPES, type WorkItemStatus, type WorkItemType } from '@/features/work-items/client';
import { WORK_ITEM_STATUS_FILTER_OPTIONS } from '@/features/work-items/status';
import {
  hasActiveFilters,
  useWorkItemsView,
  type SortBy,
  type SortDir,
  type UpdatedWindow,
} from '@/store/work-items-view';

const UPDATED_OPTIONS: { value: UpdatedWindow; label: string }[] = [
  { value: 'all', label: 'Any time' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
];

const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: 'activity', label: 'Recent activity' },
  { value: 'created', label: 'Created' },
  { value: 'alpha', label: 'Alphabetical' },
];

export interface WorkItemsToolbarProps {
  /** Optional trailing action (e.g. + Add task). Rendered after the sort dropdown. */
  rightSlot?: ReactNode;
  /** Hide individual chips when a view doesn't benefit. */
  hide?: {
    status?: boolean;
    type?: boolean;
    updated?: boolean;
  };
}

export function WorkItemsToolbar({ rightSlot, hide }: WorkItemsToolbarProps) {
  const filters = useWorkItemsView((s) => s.filters);
  const setFilters = useWorkItemsView((s) => s.setFilters);
  const clearFilters = useWorkItemsView((s) => s.clearFilters);
  const sort = useWorkItemsView((s) => s.sort);
  const setSort = useWorkItemsView((s) => s.setSort);
  const showTopLevelOnly = useWorkItemsView((s) => s.showTopLevelOnly);
  const setShowTopLevelOnly = useWorkItemsView((s) => s.setShowTopLevelOnly);
  const active = hasActiveFilters(filters);

  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b border-border/30 bg-[var(--surface-1)] px-5"
      style={{ minHeight: 44, paddingTop: 6, paddingBottom: 6 }}
    >
      <SearchInput
        value={filters.search}
        onChange={(search) => setFilters({ search })}
      />

      {!hide?.type && (
        <FilterChip
          label="Type"
          activeCount={filters.types.length}
          activeLabel={filters.types.length === 1 ? labelType(filters.types[0]!) : null}
        >
          <CheckList
            options={WORK_ITEM_TYPES.map((v) => ({ value: v, label: labelType(v) }))}
            selected={filters.types}
            onChange={(types) => setFilters({ types: types as WorkItemType[] })}
          />
        </FilterChip>
      )}

      {!hide?.status && (
        <FilterChip
          label="Status"
          activeCount={filters.statuses.length}
          activeLabel={
            filters.statuses.length === 1
              ? WORK_ITEM_STATUS_FILTER_OPTIONS.find((o) => o.value === filters.statuses[0])?.label ?? null
              : null
          }
        >
          <CheckList
            options={WORK_ITEM_STATUS_FILTER_OPTIONS}
            selected={filters.statuses}
            onChange={(statuses) =>
              setFilters({ statuses: statuses as WorkItemStatus[] })
            }
          />
        </FilterChip>
      )}

      {!hide?.updated && (
        <FilterChip
          label="Updated"
          activeCount={filters.updatedWithin === 'all' ? 0 : 1}
          activeLabel={
            filters.updatedWithin === 'all'
              ? null
              : UPDATED_OPTIONS.find((o) => o.value === filters.updatedWithin)?.label ??
                null
          }
        >
          <RadioList
            options={UPDATED_OPTIONS}
            selected={filters.updatedWithin}
            onChange={(updatedWithin) =>
              setFilters({ updatedWithin: updatedWithin as UpdatedWindow })
            }
          />
        </FilterChip>
      )}

      {active && (
        <button
          type="button"
          onClick={clearFilters}
          className="text-[11px] uppercase tracking-[0.06em] text-destructive hover:text-foreground"
        >
          Clear all
        </button>
      )}

      <div className="flex-1" />

      <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground">
        <input
          type="checkbox"
          checked={showTopLevelOnly}
          onChange={(e) => setShowTopLevelOnly(e.target.checked)}
          className="h-3 w-3 cursor-pointer accent-primary"
        />
        <span>Parent items only</span>
      </label>

      <SortSelect
        value={sort.by}
        dir={sort.dir}
        onChange={(by, dir) => setSort({ by, dir })}
      />

      {rightSlot}
    </div>
  );
}

function SearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="relative">
      <input
        type="text"
        placeholder="Search…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-56 px-2.5 py-1 text-[12px]"
        style={{ paddingRight: value ? 22 : undefined }}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange('')}
          className="absolute right-1 top-1/2 -translate-y-1/2 px-1 text-[12px] text-muted-foreground hover:text-foreground"
        >
          ×
        </button>
      )}
    </div>
  );
}

function FilterChip({
  label,
  activeCount,
  activeLabel,
  children,
}: {
  label: string;
  activeCount: number;
  activeLabel: string | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const isActive = activeCount > 0;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={(e) => {
          // Stop the same-tick mousedown from closing the menu we're opening.
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] tracking-[0.04em] ${
          isActive
            ? 'border border-primary bg-primary/10 text-primary'
            : 'border border-border/40 text-muted-foreground hover:border-border hover:text-accent'
        }`}
        aria-expanded={open}
      >
        <span>{label}</span>
        {isActive && (
          <span className="text-accent">
            {activeLabel ?? `${activeCount}`}
          </span>
        )}
        <span className="text-[9px] text-[var(--fg-dim)]">▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 z-40 mt-1 min-w-[180px] border border-primary/40 bg-popover py-1 shadow-2xl"
        >
          {children}
        </div>
      )}
    </div>
  );
}

function CheckList({
  options,
  selected,
  onChange,
}: {
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  function toggle(v: string) {
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  }
  return (
    <div className="flex flex-col">
      {options.map((o) => {
        const isOn = selected.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            role="menuitemcheckbox"
            aria-checked={isOn}
            onClick={() => toggle(o.value)}
            className={`flex items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-muted ${
              isOn ? 'text-primary' : 'text-foreground'
            }`}
          >
            <span className="inline-block w-3 text-center">{isOn ? '✓' : ''}</span>
            <span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function RadioList({
  options,
  selected,
  onChange,
}: {
  options: { value: string; label: string }[];
  selected: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className="flex flex-col">
      {options.map((o) => {
        const isOn = selected === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="menuitemradio"
            aria-checked={isOn}
            onClick={() => onChange(o.value)}
            className={`flex items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-muted ${
              isOn ? 'text-primary' : 'text-foreground'
            }`}
          >
            <span className="inline-block w-3 text-center">{isOn ? '●' : '○'}</span>
            <span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function SortSelect({
  value,
  dir,
  onChange,
}: {
  value: SortBy;
  dir: SortDir;
  onChange: (by: SortBy, dir: SortDir) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] uppercase tracking-[0.06em] text-[var(--fg-dim)]">
        sort
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as SortBy, dir)}
        className="text-[11px]"
        style={{ padding: '3px 6px' }}
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => onChange(value, dir === 'asc' ? 'desc' : 'asc')}
        title={dir === 'asc' ? 'Ascending' : 'Descending'}
        className="border border-border/40 px-1.5 text-[11px] text-muted-foreground hover:text-accent"
      >
        {dir === 'asc' ? '↑' : '↓'}
      </button>
    </div>
  );
}

function labelType(t: WorkItemType): string {
  switch (t) {
    case 'task':
      return 'Task';
    case 'bug':
      return 'Bug';
    case 'feature':
      return 'Feature';
    case 'spike':
      return 'Spike';
    case 'investigation':
      return 'Investigation';
  }
}
