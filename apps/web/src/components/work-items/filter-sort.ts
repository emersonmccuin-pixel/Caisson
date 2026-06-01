// Section 37.5 — pure helpers that apply WorkItemsFilters + WorkItemsSort
// to a flat array of WorkItem. Kanban (37.6) + Table (37.7) both consume.
// Filtering is client-side for v1; if a project ever has 1000s of items this
// gets revisited.

import type { WorkItem } from '@/features/work-items/client';
import type {
  AreaFilter,
  SortBy,
  SortDir,
  UpdatedWindow,
  WorkItemsFilters,
  WorkItemsSort,
} from '@/store/work-items-view';

const MS_PER_DAY = 86_400_000;

function windowStartMs(window: UpdatedWindow, now: number): number | null {
  switch (window) {
    case 'all':
      return null;
    case 'today': {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    case 'week':
      return now - 7 * MS_PER_DAY;
    case 'month':
      return now - 30 * MS_PER_DAY;
  }
}

export function applyFilters(
  items: WorkItem[],
  filters: WorkItemsFilters,
  now: number = Date.now(),
  areaFilter: AreaFilter = null,
): WorkItem[] {
  const search = filters.search.trim().toLowerCase();
  const since = windowStartMs(filters.updatedWithin, now);
  return items.filter((wi) => {
    if (search) {
      const hay = `${wi.title}\n${wi.body}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    if (filters.types.length > 0 && !filters.types.includes(wi.type)) return false;
    if (filters.statuses.length > 0 && !filters.statuses.includes(wi.status)) return false;
    if (since !== null && wi.updatedAt < since) return false;
    if (!matchesAreaFilter(wi, areaFilter)) return false;
    return true;
  });
}

/** Slice 010 — left-rail Area filter. `null` = All (pass), 'uncaptured' =
 *  areaId == null, otherwise an Area id that must match `wi.areaId`. */
export function matchesAreaFilter(wi: WorkItem, areaFilter: AreaFilter): boolean {
  if (areaFilter == null) return true;
  if (areaFilter === 'uncaptured') return wi.areaId == null;
  return wi.areaId === areaFilter;
}

export function applySort(items: WorkItem[], sort: WorkItemsSort): WorkItem[] {
  const arr = items.slice();
  arr.sort((a, b) => cmp(a, b, sort.by, sort.dir));
  return arr;
}

function cmp(a: WorkItem, b: WorkItem, by: SortBy, dir: SortDir): number {
  const sign = dir === 'asc' ? 1 : -1;
  switch (by) {
    case 'activity':
      return sign * (a.updatedAt - b.updatedAt);
    case 'created':
      return sign * (a.createdAt - b.createdAt);
    case 'alpha':
      return sign * a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  }
}

export function applyFiltersAndSort(
  items: WorkItem[],
  filters: WorkItemsFilters,
  sort: WorkItemsSort,
  now: number = Date.now(),
  areaFilter: AreaFilter = null,
): WorkItem[] {
  return applySort(applyFilters(items, filters, now, areaFilter), sort);
}
