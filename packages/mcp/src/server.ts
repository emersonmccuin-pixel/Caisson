// ☠ FD-2 (Step-4 Slice 0, 2026-06-04): the per-session STDIO pc-rig child is
// DEAD. Every PC-spawned claude.exe now calls the ONE shared HTTP tools
// endpoint served by apps/server (`/api/mcp`, see `./http-endpoint.ts`); the
// session-local mcp.json carries a `{type:'http'}` entry with signed identity
// headers instead of a `command:'node' … dist/server.mjs` spawn.
//
// This module remains the canonical TOOL DATA source: the ordered TOOLS array
// (zipped from `PC_RIG_TOOL_REGISTRY`) and the fully-qualified
// `PC_RIG_TOOL_NAMES` consumed by apps/server's wildcard expansion. No
// transport, no side effects.

// Import from the barrel-free subpath: the registry is pure data, so this keeps
// `@pc/domain`'s `yaml` dep (and the rest of the barrel) out of the esbuild
// bundle — a barrel import breaks the dist/server.mjs boot (yaml uses a dynamic
// CJS require esbuild's ESM output can't satisfy).
import { PC_RIG_TOOL_REGISTRY } from '@pc/domain/tool-registry';

/** Slice 016 — the MCP server tool objects, ZIPPED from the canonical
 *  `PC_RIG_TOOL_REGISTRY` (@pc/domain: name + agent description + inputSchema)
 *  IN REGISTRY ORDER. The registry is now the SOLE ordered source of truth;
 *  ListTools ordering is GUARANTEED by it instead of a hand-curated array.
 *  Execution lives in the `PC_RIG_HANDLERS` map (zipped with this list by name
 *  at CallTool time); the slice-016 parity test asserts the two are a bijection
 *  in registry order, so a half-added tool fails the build. */
export const TOOLS = PC_RIG_TOOL_REGISTRY.map((def) => ({
  name: def.name,
  description: def.description,
  inputSchema: def.inputSchema,
}));

/** Section 36 — fully-qualified slugs consumed by apps/server's
 *  `mcp__pc-rig__*` wildcard expansion. Derived from the registry order so the
 *  views can never drift. The `mcp__pc-rig__` prefix is the MCP server name
 *  Caisson scaffolds into every project's .mcp.json — keep it in sync if the
 *  server gets renamed. */
export const PC_RIG_TOOL_NAMES: readonly string[] = PC_RIG_TOOL_REGISTRY.map(
  (d) => `mcp__pc-rig__${d.name}` as const,
);
