// Migration 0055 — boot sweep: remap RENAMED tool slugs in stored agent rows.
//
// The knowledge tools collapsed into the context-doc family (one path):
// pc_knowledge_read → pc_get_context_doc, pc_create_knowledge →
// pc_add_context_doc, pc_update_knowledge → pc_update_context_doc,
// pc_delete_knowledge → pc_delete_context_doc. seedStockPods drift-reseeds
// GLOBAL stock pods only; user-edited stock pods and ALL user-created pods
// keep their stored tools_json — without this sweep their attached docs go
// dark silently (the materializer footer gates on the NEW read slug). Runs
// after migrations, before seedStockPods. Idempotent; no-op once clean.
//
// Mirrors agent-tools-scrub.ts (M7). Audit reason deliberately avoids the
// `system-seed:`/`system-reseed:` prefixes — those would break
// pod-seed-with-drift's user-edit chain.

import { listAgents, updateAgent } from '@pc/db';
import type { PodAgentRow, ULID } from '@pc/domain';

/** Old slug → new slug. Grows if a future pass renames another granted tool. */
export const TOOL_SLUG_REMAP: ReadonlyMap<string, string> = new Map([
  ['mcp__pc-rig__pc_knowledge_read', 'mcp__pc-rig__pc_get_context_doc'],
  ['mcp__pc-rig__pc_create_knowledge', 'mcp__pc-rig__pc_add_context_doc'],
  ['mcp__pc-rig__pc_update_knowledge', 'mcp__pc-rig__pc_update_context_doc'],
  ['mcp__pc-rig__pc_delete_knowledge', 'mcp__pc-rig__pc_delete_context_doc'],
]);

export interface RemapToolSlugsResult {
  scanned: number;
  remapped: number;
  /** `name (scope)` per remapped row, for the boot log. */
  rows: string[];
}

export function remapRenamedToolSlugs(): RemapToolSlugsResult {
  const agents: PodAgentRow[] = listAgents();
  const result: RemapToolSlugsResult = { scanned: agents.length, remapped: 0, rows: [] };
  for (const agent of agents) {
    const tools = agent.tools ?? [];
    const hit = tools.some((t) => TOOL_SLUG_REMAP.has(t));
    if (!hit) continue;
    // Remap then dedupe (a pod may already carry the new slug alongside the old).
    const next = [...new Set(tools.map((t) => TOOL_SLUG_REMAP.get(t) ?? t))];
    updateAgent(agent.id as ULID, { tools: next }, {
      actor: 'orchestrator',
      reason: `tool-slug-remap-0055 — knowledge tools renamed to context-doc tools: [${tools
        .filter((t) => TOOL_SLUG_REMAP.has(t))
        .join(', ')}]`,
    });
    result.remapped += 1;
    result.rows.push(`${agent.name} (${agent.scope})`);
  }
  return result;
}
