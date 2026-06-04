// FD-16 — the two-tier tool door: pc_find_tool (search the full catalog) +
// pc_call_tool (execute an on-demand tool through the SAME handler chain, so
// server routes / audit logs / receipts are identical to a direct call).
//
// Tier policy lives in @pc/domain PC_RIG_TOOL_TIERS. pc_call_tool dispatches
// ONLY tier 'on-demand': first-order tools are already granted directly,
// worker-side tools flow INTO the orchestrator and are refused with a typed
// message. The door tools themselves are first-order, which structurally
// prevents call→call recursion.

// Barrel-free subpath import — keeps @pc/domain's `yaml` dep out of the
// esbuild bundle (same rationale as handlers.ts).
import {
  PC_RIG_TOOL_REGISTRY,
  PC_RIG_TOOL_TIERS,
  type PcRigToolDef,
} from '@pc/domain/tool-registry';

import type { ToolContext, ToolResult } from './context.ts';

const MAX_MATCHES = 5;

export async function handleMetaTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  // Injected to avoid a static meta ⇄ handlers import cycle; handlers.ts
  // passes its own dispatchPcRigTool.
  dispatch: (
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<ToolResult>,
): Promise<ToolResult | null> {
  switch (name) {
    case 'pc_find_tool': {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) {
        return {
          content: [{ type: 'text', text: 'pc_find_tool: query required' }],
          isError: true,
        };
      }
      const matches = searchRegistry(query);
      if (matches.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No catalog tool matches "${query}". The catalog covers work items, agents/knowledge/secrets config, workflows (run + authoring), project stages/fields, and run controls — try different keywords.`,
            },
          ],
        };
      }
      return { content: [{ type: 'text', text: matches.map(renderMatch).join('\n\n') }] };
    }
    case 'pc_call_tool': {
      const target = typeof args.name === 'string' ? args.name.trim() : '';
      if (!target) {
        return {
          content: [{ type: 'text', text: 'pc_call_tool: name required' }],
          isError: true,
        };
      }
      const tier = PC_RIG_TOOL_TIERS[target];
      if (tier === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: `pc_call_tool: unknown tool "${target}". Use pc_find_tool to discover the exact name.`,
            },
          ],
          isError: true,
        };
      }
      if (tier === 'worker') {
        return {
          content: [
            {
              type: 'text',
              text: `pc_call_tool: "${target}" is a worker-side tool — it flows INTO you from dispatched agents and is not callable from your seat.`,
            },
          ],
          isError: true,
        };
      }
      if (tier === 'first-order') {
        return {
          content: [
            {
              type: 'text',
              text: `pc_call_tool: "${target}" is a first-order tool. If it's in your allowlist, call it directly; if it isn't, it was deliberately withheld from this pod and the door does not bypass that.`,
            },
          ],
          isError: true,
        };
      }
      const innerArgs =
        args.args && typeof args.args === 'object' && !Array.isArray(args.args)
          ? (args.args as Record<string, unknown>)
          : {};
      const result = await dispatch(target, innerArgs, ctx);
      // Stamp the door on the result so the transcript shows which path the
      // call took (the inner tool's own receipts/audit rows are unchanged).
      return {
        ...result,
        content: [
          { type: 'text', text: `[pc_call_tool → ${target}]` },
          ...result.content,
        ],
      };
    }
    default:
      return null;
  }
}

interface ScoredDef {
  def: PcRigToolDef;
  score: number;
}

/** Tiny keyword scorer — exact-name hit ranks first, then per-term hits over
 *  name/label/descriptions. No fuzz; the catalog is 50-odd entries. */
function searchRegistry(query: string): PcRigToolDef[] {
  const terms = query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
  if (terms.length === 0) return [];
  const scored: ScoredDef[] = [];
  for (const def of PC_RIG_TOOL_REGISTRY) {
    const name = def.name.toLowerCase();
    const haystack =
      `${name} ${def.label} ${def.catalogDescription} ${def.description}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (name === term || name === `pc_${term}`) score += 10;
      else if (name.includes(term)) score += 4;
      else if (haystack.includes(term)) score += 1;
    }
    if (score > 0) scored.push({ def, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_MATCHES).map((s) => s.def);
}

function renderMatch(def: PcRigToolDef): string {
  const tier = PC_RIG_TOOL_TIERS[def.name];
  if (tier === 'first-order') {
    return `${def.name} — ${def.catalogDescription}\ntier: first-order — if granted to you, call it directly (the door does not bypass a withheld grant).`;
  }
  if (tier === 'worker') {
    return `${def.name} — ${def.catalogDescription}\ntier: worker-side — flows into you from dispatched agents; not callable.`;
  }
  return [
    `${def.name} — ${def.catalogDescription}`,
    `tier: on-demand — call via pc_call_tool({ name: "${def.name}", args: { … } })`,
    `input schema: ${JSON.stringify(def.inputSchema)}`,
  ].join('\n');
}
