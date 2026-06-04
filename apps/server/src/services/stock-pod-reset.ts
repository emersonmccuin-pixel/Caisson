// Section 17d.f.5 — Reset a stock pod to its seeded canonical content.
//
// Stock pods are seeded at boot (orchestrator via orchestrator-pod-seed.ts;
// the six specialists via stock-pod-seed.ts). After the user edits one via
// Global Settings → Specialists (danger-zone), they need a way back to the
// original. This module collects the canonical CreateAgentInputs into a
// single lookup keyed by name, exposes a `resetStockPodToDefault(name)`
// helper, and the route layer drives it through `updateAgent` so the audit
// log captures the reset.

import { type CreateAgentInput, type UpdateAgentInput, getAgentByName, updateAgent } from '@pc/db';
import type { PodAgentRow } from '@pc/domain';

import { ORCHESTRATOR_POD_CONTENT } from './orchestrator-pod-content.ts';
import { STOCK_POD_CONTENT } from './stock-pod-seed.ts';

/** Lookup: stock pod name → its canonical seed content. */
const CANONICAL_BY_NAME: ReadonlyMap<string, CreateAgentInput> = new Map([
  [ORCHESTRATOR_POD_CONTENT.name, ORCHESTRATOR_POD_CONTENT],
  ...STOCK_POD_CONTENT.map((c) => [c.name, c] as const),
]);

export function getStockPodCanonical(name: string): CreateAgentInput | null {
  return CANONICAL_BY_NAME.get(name) ?? null;
}

export interface ResetStockPodResult {
  /** Post-reset row. Null if the live pod doesn't exist. */
  agent: PodAgentRow | null;
  /** Field names that diverged from canonical and were reset. Empty when the
   *  live row already matched. */
  resetFields: string[];
  /** Reason routed to the audit log. */
  reason: string;
}

/** Reset the live stock pod's scalar fields to the canonical seed content.
 *  Only fields that diverge are written (so the audit log doesn't bloat with
 *  no-op rows). Knowledge / secrets / mcp servers are untouched — they're
 *  user-owned even on a stock pod.
 *
 *  Returns null result.agent when the named pod doesn't exist or isn't a
 *  recognised stock pod. */
export function resetStockPodToDefault(name: string, reason: string): ResetStockPodResult {
  const canonical = getStockPodCanonical(name);
  if (!canonical) {
    return { agent: null, resetFields: [], reason };
  }
  const live = getAgentByName({ name, scope: 'global' });
  if (!live) {
    return { agent: null, resetFields: [], reason };
  }
  const resetFields: string[] = [];
  const patch: UpdateAgentInput = {};
  const canon = canonical as unknown as Record<string, unknown>;
  const liveAny = live as unknown as Record<string, unknown>;
  const SCALARS: ReadonlyArray<keyof UpdateAgentInput> = [
    'prompt',
    'tools',
    'model',
    'effort',
    'maxTurns',
    'description',
  ];
  for (const f of SCALARS) {
    const cv = canon[f];
    const lv = liveAny[f];
    if (JSON.stringify(cv) !== JSON.stringify(lv)) {
      (patch as Record<string, unknown>)[f] = cv;
      resetFields.push(String(f));
    }
  }
  if (resetFields.length === 0) {
    return { agent: live, resetFields: [], reason };
  }
  const updated = updateAgent(live.id, patch, {
    actor: 'user',
    reason,
  });
  return { agent: updated, resetFields, reason };
}
