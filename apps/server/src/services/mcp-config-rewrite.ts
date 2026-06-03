// Per-config `.mcp.json` launcher rewrite: applyNodeLauncher swaps PC-owned MCP
// server entries onto the resolved Node launcher (node in dev,
// Electron-run-as-node when packaged). Used at materialize time by
// claude-runtime-bundle.

import type { NodeLauncher } from '@pc/runtime';

// Section 10 Phase 1.4 — the Node scripts PC scaffolds into every project's
// `.mcp.json`. An mcpServer entry is PC-node-launched iff one of its args ends
// with one of these (matched by suffix so it's robust to the absolute prefix
// changing between dev and a packaged/relocated install).
const PC_NODE_SCRIPT_SUFFIXES = [
  '/packages/mcp/dist/server.mjs',
] as const;

interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
}

interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Section 10 Phase 1.4 — rewrite every PC-node-launched mcpServer entry in a
 * parsed `.mcp.json` object to use `launcher`. Mutates `config` in place;
 * returns whether anything changed (so callers can skip rewriting unchanged
 * files). Idempotent.
 *
 * For each PC node server (matched by script-path suffix — pc-rig + webhook):
 *   - `command` ← `launcher.command`
 *   - `launcher.env` keys merged into `entry.env`
 *   - any env key the launcher does NOT set is reconciled: a stale
 *     `ELECTRON_RUN_AS_NODE` left by a prior packaged run is stripped when the
 *     current launcher is plain `node`, so a project scaffolded by the
 *     installed app still works when later opened under tsx dev.
 *
 * Foreign mcpServers (a user- or pod-added python/other server) are never
 * touched — only entries pointing at PC's own bundled scripts.
 */
export function applyNodeLauncher(config: McpConfig, launcher: NodeLauncher): boolean {
  const servers = config.mcpServers;
  if (!servers) return false;
  let changed = false;
  for (const entry of Object.values(servers)) {
    if (!isPcNodeServer(entry)) continue;
    if (entry.command !== launcher.command) {
      entry.command = launcher.command;
      changed = true;
    }
    const env = (entry.env ??= {});
    for (const [key, value] of Object.entries(launcher.env)) {
      if (env[key] !== value) {
        env[key] = value;
        changed = true;
      }
    }
    // Strip a stale Node-mode flag the launcher no longer sets (packaged →
    // dev transition). Only ELECTRON_RUN_AS_NODE is launcher-owned.
    if (!('ELECTRON_RUN_AS_NODE' in launcher.env) && 'ELECTRON_RUN_AS_NODE' in env) {
      delete env.ELECTRON_RUN_AS_NODE;
      changed = true;
    }
  }
  return changed;
}

function isPcNodeServer(entry: McpServerEntry): boolean {
  return (
    Array.isArray(entry.args) &&
    entry.args.some(
      (a) => typeof a === 'string' && PC_NODE_SCRIPT_SUFFIXES.some((s) => a.endsWith(s)),
    )
  );
}
