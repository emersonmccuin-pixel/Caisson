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

import { getDossier, getPodForSpawn, getMcpServerRegistry, listMcpAttachmentsForAgent, listMcpServersRegistry } from '@pc/db';
import type { PodMcpServerConfig, ULID } from '@pc/domain';
import { materializePodPlugin, type MaterializedPluginPod, type PodWorkItemContext } from '@pc/runtime';
import {
  prepareClaudeRuntimeFiles,
  type ClaudeRuntimeIdentity,
} from './claude-runtime-bundle.ts';
import { buildContextChain, renderDossierBlock } from './context-chain.ts';
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
  /** pc-pty-chat-451 — when true, project-scoped registered MCP servers are
   *  auto-included without an explicit attachment row. Set true only for the
   *  orchestrator spawn; dispatched worker agents keep explicit-attach-only. */
  includeProjectServers?: boolean;
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
    // pc-pty-chat-434 — prepend the dossier block OUTSIDE the 20k budget.
    // Non-fatal: a missing dossier is better than a spawn failure.
    let dossierBlock = '';
    try {
      const dossierRow = getDossier(input.workItem.workItemId as ULID);
      dossierBlock = renderDossierBlock(dossierRow);
    } catch {
      dossierBlock = '';
    }

    try {
      const chain = buildContextChain({
        workItemId: input.workItem.workItemId as ULID,
        projectId: input.projectId,
      });
      const chainMarkdown = chain.markdown || '';
      const combined = [dossierBlock, chainMarkdown].filter(Boolean).join('\n\n');
      contextChain = combined || undefined;
      injectedContextDocIds = chain.inlinedDocIds;
    } catch {
      // Non-fatal: missing context chain is better than a spawn failure.
      contextChain = dossierBlock || undefined;
      injectedContextDocIds = [];
    }
  }

  // pc-pty-chat-359 P4a — merge registry-based MCP servers into the spawn
  // config. Both dispatched agents and the orchestrator go through this path;
  // the orchestrator is just another agentId with its own attachments row set.
  // pc-pty-chat-450 — pass spawnProjectId so project-scoped servers are only
  // included when the spawn project matches the server's project.
  // pc-pty-chat-451 — pass includeProjectServers flag (true only for the
  // orchestrator spawn; workers stay explicit-attach-only).
  const registry = buildRegistryMcpConfig(bundle.agent.id, input.projectId ?? null, {
    includeProjectServers: input.includeProjectServers,
  });

  // pc-pty-chat-454 — the orchestrator/chat spawn must be able to CALL the
  // project-scoped (and explicitly attached) MCP servers it connects to, not
  // just connect to them. The registry path wires mcp.json + the tool catalog,
  // but the `tools:` allowlist is derived solely from the pod's stored
  // tools_json — so an auto-included/attached server connects yet every tool is
  // forbidden (and the stock orchestrator's tools_json can't be hand-edited).
  // When includeProjectServers is set (orchestrator path ONLY), grant every
  // resolved registry tool into the allowlist. The catalog now holds
  // fully-qualified `mcp__<server>__<tool>` slugs (buildRegistryMcpConfig
  // normalises them), which is exactly what the `tools:` frontmatter matches.
  // Worker agents pass includeProjectServers=false and keep explicit-allowlist-
  // only — no grant.
  const extraGrantTools = input.includeProjectServers
    ? Object.values(registry.catalog).flat()
    : [];

  const materialised: MaterializedPluginPod = materializePodPlugin({
    bundle,
    worktreeDir: input.worktreeDir,
    scratchDir: input.scratchDir,
    baselineMcpServers: { ...runtimeFiles.baselineMcpServers, ...registry.servers },
    mcpToolCatalog: { 'pc-rig': PC_RIG_TOOL_NAMES, ...registry.catalog },
    workItem: input.workItem,
    ...(extraGrantTools.length > 0 ? { extraGrantTools } : {}),
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

// ── Stdio cwd wrapper ─────────────────────────────────────────────────────────

/** POSIX single-quote a field for an `sh -c` command string: wrap in single
 *  quotes (inert to word-splitting, globbing, and `$`/backtick expansion),
 *  escaping any embedded single quote as the standard `'\''` sequence. Used by
 *  the Unix branch only — the Windows branch passes raw argv tokens instead. */
function posixQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Node package-runner shims that ship ONLY as a Windows `.cmd` batch file
 *  (no sibling `.exe`). Node's `child_process.spawn` with `shell:false` — exactly
 *  how Claude Code launches a stdio MCP server — CANNOT execute a `.cmd`
 *  directly: it throws ENOENT. So a server configured with `command: "npx"`
 *  probes fine (the MCP SDK applies its own Windows `cmd /c` handling) yet fails
 *  to start under Claude, surfacing as "No such tool available" + a `/doctor`
 *  MCP setup warning (live-confirmed pc-pty-chat-454, Life Planning App). These
 *  must be wrapped as `cmd /c <shim> ...` so CreateProcess launches cmd.exe,
 *  which then resolves the `.cmd`. */
const WIN_CMD_SHIMS = new Set([
  'npx', 'npm', 'pnpm', 'pnpx', 'yarn', 'yarnpkg', 'bun', 'bunx', 'tsx',
  'corepack', 'node-gyp',
]);

/** True when, on Windows, `command` must be launched through `cmd /c` rather
 *  than spawned directly. Covers explicit `.cmd`/`.bat` files and the bare
 *  Node-runner shim names above. A direct executable (`node`, an absolute
 *  `*.exe` path like the cia-next python.exe) returns false — left untouched. */
function winCommandNeedsCmd(command: string): boolean {
  const lower = command.toLowerCase();
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) return true;
  const base = lower.replace(/\\/g, '/').split('/').pop() ?? lower;
  return WIN_CMD_SHIMS.has(base);
}

/** Normalize a stdio transport so the command Claude actually spawns succeeds.
 *  Two transforms, applied together:
 *
 *  1. `cwd` wrapper — Claude Code silently ignores a bare `cwd` field on stdio
 *     entries in mcp.json (verified beta-15, 2026-06-20), so it is encoded into
 *     a shell `cd` wrapper instead and the `cwd` key is consumed.
 *  2. Windows `.cmd`-shim wrapper — a command that is a Windows batch shim
 *     (npx/npm/pnpm/yarn/tsx/… or any `*.cmd`/`*.bat`) can't be spawned
 *     directly (ENOENT); it is routed through `cmd /c`. Applies even with NO
 *     `cwd` (the bug `wrapStdioCwd`'s old cwd-only guard left unwrapped).
 *
 *  - Windows: `command: "cmd"`, args either
 *      `["/c","cd","/d","<cwd>","&&","<cmd>",...args]`  (cwd present) or
 *      `["/c","<cmd>",...args]`                         (cwd absent, shim only).
 *    SEPARATE argv tokens — node quotes each for CreateProcess and cmd.exe
 *    reconstructs them; an inline quoted string breaks on spaced paths under
 *    cmd /c quote-stripping (live-verified, pc-pty-chat-452). `cd /d` handles
 *    drive changes.
 *  - Unix:    `command: "sh"`, `args: ["-c", "cd '<cwd>' && '<cmd>' '<args...>'"]`.
 *    Unix has no `.cmd` problem, so the shim wrap is win32-only.
 *
 *  `env` and `type` are preserved. A stdio entry needing neither transform, and
 *  an HTTP entry (has `url`, no `command`), are returned unchanged.
 *
 *  `platform` defaults to `process.platform`; pass explicitly in tests to drive
 *  the Windows vs Unix branch deterministically. */
export function wrapStdioCwd(
  transport: PodMcpServerConfig,
  platform: NodeJS.Platform = process.platform,
): PodMcpServerConfig {
  if (!transport.command) return transport;

  const hasCwd = typeof transport.cwd === 'string' && transport.cwd.length > 0;
  const needsWinShim = platform === 'win32' && winCommandNeedsCmd(transport.command);
  if (!hasCwd && !needsWinShim) return transport;

  const { cwd, command, args = [], type, env } = transport;

  const out: PodMcpServerConfig = {};
  if (type !== undefined) out.type = type;
  if (env !== undefined) out.env = env;

  if (platform === 'win32') {
    // SEPARATE argv tokens (NOT an inline-quoted single string). node quotes
    // each spaced token for CreateProcess and cmd.exe reconstructs them; an
    // inline `cd /d "<path with spaces>" && ...` string breaks under cmd /c
    // quote-stripping (live-verified, pc-pty-chat-452). `cd /d` handles drives.
    out.command = 'cmd';
    out.args = hasCwd
      ? ['/c', 'cd', '/d', cwd as string, '&&', command, ...args]
      : ['/c', command, ...args];
  } else {
    // sh -c takes ONE command string; POSIX single-quote every field so spaces
    // and shell-special chars are inert. Reached only when hasCwd (needsWinShim
    // is win32-only).
    out.command = 'sh';
    out.args = ['-c', `cd ${posixQuote(cwd as string)} && ${[command, ...args].map(posixQuote).join(' ')}`];
  }
  return out;
}

// ── Registry MCP resolution ────────────────────────────────────────────────────

/** Fully-qualify an MCP tool name to the `mcp__<server>__<tool>` slug CC's
 *  `tools:` allowlist matches on (exact-name, no wildcards). The discovery probe
 *  stores BARE server-local names (`tools/list` → `t.name`, e.g. `list_areas`),
 *  but the materializer's catalog + the frontmatter allowlist both require the
 *  qualified form — so a bare name must be prefixed. Idempotent: a name already
 *  carrying an `mcp__` prefix (explicit `enabledTools` selections are stored
 *  qualified) is returned unchanged so it's never double-prefixed. */
function qualifyMcpToolName(serverName: string, tool: string): string {
  return tool.startsWith('mcp__') ? tool : `mcp__${serverName}__${tool}`;
}

/** Load the registry-based MCP servers attached to `agentId` and return the
 *  extra `servers` (to merge into `baselineMcpServers`) and `catalog` (to
 *  merge into `mcpToolCatalog`) entries they contribute.
 *
 *  - `enabledTools: '*'`  → catalog entry uses `discoveredTools` (empty array
 *    when the server has not been probed; the wildcard expander then emits no
 *    tools, which is the safe default rather than a hard spawn failure).
 *  - `enabledTools: string[]` → catalog entry uses the explicit selection.
 *
 *  `spawnProjectId` — pc-pty-chat-450 project-scope filter. A project-scoped
 *  registry server is included ONLY when the spawn's project matches the
 *  server's `projectId`. Global servers (`scope === 'global'`) always apply
 *  regardless of `spawnProjectId`. When `spawnProjectId` is null (no project
 *  context) project-scoped servers are excluded entirely.
 *
 *  `opts.includeProjectServers` — pc-pty-chat-451 orchestrator auto-include.
 *  When true (and `spawnProjectId` is not null), all project-scoped registered
 *  servers for the spawn project are merged in without needing an explicit
 *  attachment row. Explicit attachments win on dedupe: if the same server name
 *  was already wired via an attachment row, the attachment's `enabledTools`
 *  takes precedence. Global servers are NEVER auto-included by this flag —
 *  they still require an explicit attachment. Set true only for the orchestrator
 *  spawn caller; dispatched worker agents keep explicit-attach-only.
 *
 *  Non-fatal: any DB or registry-read error is silently swallowed so that a
 *  missing registry row or a probe failure never prevents spawn. */
export function buildRegistryMcpConfig(
  agentId: ULID,
  spawnProjectId: ULID | null = null,
  opts: { includeProjectServers?: boolean } = {},
): {
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
      // Project-scoped servers only apply when the spawn's project matches.
      // Global servers always apply.
      if (row.scope === 'project' && row.projectId !== spawnProjectId) continue;
      // Slice 7+ will call resolveTransportSecrets here. Until then, cast to
      // PodMcpServerConfig — safe after the Slice 2 migration runs (no plain
      // tokens remain in the DB; SecretRefs are opaque to the spawn path until
      // injection is wired in Slice 7).
      // wrapStdioCwd: if the stored transport has a `cwd`, transform it into a
      // shell cd-wrapper (CC ignores a bare cwd field on stdio mcp.json entries).
      servers[row.name] = wrapStdioCwd(row.transport as unknown as PodMcpServerConfig);
      const selected = att.enabledTools === '*' ? (row.discoveredTools ?? []) : att.enabledTools;
      catalog[row.name] = selected.map((t) => qualifyMcpToolName(row.name, t));
    }
    // pc-pty-chat-451 — auto-include project-scoped servers for the orchestrator.
    // Project-registered servers that are NOT explicitly attached are merged in
    // with '*' semantics (discoveredTools ?? []). Explicit attachments take
    // precedence: any server name already wired above is skipped here.
    if (opts.includeProjectServers && spawnProjectId) {
      const projectServers = listMcpServersRegistry({ projectId: spawnProjectId });
      for (const row of projectServers) {
        // Attachment wins — skip if already present from the attachment loop.
        if (row.name in servers) continue;
        servers[row.name] = wrapStdioCwd(row.transport as unknown as PodMcpServerConfig);
        catalog[row.name] = (row.discoveredTools ?? []).map((t) => qualifyMcpToolName(row.name, t));
      }
    }
  } catch {
    // Non-fatal: never block spawn because the registry is unavailable.
  }
  return { servers, catalog };
}
