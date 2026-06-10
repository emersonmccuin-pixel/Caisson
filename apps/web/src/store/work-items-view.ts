// Work-items view preferences.
//
// Slice 022 (contract-first switchover): the "See Agent Contracts" toggle is
// gone — agent tasks are no longer hidden work items. Contracts are a
// first-class entity surfaced via the contract views (work-log + the
// project-scoped contract list), so the board never renders them.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { WorkItemStatus, WorkItemType } from '@/features/work-items/client';

// Slice 010 — Area filter for the Work page. `null` = All (no filter),
// 'uncaptured' = items with areaId == null, otherwise an Area id.
export type AreaFilter = string | null | 'uncaptured';

export type UpdatedWindow = 'all' | 'today' | 'week' | 'month';
export type SortBy = 'activity' | 'created' | 'alpha';
export type SortDir = 'asc' | 'desc';

export interface WorkItemsFilters {
  search: string;
  types: WorkItemType[];      // empty = all
  statuses: WorkItemStatus[]; // empty = all
  updatedWithin: UpdatedWindow;
}

export interface WorkItemsSort {
  by: SortBy;
  dir: SortDir;
}

const DEFAULT_FILTERS: WorkItemsFilters = {
  search: '',
  types: [],
  statuses: [],
  updatedWithin: 'all',
};

const DEFAULT_SORT: WorkItemsSort = { by: 'activity', dir: 'desc' };

interface WorkItemsViewState {
  /** "Parent items only" toggle (kept for potential future surfaces). */
  showTopLevelOnly: boolean;
  setShowTopLevelOnly: (value: boolean) => void;
  /** Top-level Work tab view: Areas grid, Focus tree, or Tasks (table/kanban). Default: areas. */
  workView: 'areas' | 'tasks' | 'focus';
  setWorkView: (view: 'areas' | 'tasks' | 'focus') => void;
  /** Within Tasks: active surface. Default: table. */
  taskView: 'table' | 'kanban';
  setTaskView: (view: 'table' | 'kanban') => void;
  /** Slice 010 — Area filter for the Work page. */
  areaFilter: AreaFilter;
  setAreaFilter: (filter: AreaFilter) => void;
  filters: WorkItemsFilters;
  setFilters: (patch: Partial<WorkItemsFilters>) => void;
  clearFilters: () => void;
  sort: WorkItemsSort;
  setSort: (sort: WorkItemsSort) => void;
}

export const useWorkItemsView = create<WorkItemsViewState>()(
  persist(
    (set, get) => ({
      showTopLevelOnly: false,
      setShowTopLevelOnly: (showTopLevelOnly) => set({ showTopLevelOnly }),
      workView: 'areas',
      setWorkView: (workView) => set({ workView }),
      taskView: 'table',
      setTaskView: (taskView) => set({ taskView }),
      areaFilter: null,
      setAreaFilter: (areaFilter) => set({ areaFilter }),
      filters: DEFAULT_FILTERS,
      setFilters: (patch) => set({ filters: { ...get().filters, ...patch } }),
      clearFilters: () => set({ filters: DEFAULT_FILTERS }),
      sort: DEFAULT_SORT,
      setSort: (sort) => set({ sort }),
    }),
    { name: 'pc.work-items-view' },
  ),
);

/** Pure helper — true when any non-default filter is active. */
export function hasActiveFilters(f: WorkItemsFilters): boolean {
  return (
    f.search.trim().length > 0 ||
    f.types.length > 0 ||
    f.statuses.length > 0 ||
    f.updatedWithin !== 'all'
  );
}
