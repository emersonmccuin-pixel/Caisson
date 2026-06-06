// Slice 2 — global quick-add store.
// Any component can call `open(areaId?, areaName?)` to open the quick-add.
// If `areaId` is supplied, the task defaults to that area; otherwise defaults
// to Uncaptured (null areaId). The popover closes via `close()`.

import { create } from 'zustand';

import type { ULID } from '@/features/projects/types';

interface GlobalQuickAddStore {
  isOpen: boolean;
  /** Pre-filled area ID; null = Uncaptured. */
  prefillAreaId: ULID | null;
  /** Display name for the prefill area (shown in the modal label). */
  prefillAreaName: string | null;
  open: (areaId?: ULID | null, areaName?: string | null) => void;
  close: () => void;
}

export const useGlobalQuickAdd = create<GlobalQuickAddStore>((set) => ({
  isOpen: false,
  prefillAreaId: null,
  prefillAreaName: null,
  open: (areaId = null, areaName = null) =>
    set({ isOpen: true, prefillAreaId: areaId ?? null, prefillAreaName: areaName ?? null }),
  close: () => set({ isOpen: false, prefillAreaId: null, prefillAreaName: null }),
}));
