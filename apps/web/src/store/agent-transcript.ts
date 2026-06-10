// Section 28.5 — modal-mount state for the agent-run transcript modal.
//
// Mirror of useWorkflowDrawer: one mount lives at Shell level (so any tab
// can open it without being structurally inside ActivityPanel), state lives
// in zustand, every consumer (chat bubble, activity panel) writes to the
// same store.
//
// `preloadedRun` carries the full AgentRunRecord when the caller already has it
// (e.g. CommandActivityPanel's cross-project agent list). AgentTranscriptModalMount
// falls back to it when the run isn't found in the active project's data — this is
// what makes cross-project transcript opens work in Command (pc-pty-chat-365).

import { create } from 'zustand';

import type { AgentRunRecord } from '@/features/agent-runs/types';

interface AgentTranscriptState {
  runId: string | null;
  /** Full run snapshot provided by the opener — used as a fallback when the
   *  run cannot be resolved from the active project's live data (cross-project
   *  opens from Command). Cleared on close. */
  preloadedRun: AgentRunRecord | null;
  open: (runId: string, run?: AgentRunRecord) => void;
  close: () => void;
}

export const useAgentTranscript = create<AgentTranscriptState>((set) => ({
  runId: null,
  preloadedRun: null,
  open: (runId, run) => set({ runId, preloadedRun: run ?? null }),
  close: () => set({ runId: null, preloadedRun: null }),
}));
