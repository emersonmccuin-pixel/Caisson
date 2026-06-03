// Work-items view preferences.
//
// Slice 022 (contract-first switchover): the "See Agent Contracts" toggle is
// gone — agent tasks are no longer hidden work items. Contracts are a
// first-class entity surfaced via the contract views (work-log + the
// project-scoped contract list), so the board never renders them.
//
// Section 37: extended with `activeSubTab` for the Dashboard / Kanban / Table
// sub-tab strip above the Work Items page. Default = 'dashboard'.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { WorkItemStatus, WorkItemType } from '@/features/work-items/client';

// FD-19 — the first sub-tab is labelled "Areas" in the UI (Area cards);
// the internal key stays 'dashboard' so persisted view state migrates cleanly.
export type WorkItemsSubTab = 'dashboard' | 'kanban' | 'table';

// Slice 010 — left-rail Area filter applied to Kanban + Table. `null` = All
// (no filter), 'uncaptured' = items with areaId == null, otherwise an Area id.
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
  /** Section 38 — "Parent items only" toggle. When true, both kanban and table
   *  only render items where parentId == null (top-level items). Default off. */
  showTopLevelOnly: boolean;
  setShowTopLevelOnly: (value: boolean) => void;
  activeSubTab: WorkItemsSubTab;
  setActiveSubTab: (tab: WorkItemsSubTab) => void;
  /** Slice 010 — single-select left-rail Area filter for Kanban + Table. */
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
      activeSubTab: 'dashboard',
      setActiveSubTab: (activeSubTab) => set({ activeSubTab }),
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
