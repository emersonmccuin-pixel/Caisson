// Section 17a.5 — Pod spawn preparation.
//
// Resolves an agent name against the pod registry and, when a live global pod
// row exists, materialises it into a PC-owned per-session runtime bundle:
// a Claude plugin with the agent definition, a temp `mcp.json`, and a
// session-local settings file. Nothing is written to the user's worktree
// `.claude/` or `.mcp.json`.
//
// Pod resolution is project-first-then-global as of Section 22.1
// (codebase-review stabilization, 2026-05-25). Callers that have a projectId
// MUST pass it so a project-scoped pod with the same name wins; callers that
// don't (genuinely global-only contexts) can omit it for the legacy lookup.
//
// When no pod row exists, the helper returns a null bundle. Production callers
// treat that as a loud spawn error; the old project-root fallback was removed
// when PC's runtime became isolated from terminal Claude Code sessions.

import { getPodForSpawn } from '@pc/db';
import type { ULID } from '@pc/domain';
import { materializePodPlugin, type MaterializedPluginPod, type PodWorkItemContext } from '@pc/runtime';
import { prepareClaudeRuntimeFiles } from './claude-runtime-bundle.ts';
import { PC_RIG_TOOL_NAMES } from './pod-tool-catalog.ts';
import { renderAvailableAgents } from './pod-variable-renderers.ts';

export interface PreparePodSpawnInput {
  /** Agent name — looked up against the pod rows. */
  agentName: string;
  /** Project context for the dispatch. When set, a project-scoped pod with
   *  this name wins over the same-name global pod. Omit only when the
   *  dispatch is genuinely project-agnostic (no such call site exists in
   *  production today — all spawns happen within a project). */
  projectId?: ULID | null;
  /** Worktree root. Claude still runs here as cwd, but PC runtime files do not. */
  worktreeDir: string;
  /** Per-spawn scratch dir — temp `mcp.json` lands here. Caller owns the dir
   *  lifecycle; cleanup() removes the file but NOT the dir. */
  scratchDir: string;
  /** Section 26.4 — when the dispatch carries a work-item assignment, the
   *  materialised agent .md gains a "## Your assignment" section telling the
   *  agent to fetch the work item as its first action + surfacing the
   *  expected_output JSON. Null / undefined → no section emitted, matching
   *  today's behaviour. */
  workItem?: PodWorkItemContext;
  /** Optional runtime wiring overrides. Production project runtimes pass these
   *  explicitly; server-side agent routes can fall back to process defaults. */
  dataDir?: string;
  templatesDir?: string;
  trunkPath?: string;
  serverPort?: number;
  projectSlug?: string | null;
  projectName?: string | null;
}

export interface PodSpawnPrep {
  /** Absolute path to the materialised pod `mcp.json`. Caller passes this as
   *  PtySession's / the dispatch door's `mcpConfigPath`. */
  mcpConfigPath: string;
  /** Agent name to pass to `--agent`. Plugin agents are namespaced. */
  agentCliName: string;
  /** Session-local plugin dir passed via `--plugin-dir`. */
  pluginDir: string;
  /** Session-local settings JSON passed via `--settings`. */
  settingsPath: string;
  /** Empty string disables user/project/local setting discovery. */
  settingSources: '';
  /** Env-var map from the pod's secrets. Caller merges into the spawn's
   *  `extraEnv`. Empty when the pod has no secrets. */
  extraEnv: Record<string, string>;
  /** Tear-down hook — removes the materialised .md + mcp.json. Caller invokes
   *  on spawn-handle resolution (success or failure). Tolerant of repeat calls. */
  cleanup(): void;
  /** Which scope `getPodForSpawn` actually resolved. Lets the caller pin
   *  downstream queries (e.g. `computePodRevision`) to the row we used —
   *  same-name project-scope pod can shadow a global. */
  podScope: 'global' | 'project';
  /** The project the resolved pod belongs to (when `podScope === 'project'`).
   *  Null for globals. */
  podProjectId: ULID | null;
}

/** Resolves the pod for `agentName` and materialises it. Returns `null` when
 *  no live global pod row exists for that name. */
export function preparePodSpawn(input: PreparePodSpawnInput): PodSpawnPrep | null {
  const bundle = getPodForSpawn(input.agentName, input.projectId);
  if (!bundle) return null;

  const runtimeFiles = prepareClaudeRuntimeFiles({
    scratchDir: input.scratchDir,
    worktreeDir: input.worktreeDir,
    projectId: input.projectId,
    projectSlug: input.projectSlug,
    projectName: input.projectName,
    dataDir: input.dataDir,
    templatesDir: input.templatesDir,
    trunkPath: input.trunkPath,
    serverPort: input.serverPort,
  });

  // Section 36 — pod-prompt variable substitution. Compute the DB-backed
  // roster lazily only when referenced. AVAILABLE_TOOLS is materializer-owned
  // because it must render from the final expanded tool allowlist.
  const promptBody = bundle.agent.prompt;
  const variables: Record<string, string> = {};
  if (promptBody.includes('{{AVAILABLE_AGENTS}}')) {
    variables.AVAILABLE_AGENTS = renderAvailableAgents(input.projectId ?? null);
  }

  const materialised: MaterializedPluginPod = materializePodPlugin({
    bundle,
    worktreeDir: input.worktreeDir,
    scratchDir: input.scratchDir,
    baselineMcpServers: runtimeFiles.baselineMcpServers,
    mcpToolCatalog: { 'pc-rig': PC_RIG_TOOL_NAMES },
    workItem: input.workItem,
    ...(Object.keys(variables).length > 0 ? { variables } : {}),
  });

  return {
    mcpConfigPath: materialised.mcpConfigPath,
    agentCliName: materialised.agentCliName,
    pluginDir: materialised.pluginDir,
    settingsPath: runtimeFiles.settingsPath,
    settingSources: runtimeFiles.settingSources,
    extraEnv: {
      ...materialised.envVars,
      ...runtimeFiles.extraEnv,
    },
    cleanup() {
      try { materialised.cleanup(); } catch { /* best-effort */ }
      try { runtimeFiles.cleanup(); } catch { /* best-effort */ }
    },
    podScope: bundle.agent.scope,
    podProjectId: bundle.agent.projectId ?? null,
  };
}
