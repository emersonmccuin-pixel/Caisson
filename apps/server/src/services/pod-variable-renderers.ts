// Section 36 — Pod-prompt variable renderers.
//
// The pod materializer (packages/runtime/src/pod-materializer.ts) substitutes
// `{{KEY}}` placeholders in agent prompts when the caller supplies a
// `variables: Record<string, string>` map. The runtime package stays
// decoupled from @pc/db; this server-side module computes the rendered
// values from live DB state and returns plain strings the materializer
// substitutes verbatim.
//
// Two canonical variables ship in 36.3:
//
//   - `AVAILABLE_AGENTS` — the dispatching pod's view of every live agent it
//     could dispatch to. Stock first, then user-created; alphabetical within
//     each section. Each entry carries name + origin tag + description + the
//     orchestrator-facing `dispatch_guidance` hint (when non-null).
//
//   - `AVAILABLE_TOOLS` — materializer-owned in @pc/runtime so it can render
//     from the final expanded tool list (post-wildcard,
//     post-mergeRequiredAgentTools).
//
// AVAILABLE_AGENTS exists for the orchestrator prompt (36.4). Add new
// DB-backed variables here as the need arises — one variable per use case,
// no general-purpose templating.

import { listProjectVisibleAgents } from '@pc/db';
import type { ULID } from '@pc/domain';

/** Format the full agent roster the orchestrator (or any other pod opting in
 *  via `{{AVAILABLE_AGENTS}}`) can dispatch to. Stock pods first, then
 *  user-created; alphabetical within each group. Returns an empty string when
 *  no agents are live (rare — implies the seed didn't run). */
export function renderAvailableAgents(projectId: ULID | null | undefined): string {
  // Project pods + built-in (stock) agents only — same path/rule as the
  // Agents-tab list route. Global user-created pods are NOT discoverable here;
  // the user must copy one into the project (Add agent) to make it usable.
  const rows = listProjectVisibleAgents(projectId);
  // The orchestrator must never advertise itself as a dispatch target.
  const dispatchable = rows.filter((a) => a.name !== 'orchestrator');
  if (dispatchable.length === 0) return '';

  // Sort: stock first (alpha), then user-created (alpha).
  const sorted = [...dispatchable].sort((a, b) => {
    if (a.origin !== b.origin) return a.origin === 'stock' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const blocks: string[] = [];
  for (const r of sorted) {
    const header = `### ${r.name} (${r.origin})`;
    const desc = r.description.trim() || '_(no description)_';
    const lines: string[] = [header, desc];
    if (r.dispatchGuidance && r.dispatchGuidance.trim() !== '') {
      lines.push(`*Dispatch for:* ${r.dispatchGuidance.trim()}`);
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}
