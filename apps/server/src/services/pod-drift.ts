// Section 36+ — Drift detection for stock pods.
//
// Wraps `collectDriftedFields` (the same diff logic the boot-time
// seedPodWithDriftReseed uses) with a stock-roster lookup, so route handlers
// can answer "is this stock pod customised, and on which fields?" without
// re-running the drift assertion.
//
// Two surfaces consume this:
//   - GET /api/agents/pods       — augments each row with `driftedFields`
//     so the Agents tab can show a "Customized" pill on stock rows.
//   - POST /api/agents/pods/reset-all-stock-to-default — walks the roster,
//     resets each drifted pod via the existing per-pod helper.
//
// Lives in apps/server (not @pc/runtime) because the canonical content
// constants (STOCK_POD_CONTENT + ORCHESTRATOR_POD_CONTENT) are server-side
// modules with prompt-text imports.

import type { CreateAgentInput } from '@pc/db';
import type { PodAgentRow } from '@pc/domain';
import { ORCHESTRATOR_POD_CONTENT } from './orchestrator-pod-content.ts';
import { COMMAND_PLANNER_POD_CONTENT } from './command-planner-pod-content.ts';
import { collectDriftedFields } from './pod-seed-with-drift.ts';
import { STOCK_POD_CONTENT } from './stock-pod-seed.ts';

/** Build a name → canonical-content map covering every stock pod the server
 *  ships. Memoised on first call. */
let canonicalByName: Map<string, CreateAgentInput> | null = null;
function getCanonicalContentByName(): Map<string, CreateAgentInput> {
  if (canonicalByName) return canonicalByName;
  const m = new Map<string, CreateAgentInput>();
  m.set(ORCHESTRATOR_POD_CONTENT.name, ORCHESTRATOR_POD_CONTENT);
  m.set(COMMAND_PLANNER_POD_CONTENT.name, COMMAND_PLANNER_POD_CONTENT);
  for (const c of STOCK_POD_CONTENT) m.set(c.name, c);
  canonicalByName = m;
  return m;
}

/** Detect drift for a single pod. Returns:
 *    - `null` when the pod is not stock (origin !== 'stock') OR the pod's
 *      name has no canonical content registered (defensive — shouldn't
 *      happen if migrations + seed agree).
 *    - `string[]` (possibly empty) listing drifted SEED_OWNED_FIELDS names
 *      when the pod IS stock. Empty array = pristine; non-empty = customised.
 */
export function detectStockPodDrift(pod: PodAgentRow): string[] | null {
  if (pod.origin !== 'stock') return null;
  const canonical = getCanonicalContentByName().get(pod.name);
  if (!canonical) return null;
  return collectDriftedFields(pod, canonical);
}

/** Returns the canonical roster of stock-pod names — the same set that the
 *  reset-all path walks. Useful for tests and the reset-all summary shape. */
export function listCanonicalStockPodNames(): string[] {
  return [...getCanonicalContentByName().keys()];
}
