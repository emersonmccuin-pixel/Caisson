// Section 36 — Pod-prompt variable renderers.
//
// The pod materializer (packages/runtime/src/pod-materializer.ts) substitutes
// `{{KEY}}` placeholders in agent prompts when the caller supplies a
// `variables: Record<string, string>` map. The runtime package stays
// decoupled from @pc/db; this server-side module computes the rendered
// values from live DB state and returns plain strings the materializer
// substitutes verbatim.
//
// Canonical variables:
//
//   - `AVAILABLE_AGENTS` — the DISPATCHING pod's view of every live agent it
//     could dispatch to. Stock first, then user-created; alphabetical within
//     each section. Each entry carries name + origin tag + description + the
//     orchestrator-facing `dispatch_guidance` hint (when non-null). Excludes
//     the orchestrator itself and global user-created pods (not dispatchable
//     in-project). Consumed by the orchestrator prompt (36.4).
//
//   - `AGENT_ROSTER` — the EXPLAINER's view (consumed by the caisson pod). The
//     full picture grouped by where each agent lives: built-in (stock), this
//     project's customs, and the user's global customs. Unlike AVAILABLE_AGENTS
//     it KEEPS the orchestrator and global customs, because caisson explains the
//     roster rather than dispatches it. Live from DB at spawn — never hardcode
//     the roster in caisson's prompt or knowledge.
//
//   - `AVAILABLE_TOOLS` — materializer-owned in @pc/runtime so it can render
//     from the final expanded tool list (post-wildcard,
//     post-mergeRequiredAgentTools).
//
// Add new DB-backed variables here as the need arises — one variable per use
// case, no general-purpose templating.

import { listAgents, listProjectVisibleAgents } from '@pc/db';
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

type RosterRow = ReturnType<typeof listAgents>[number];

function formatRosterRow(r: RosterRow): string {
  const desc = r.description.trim() || '_(no description)_';
  const lines = [`- **${r.name}** — ${desc}`];
  if (r.dispatchGuidance && r.dispatchGuidance.trim() !== '') {
    lines.push(`  - _Dispatch for:_ ${r.dispatchGuidance.trim()}`);
  }
  return lines.join('\n');
}

/** Format the EXPLAINER's full agent roster (caisson's `{{AGENT_ROSTER}}`).
 *  Grouped by where each agent lives so caisson can answer from the right
 *  standpoint: built-in (stock, ships with Caisson — includes the orchestrator
 *  itself and the conversational builders), this project's custom pods, and the
 *  user's global custom pods (which must be copied into a project before they
 *  can be dispatched there). All groups alphabetical (DB orders by name). When
 *  no rows come back (seed hasn't run) we say so rather than emit a blank. */
export function renderAgentRosterForCaisson(projectId: ULID | null | undefined): string {
  const rows = projectId
    ? listAgents({ projectId, includeGlobals: true })
    : listAgents({ scope: 'global' });
  if (rows.length === 0) {
    return '_No agents found — the stock seed may not have run. Call `pc_list_agents` to re-check before answering._';
  }

  const builtIn = rows.filter((r) => r.origin === 'stock');
  const projectPods = rows.filter((r) => r.origin === 'user-created' && r.scope === 'project');
  const globalCustom = rows.filter((r) => r.origin === 'user-created' && r.scope === 'global');

  const sections: string[] = [];
  if (builtIn.length > 0) {
    sections.push(
      `**Built-in agents** (ship with Caisson, available in every project — \`orchestrator\` is the chat the user talks to):\n${builtIn.map(formatRosterRow).join('\n')}`,
    );
  }
  if (projectPods.length > 0) {
    sections.push(
      `**This project's agents** (custom, scoped to this project):\n${projectPods.map(formatRosterRow).join('\n')}`,
    );
  }
  if (globalCustom.length > 0) {
    sections.push(
      `**The user's global agents** (custom, global scope — copy one into a project with "Add agent" before it can be dispatched there):\n${globalCustom.map(formatRosterRow).join('\n')}`,
    );
  }
  return sections.join('\n\n');
}
