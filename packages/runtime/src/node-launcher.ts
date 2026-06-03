// Section 10 Phase 1.4 — how to launch a Node script in the current runtime.
//
// PC's per-session `mcp.json` bakes `"command": "node"` for the pc-rig tools
// server (`packages/mcp/dist/server.mjs`). That works under tsx
// dev (system `node` on PATH), but a packaged Electron app has NO system node —
// so claude.exe's attempt to spawn those MCP children would fail silently and
// the orchestrator would lose every pc-rig tool.
//
// Electron ships a Node runtime inside its own binary, re-entered via the
// ELECTRON_RUN_AS_NODE=1 env var. So in a packaged app we launch via the app's
// own executable (`process.execPath`) with that flag set.
//
// Resolution order:
//   PC_NODE_LAUNCHER env override → that command, no extra env (tests / unusual setups)
//   running inside Electron       → process.execPath + { ELECTRON_RUN_AS_NODE: '1' }
//   otherwise (tsx dev / Node)    → 'node', no extra env

export interface NodeLauncher {
  /** Executable that runs a Node script. `'node'` under dev; the app binary in
   *  a packaged Electron build. */
  command: string;
  /** Env that MUST be merged into any spawned Node-launched MCP server so the
   *  launcher runs in Node mode. Empty under dev; `{ ELECTRON_RUN_AS_NODE: '1' }`
   *  when packaged. */
  env: Record<string, string>;
}

/** Resolve the node launcher for the current process. Args are injectable so
 *  unit tests can exercise the packaged branch without an Electron runtime. */
export function resolveNodeLauncher(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  isElectron: boolean = Boolean(process.versions.electron),
): NodeLauncher {
  const override = env.PC_NODE_LAUNCHER?.trim();
  if (override) return { command: override, env: {} };
  if (isElectron) return { command: execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  return { command: 'node', env: {} };
}
