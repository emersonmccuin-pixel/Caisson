// Work-items view preferences. Section 26.7: "See Agent Contracts" toggle
// that hides `isAgentTask` rows from the kanban (and the table view).
// Flipped to OFF in Section 1.5.10 — agent work items now surface in chat
// as rich-link pills (hover preview + click to modal), so kanban no longer
// needs to render them by default. User can re-enable via the toolbar
// toggle if they want to see the full picture.
//
// Section 37: extended with `activeSubTab` for the Dashboard / Kanban / Table
// sub-tab strip above the Work Items page. Default = 'dashboard'.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { WorkItemStatus, WorkItemType } from '@/features/work-items/client';

// Slice 010 — the first sub-tab is labelled "Focus" in the UI (Area cards);
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
  showAgentContracts: boolean;
  setShowAgentContracts: (value: boolean) => void;
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
      showAgentContracts: false,
      setShowAgentContracts: (showAgentContracts) => set({ showAgentContracts }),
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
