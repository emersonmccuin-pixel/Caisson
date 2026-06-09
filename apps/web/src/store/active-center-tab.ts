// App-global active center tab. Switching projects keeps you on whichever
// tab you were last on (5+P.A). Replaces the prior per-project tab map.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { TABS, type Tab } from '@/components/Tabs';

interface ActiveCenterTabState {
  tab: Tab;
  setTab: (tab: Tab) => void;
}

/** Coerce a persisted tab that's no longer in the nav (e.g. a hidden tab like
 *  'patterns') back to a safe default, so a stale localStorage value can't
 *  leave the user on a blank body. */
function safeTab(t: unknown): Tab {
  return t === 'project-settings' || (TABS as readonly string[]).includes(t as string)
    ? (t as Tab)
    : 'work-items';
}

export const useActiveCenterTab = create<ActiveCenterTabState>()(
  persist(
    (set) => ({
      tab: 'work-items',
      setTab: (tab) => set({ tab: safeTab(tab) }),
    }),
    {
      name: 'pc.center-tab',
      onRehydrateStorage: () => (state) => {
        if (state) state.tab = safeTab(state.tab);
      },
    },
  ),
);
