// Signal store — lets App.tsx tell the QuickTasksPanel to expand + focus its
// inline input when the user clicks "+Task" while on the Command page.
// `lastFiredAt` is a Date.now() timestamp; incrementing it is the signal.

import { create } from 'zustand';

interface CommandTaskFocusStore {
  lastFiredAt: number;
  fire: () => void;
}

export const useCommandTaskFocus = create<CommandTaskFocusStore>((set) => ({
  lastFiredAt: 0,
  fire: () => set({ lastFiredAt: Date.now() }),
}));
