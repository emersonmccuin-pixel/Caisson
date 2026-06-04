// M7 (FD-6) — boot sweep: strip DEAD tool grants from stored agent rows.
//
// seedStockPods drift-reseeds GLOBAL stock pods only; project-scoped copies
// and custom pods keep their stored tools_json forever. When a tool is
// deleted from the registry (☠ pc_ask_user), stale grants are runtime-
// harmless (the MCP server no longer offers the tool) but violate one-path
// hygiene and confuse the Agents-tab tool list. This sweep scrubs them
// through the audited updateAgent door. Idempotent; no-op once clean.
//
// Audit reason deliberately does NOT use the `system-seed:`/`system-reseed:`
// prefixes — those break pod-seed-with-drift's user-edit chain and would
// unlock future drift-reseeds to stomp user customizations.

import { listAgents, updateAgent } from '@pc/db';
import type { PodAgentRow, ULID } from '@pc/domain';

/** Tool slugs deleted from the registry whose stored grants must be scrubbed.
 *  Grows when a future pass deletes another granted tool. */
export const DEAD_TOOL_GRANTS: readonly string[] = ['mcp__pc-rig__pc_ask_user'];

export interface ScrubDeadToolGrantsResult {
  scanned: number;
  scrubbed: number;
  /** `name (scope)` per scrubbed row, for the boot log. */
  rows: string[];
}

export function scrubDeadToolGrants(): ScrubDeadToolGrantsResult {
  const agents: PodAgentRow[] = listAgents();
  const result: ScrubDeadToolGrantsResult = { scanned: agents.length, scrubbed: 0, rows: [] };
  for (const agent of agents) {
    const tools = agent.tools ?? [];
    const next = tools.filter((t) => !DEAD_TOOL_GRANTS.includes(t));
    if (next.length === tools.length) continue;
    updateAgent(agent.id as ULID, { tools: next }, {
      actor: 'orchestrator',
      reason: `m7-fd6-dead-grant-scrub — removed [${tools
        .filter((t) => DEAD_TOOL_GRANTS.includes(t))
        .join(', ')}] (tool deleted from registry)`,
    });
    result.scrubbed += 1;
    result.rows.push(`${agent.name} (${agent.scope})`);
  }
  return result;
}
