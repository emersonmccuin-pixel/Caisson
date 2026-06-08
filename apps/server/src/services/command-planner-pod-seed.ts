// Idempotent boot-time seed for the global Command planner pod. Thin wrapper
// around seedPodWithDriftReseed (same helper the orchestrator + stock pods
// use). Mirrors orchestrator-pod-seed.ts — the planner is Command's chat, so
// it seeds separately from the worker specialist pods.

import { COMMAND_PLANNER_POD_CONTENT } from './command-planner-pod-content.ts';
import { seedPodWithDriftReseed, type SeedPodAction } from './pod-seed-with-drift.ts';

export interface SeedCommandPlannerPodResult {
  seeded: boolean;
  action: SeedPodAction;
  agentId: string;
  reseededFields: string[];
}

/** Idempotently ensure the global Command planner pod row exists + matches the
 *  current COMMAND_PLANNER_POD_CONTENT. Safe to call multiple times. */
export function seedCommandPlannerPodIfMissing(): SeedCommandPlannerPodResult {
  const result = seedPodWithDriftReseed(COMMAND_PLANNER_POD_CONTENT, { reasonTag: 'command-3' });
  return {
    seeded: result.action === 'inserted',
    action: result.action,
    agentId: result.agentId,
    reseededFields: result.reseededFields,
  };
}
