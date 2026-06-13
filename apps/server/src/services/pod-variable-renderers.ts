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
//     could dispatch to. Stock first, then member agents; alphabetical within
//     each section. Each entry carries name + origin tag + description + the
//     orchestrator-facing `dispatch_guidance` hint (when non-null). Excludes
//     the orchestrator itself and user-created agents not joined to this
//     project via agent_projects. Consumed by the orchestrator prompt (36.4).
//
//   - `AGENT_ROSTER` — the EXPLAINER's view (consumed by the caisson pod). The
//     full membership picture grouped by tier: Built-in (stock, every project),
//     In this project (member agents — private and shared ones added here), and
//     In the shared library, not in this project (shareable agents available to
//     add). Unlike AVAILABLE_AGENTS it KEEPS the orchestrator and shared
//     library, because caisson explains the roster rather than dispatches it.
//     Live from DB at spawn — never hardcode the roster in caisson's prompt or
//     knowledge.
//
//   - `PROJECT_AREAS` — the orchestrator's live view of the project's Areas
//     (the optional buckets work items file into). Each entry = name + id (to
//     pass back as `area_id`) + its plain-language summary (the filing signal).
//     Ordered by sortOrder, same as the Areas rail. Live from DB at spawn —
//     never hardcode the Area list in the orchestrator's prompt.
//
//   - `AVAILABLE_TOOLS` — materializer-owned in @pc/runtime so it can render
//     from the final expanded tool list (post-wildcard,
//     post-mergeRequiredAgentTools).
//
// Add new DB-backed variables here as the need arises — one variable per use
// case, no general-purpose templating.

import { listAgents, listAreas, listProjectMemberAgents, listProjectVisibleAgents } from '@pc/db';
import type { ULID } from '@pc/domain';

/** Format the full agent roster the orchestrator (or any other pod opting in
 *  via `{{AVAILABLE_AGENTS}}`) can dispatch to. Stock pods first, then
 *  user-created; alphabetical within each group. Returns an empty string when
 *  no agents are live (rare — implies the seed didn't run). */
export function renderAvailableAgents(projectId: ULID | null | undefined): string {
  // Built-in (stock) agents + user-created agents joined to this project via
  // agent_projects (members). User-created agents not in agent_projects for
  // this project are not visible here — add them to the project first.
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
 *  Grouped by membership tier so caisson can answer from the right standpoint:
 *
 *  - **Built-in** (origin=stock) — ships with Caisson, available in every
 *    project automatically; includes `orchestrator` and the stock specialists.
 *  - **In this project** — user-created agents joined to this project via
 *    `agent_projects`. Covers both private project agents and shared agents
 *    that have been added here. Editing one affects it everywhere it's attached.
 *  - **In the shared library, not in this project** — `shareable=true` agents
 *    that exist in the library but are not yet attached to this project. To use
 *    one here, add it to the project ("Add to project" in the Agents tab).
 *    Adding attaches the same shared agent — edits apply everywhere it lives.
 *
 *  All groups alphabetical (DB orders by name). When nothing comes back (seed
 *  hasn't run) we say so rather than emit a blank. */
export function renderAgentRosterForCaisson(projectId: ULID | null | undefined): string {
  // Built-in agents: always visible, origin=stock.
  const visible = listProjectVisibleAgents(projectId ?? undefined);
  const builtIn = visible.filter((r) => r.origin === 'stock');

  // In-project members: user-created agents joined via agent_projects.
  const members = projectId ? listProjectMemberAgents(projectId) : [];

  // Shared library agents not yet attached to this project.
  const memberIdSet = new Set(members.map((m) => m.id));
  const sharedNotHere = listAgents().filter(
    (a) => a.shareable && a.origin !== 'stock' && !memberIdSet.has(a.id),
  );

  if (builtIn.length === 0 && members.length === 0 && sharedNotHere.length === 0) {
    return '_No agents found — the stock seed may not have run. Call `pc_list_agents` to re-check before answering._';
  }

  const sections: string[] = [];
  if (builtIn.length > 0) {
    sections.push(
      `**Built-in** (ships with Caisson, available in every project — \`orchestrator\` is the chat the user talks to):\n${builtIn.map(formatRosterRow).join('\n')}`,
    );
  }
  if (members.length > 0) {
    sections.push(
      `**In this project** (agents attached to this project — dispatch any of these directly):\n${members.map(formatRosterRow).join('\n')}`,
    );
  }
  if (sharedNotHere.length > 0) {
    sections.push(
      `**In the shared library, not in this project** (shared agents not yet attached here — use "Add to project" in the Agents tab to bring one in; edits apply everywhere it's attached):\n${sharedNotHere.map(formatRosterRow).join('\n')}`,
    );
  }
  return sections.join('\n\n');
}

/** Format the project's live Areas for the orchestrator's `{{PROJECT_AREAS}}`.
 *  Each Area = name + id (passed back as `area_id` when filing) + its
 *  plain-language summary (the filing signal). Ordered by sortOrder, same as
 *  the Areas rail. Returns a clear sentinel when the project has none, so the
 *  orchestrator files Uncaptured (or creates an Area) rather than guessing. */
export function renderProjectAreas(projectId: ULID | null | undefined): string {
  if (!projectId) return '_No Areas — this project has none yet._';
  const rows = listAreas(projectId);
  if (rows.length === 0) return '_No Areas — this project has none yet._';
  return rows
    .map((a) => {
      const summary = a.summary.trim() || '_(no summary yet — write one with pc_update_area)_';
      return `- **${a.name}** (id: \`${a.id}\`) — ${summary}`;
    })
    .join('\n');
}
