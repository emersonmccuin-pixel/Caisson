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

import { getPodForSpawn, getMcpServerRegistry, listMcpAttachmentsForAgent } from '@pc/db';
import type { PodMcpServerConfig, ULID } from '@pc/domain';
import { materializePodPlugin, type MaterializedPluginPod, type PodWorkItemContext } from '@pc/runtime';
import {
  prepareClaudeRuntimeFiles,
  type ClaudeRuntimeIdentity,
} from './claude-runtime-bundle.ts';
import { buildContextChain } from './context-chain.ts';
import { PC_RIG_TOOL_NAMES } from './pod-tool-catalog.ts';
import {
  renderAgentRosterForCaisson,
  renderAvailableAgents,
  renderProjectAreas,
} from './pod-variable-renderers.ts';

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
  /** FD-2 — per-spawn identity baked into the pc-rig HTTP entry headers
   *  (replaces the env-var identity the stdio child read). */
  identity?: ClaudeRuntimeIdentity;
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
   *  the dispatch door's `mcpConfigPath`. */
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
  /** Context docs whose FULL BODIES the chain inlined into the spawn prompt.
   *  Phase B (0056): the dispatcher records these as 'injection' read receipts
   *  AFTER the run row exists. Empty when no chain was built. */
  injectedContextDocIds: ULID[];
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
    identity: input.identity,
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
  if (promptBody.includes('{{AGENT_ROSTER}}')) {
    variables.AGENT_ROSTER = renderAgentRosterForCaisson(input.projectId ?? null);
  }
  if (promptBody.includes('{{PROJECT_AREAS}}')) {
    variables.PROJECT_AREAS = renderProjectAreas(input.projectId ?? null);
  }

  // Slice 1 (context model) — build the "## Project & area context" chain
  // block for injection into the system prompt when a work item is present.
  // Only the server has DB access; this is the right call site.
  let contextChain: string | undefined;
  let injectedContextDocIds: ULID[] = [];
  if (input.workItem?.workItemId && input.projectId) {
    try {
      const chain = buildContextChain({
        workItemId: input.workItem.workItemId as ULID,
        projectId: input.projectId,
      });
      contextChain = chain.markdown || undefined;
      injectedContextDocIds = chain.inlinedDocIds;
    } catch {
      // Non-fatal: missing context chain is better than a spawn failure.
      contextChain = undefined;
      injectedContextDocIds = [];
    }
  }

  // pc-pty-chat-359 P4a — merge registry-based MCP servers into the spawn
  // config. Both dispatched agents and the orchestrator go through this path;
  // the orchestrator is just another agentId with its own attachments row set.
  const registry = buildRegistryMcpConfig(bundle.agent.id);

  const materialised: MaterializedPluginPod = materializePodPlugin({
    bundle,
    worktreeDir: input.worktreeDir,
    scratchDir: input.scratchDir,
    baselineMcpServers: { ...runtimeFiles.baselineMcpServers, ...registry.servers },
    mcpToolCatalog: { 'pc-rig': PC_RIG_TOOL_NAMES, ...registry.catalog },
    workItem: input.workItem,
    ...(contextChain ? { contextChain } : {}),
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
    injectedContextDocIds,
  };
}

// ── Registry MCP resolution ────────────────────────────────────────────────────

/** Load the registry-based MCP servers attached to `agentId` and return the
 *  extra `servers` (to merge into `baselineMcpServers`) and `catalog` (to
 *  merge into `mcpToolCatalog`) entries they contribute.
 *
 *  - `enabledTools: '*'`  → catalog entry uses `discoveredTools` (empty array
 *    when the server has not been probed; the wildcard expander then emits no
 *    tools, which is the safe default rather than a hard spawn failure).
 *  - `enabledTools: string[]` → catalog entry uses the explicit selection.
 *
 *  Non-fatal: any DB or registry-read error is silently swallowed so that a
 *  missing registry row or a probe failure never prevents spawn. */
export function buildRegistryMcpConfig(agentId: ULID): {
  servers: Record<string, PodMcpServerConfig>;
  catalog: Record<string, readonly string[]>;
} {
  const servers: Record<string, PodMcpServerConfig> = {};
  const catalog: Record<string, readonly string[]> = {};
  try {
    const attachments = listMcpAttachmentsForAgent(agentId);
    for (const att of attachments) {
      const row = getMcpServerRegistry(att.mcpServerId);
      if (!row) continue;
      servers[row.name] = row.transport;
      catalog[row.name] =
        att.enabledTools === '*' ? (row.discoveredTools ?? []) : att.enabledTools;
    }
  } catch {
    // Non-fatal: never block spawn because the registry is unavailable.
  }
  return { servers, catalog };
}
