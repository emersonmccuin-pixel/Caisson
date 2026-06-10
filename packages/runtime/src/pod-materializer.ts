// Section 17a.3 — Pod materialisation writer.
//
// Reads a `PodSpawnBundle` (from getPodForSpawn) and writes the on-disk
// shape claude.exe consumes:
//   - `<worktree>/.claude/agents/<name>.md` (frontmatter + prompt body)
//   - a temp `mcp.json` (pod-declared MCP servers, merged on top of a caller-
//     supplied baseline like PC's pc-rig server)
// Returns the env-var map built from the pod's secrets — caller folds it into
// the spawn env.
//
// Wildcard tool expansion is PC-side: claude.exe's `tools:` frontmatter is
// exact-name match only, so `mcp__<server>__*` is expanded to the explicit
// per-tool list from the supplied `mcpToolCatalog`. Pattern targeting an
// unknown server throws — pod creators must either declare the explicit names
// or supply a matching catalog entry.
//
// Scope: pure data → files + envs. Spawn lifecycle (kill / restart / `--resume`
// on pod edit) is the 16b deliverable; wiring `materializePod` into PC's
// orchestrator + subagent spawn paths is 17a.5.
//
// Reference shape: `pod-validation/harness/materialize.ts` +
// `harness/pc-rig-tools.ts`. The harness validated this exact contract against
// real claude.exe (8 contract scenarios + 1 full-fidelity orchestrator run).

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  ExpectedOutput,
  PodAgentRow,
  PodKnowledgeRow,
  PodMcpServerConfig,
  PodMcpServerRow,
  PodSecretRow,
  PodSpawnBundle,
} from '@pc/domain';
// PodMcpServerRow is kept for renderMcpConfig's signature (public API).
import { descriptionOf, mergeRequiredAgentTools } from '@pc/domain';

/** Contract context the dispatch forwards. `expectedOutput` is the contract's
 *  typed spec; `workItemId` is the OPTIONAL linked work item (source material /
 *  output home). When supplied, the materialiser appends a "## Your contract"
 *  section to the rendered agent .md surfacing the expected output and pointing
 *  the agent at the linked work item. The user-message input stays clean — no
 *  magic tokens in the conversation. */
export interface PodWorkItemContext {
  workItemId: string;
  expectedOutput: ExpectedOutput;
}

export interface MaterializePodOptions {
  bundle: PodSpawnBundle;
  /** Worktree root. `.claude/agents/<name>.md` lands under here. */
  worktreeDir: string;
  /** Directory the temp `mcp.json` is written to. Caller mints + creates. */
  scratchDir: string;
  /** Baseline MCP servers always included alongside the pod's own declarations.
   *  Typical use: PC's `pc-rig` server. Pod-declared rows win per-name on
   *  conflict — the pod's local override beats the baseline. */
  baselineMcpServers?: Record<string, PodMcpServerConfig>;
  /** Resolution table for `mcp__<server>__*` tool wildcards. Each key is an
   *  MCP server name; each value is the explicit tool list to expand into. */
  mcpToolCatalog?: Record<string, readonly string[]>;
  /** Optional contract context. When supplied, the rendered agent .md carries
   *  a "## Your contract" section surfacing the contract's `expected_output`
   *  and pointing the agent at the linked `workItemId` (source / output home)
   *  to read via `pc_get_work_item`. */
  workItem?: PodWorkItemContext;
  /** Section 36 — prompt variable substitution. Keys are the bare variable
   *  names (e.g. `'AVAILABLE_AGENTS'`); the materializer replaces every
   *  `{{KEY}}` occurrence in the prompt body with the supplied string before
   *  writing the .md. Unknown variables are LEFT INTACT (loud surface in the
   *  rendered prompt — never silently stripped). Caller computes DB-backed
   *  values; AVAILABLE_TOOLS is always recomputed here from the final
   *  expanded tool list. No-op when omitted. */
  variables?: Record<string, string>;
  /** Slice 1 (context model) — pre-built "## Project & area context" chain
   *  string injected between the prompt body and the "## Your contract" section.
   *  Built by `buildContextChain` in apps/server/src/services/context-chain.ts.
   *  Independent of whether a contract is present (both can arrive together).
   *  Empty/undefined → no chain section rendered. */
  contextChain?: string;
}

export interface MaterializedPod {
  agentMdPath: string;
  mcpConfigPath: string;
  envVars: Record<string, string>;
  /** Best-effort: removes the agent .md and the temp mcp.json. Caller owns
   *  `.claude/` and `scratchDir` themselves. Tolerates ENOENT. */
  cleanup(): void;
}

export interface MaterializedPluginPod extends MaterializedPod {
  /** Directory passed to Claude via `--plugin-dir`. */
  pluginDir: string;
  /** Agent name passed to Claude via `--agent`. Plugin agents are namespaced. */
  agentCliName: string;
}

export function materializePod(opts: MaterializePodOptions): MaterializedPod {
  const { bundle, worktreeDir } = opts;
  const agentMdPath = resolve(worktreeDir, '.claude', 'agents', `${bundle.agent.name}.md`);
  return materializePodFiles(opts, agentMdPath, {
    cleanupAgent: () => tryUnlink(agentMdPath),
  });
}

/** Materialize a pod as a session-local Claude plugin instead of writing
 *  `<worktree>/.claude/agents`. This is the isolated runtime path PC uses for
 *  spawns: terminal-launched Claude Code sessions in the user's repo cannot
 *  auto-discover these agent definitions. */
export function materializePodPlugin(
  opts: MaterializePodOptions & { pluginName?: string },
): MaterializedPluginPod {
  const pluginName = opts.pluginName ?? 'pc-runtime';
  const pluginDir = resolve(opts.scratchDir, 'claude-plugin');
  const agentMdPath = resolve(pluginDir, 'agents', `${opts.bundle.agent.name}.md`);
  const manifestPath = resolve(pluginDir, '.claude-plugin', 'plugin.json');
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        name: pluginName,
        version: '0.0.0',
        description: 'Project Companion session runtime',
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  const materialized = materializePodFiles(opts, agentMdPath, {
    cleanupAgent: () => rmSync(pluginDir, { recursive: true, force: true }),
  });
  return {
    ...materialized,
    pluginDir,
    agentCliName: `${pluginName}:${opts.bundle.agent.name}`,
  };
}

function materializePodFiles(
  opts: MaterializePodOptions,
  agentMdPath: string,
  cleanup: { cleanupAgent: () => void },
): MaterializedPod {
  const { bundle, scratchDir } = opts;
  const baselineMcp = opts.baselineMcpServers ?? {};
  const catalog = opts.mcpToolCatalog ?? {};

  // Load-bearing safety net — guarantee the contract-loop tools are present
  // in the spawned agent's frontmatter no matter what (read a linked work
  // item, submit the deliverable, ask the user). The repo layer already merges
  // these at create/update time, but a hand-edited row, a row from before this
  // guard shipped, or a future code path that bypasses `createAgent` would
  // otherwise yield an agent that can't fetch its source or submit its output.
  // Idempotent — duplicates from the wildcard expansion below are deduped by
  // `mergeRequiredAgentTools`.
  const expandedTools = mergeRequiredAgentTools(
    expandToolWildcards(bundle.agent.tools, catalog),
  );
  const variables = withMaterializerVariables(opts.variables, expandedTools);

  mkdirSync(dirname(agentMdPath), { recursive: true });
  writeFileSync(
    agentMdPath,
    renderAgentMd(
      bundle.agent,
      expandedTools,
      bundle.knowledge,
      opts.workItem,
      variables,
      opts.contextChain,
    ),
    'utf8',
  );

  const mcpConfigPath = resolve(scratchDir, 'mcp.json');
  mkdirSync(scratchDir, { recursive: true });
  // ☠ FD-3: the referenced-tools mcp.json filter is gone.
  // ☠ pc-pty-chat-359 P4b: inline bundle.mcpServers removed; registry-based
  //   servers arrive via baselineMcp (merged by the caller from attachments).
  writeFileSync(mcpConfigPath, renderMcpConfig([], baselineMcp), 'utf8');

  return {
    agentMdPath,
    mcpConfigPath,
    envVars: buildEnvMap(bundle.secrets),
    cleanup() {
      try {
        cleanup.cleanupAgent();
      } catch {
        /* best-effort */
      }
      tryUnlink(mcpConfigPath);
    },
  };
}

/** The MCP tool agents call to fetch a knowledge doc's full content. The
 *  materializer only emits the knowledge footer when this tool is present
 *  in the agent's expanded tool list — otherwise the footer would tell the
 *  agent to call a tool it doesn't have access to. */
const KNOWLEDGE_READ_TOOL = 'mcp__pc-rig__pc_knowledge_read';

/** Render the `.claude/agents/<name>.md` body. Frontmatter mirrors PC's
 *  flat-file agent shape: name, description, tools (comma-separated), model,
 *  effort, maxTurns. Empty/null fields are omitted.
 *
 *  When `knowledge` rows exist AND the agent has `pc_knowledge_read` in its
 *  expanded tool list, appends a "Knowledge available" footer listing each
 *  doc + its id + a short summary. Worker agents pull full content at
 *  runtime via `pc_knowledge_read`. Pods with zero knowledge docs OR pods
 *  without the read tool get no footer (the latter prevents silently telling
 *  an agent to call a tool it can't reach). */
export function renderAgentMd(
  agent: PodAgentRow,
  tools: readonly string[],
  knowledge: readonly PodKnowledgeRow[] = [],
  workItem?: PodWorkItemContext,
  variables?: Record<string, string>,
  contextChain?: string,
): string {
  const fm: string[] = ['---', `name: ${agent.name}`];
  if (agent.description.trim() !== '') fm.push(`description: ${agent.description}`);
  if (tools.length > 0) fm.push(`tools: ${tools.join(', ')}`);
  if (agent.model) fm.push(`model: ${agent.model}`);
  if (agent.effort) fm.push(`effort: ${agent.effort}`);
  if (agent.maxTurns !== null) fm.push(`maxTurns: ${agent.maxTurns}`);
  fm.push('---');
  const effectiveVariables = withMaterializerVariables(variables, tools);
  const body = substituteVariables(agent.prompt.trim(), effectiveVariables);
  // Slice 1: context chain goes between the prompt body and the contract section.
  const chainBlock = renderContextChainSection(contextChain);
  const assignment = workItem ? renderAssignment(workItem) : '';
  const canReadKnowledge = tools.includes(KNOWLEDGE_READ_TOOL);
  const footer = canReadKnowledge ? renderKnowledgeFooter(agent.id, knowledge) : '';
  const toolsFooter = agent.prompt.includes('{{AVAILABLE_TOOLS}}')
    ? ''
    : renderAvailableToolsFooter(tools);
  return `${fm.join('\n')}\n\n${body}${chainBlock}${assignment}${footer}${toolsFooter}\n`;
}

/** Emit the pre-built context chain block (between prompt body and contract).
 *  Returns `''` when there is no chain to render. */
function renderContextChainSection(chain: string | undefined): string {
  if (!chain?.trim()) return '';
  return `\n\n${chain}`;
}

/** Canonical tool-list rendering for agent prompts. This runs inside the
 *  materializer, after wildcard expansion and required-tool merging, so the
 *  prompt sees the same concrete allowlist that is written to frontmatter. */
export function renderAvailableTools(tools: readonly string[]): string {
  if (tools.length === 0) return '';
  const lines: string[] = [];
  for (const t of tools) {
    const desc = descriptionOf(t);
    lines.push(desc ? `- \`${t}\` - ${desc}` : `- \`${t}\``);
  }
  return lines.join('\n');
}

function withMaterializerVariables(
  variables: Record<string, string> | undefined,
  tools: readonly string[],
): Record<string, string> | undefined {
  if (tools.length === 0) return variables;
  return {
    ...(variables ?? {}),
    AVAILABLE_TOOLS: renderAvailableTools(tools),
  };
}

function renderAvailableToolsFooter(tools: readonly string[]): string {
  const rendered = renderAvailableTools(tools);
  if (!rendered) return '';
  return [
    '',
    '',
    '## Available tools',
    '',
    'Generated at spawn time from your actual tool allowlist after wildcard expansion. These are the tools you can call:',
    '',
    rendered,
  ].join('\n');
}

/** Section 36 — replace every `{{KEY}}` in `body` with `variables[KEY]` when
 *  the key is defined. Unknown variables are LEFT INTACT (never silently
 *  stripped) so the orchestrator sees the unresolved placeholder in chat and
 *  the user notices. Matches uppercase + underscore + digits — narrow enough
 *  to avoid colliding with conversational `{{...}}` use in prose. */
export function substituteVariables(
  body: string,
  variables: Record<string, string> | undefined,
): string {
  if (!variables) return body;
  return body.replace(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g, (match, key: string) => {
    const value = variables[key];
    return value !== undefined ? value : match;
  });
}

/** "## Your contract" section appended to the agent body when the dispatch
 *  carries a linked work item. The contract is the assignment; the work item
 *  is the linked source material / output home. Surfaces the expected_output
 *  JSON so the model can plan the shape of its deliverable, and points the
 *  agent at the linked work item to read context. */
export function renderAssignment(workItem: PodWorkItemContext): string {
  const expected = JSON.stringify(workItem.expectedOutput, null, 2);
  return [
    '',
    '',
    '## Your contract',
    '',
    `This dispatch has a contract — a machine-checked assignment with the expected output below. A work item is linked (\`${workItem.workItemId}\`) as your source material and/or output home. Read it first:`,
    '',
    '```',
    `pc_get_work_item({ id: "${workItem.workItemId}" })`,
    '```',
    '',
    "Use its `body`, `attachments`, and `parent` for context (attachments: `pc_list_attachments({ workItemId })` → `pc_get_attachment({ attachmentId })`). The expected output + what \"done\" means live on the CONTRACT, shown below — not on the work item.",
    '',
    '### Expected output',
    '',
    'The shape your contract requires:',
    '',
    '```json',
    expected,
    '```',
    '',
    'Your contract also carries the ACCEPTANCE CRITERIA your deliverable is verified against — read them with `pc_get_contract` (no arguments) and self-check before you submit.',
    '',
    'When the work is done, submit your typed deliverable with `pc_submit_deliverable` (kind matching the expected output above) as your final action. That submission — not your end-of-turn — is what gets verified.',
  ].join('\n');
}

/** Knowledge access footer appended to the rendered .md when the pod has
 *  knowledge docs. Lists ids + names + a short summary so the agent can
 *  decide which docs to read; full content is pulled at runtime via
 *  `pc_knowledge_read`. */
export function renderKnowledgeFooter(
  agentId: string,
  knowledge: readonly PodKnowledgeRow[],
): string {
  if (knowledge.length === 0) return '';
  const lines: string[] = [
    '',
    '',
    '## Knowledge available',
    '',
    `You have ${knowledge.length} reference document${knowledge.length === 1 ? '' : 's'} attached to your pod. Read any of them at runtime with:`,
    '',
    '```',
    `pc_knowledge_read({ agentId: "${agentId}", knowledgeId: "<one of the ids below>" })`,
    '```',
    '',
    'Available docs:',
    '',
  ];
  for (const doc of knowledge) {
    const summary = summariseKnowledge(doc.content);
    lines.push(`- **${doc.name}** (\`${doc.id}\`) — ${summary}`);
  }
  return lines.join('\n');
}

function summariseKnowledge(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '(empty)';
  // First non-empty / non-heading line; cap at 120 chars.
  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    return line.length > 120 ? `${line.slice(0, 117)}...` : line;
  }
  // All lines are headings; take the first
  const firstHeading = trimmed.split(/\r?\n/)[0]?.replace(/^#+\s*/, '').trim();
  return firstHeading || '(content)';
}

/** Render the temp `mcp.json` content. Pod's MCP rows merge on top of the
 *  caller-supplied baseline (pod wins per-server-name on conflict). When
 *  `referencedServers` is supplied, the final mcpServers map is filtered
 *  to only that set — used to avoid CC's strict-mcp-config fail-closed when
 *  unreferenced servers in the baseline (e.g. webhook) can't load. */
export function renderMcpConfig(
  podMcpServers: readonly PodMcpServerRow[],
  baseline: Record<string, PodMcpServerConfig>,
): string {
  const merged: Record<string, PodMcpServerConfig> = { ...baseline };
  for (const row of podMcpServers) {
    merged[row.name] = row.config;
  }
  return JSON.stringify({ mcpServers: merged }, null, 2);
}

/** Build the env-var map the spawn caller folds into the child env. v1 = plain
 *  passthrough of `valuePlaintext`; v2 will decrypt here (DPAPI). */
export function buildEnvMap(secrets: readonly PodSecretRow[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const s of secrets) env[s.envVarName] = s.valuePlaintext;
  return env;
}

/** Expand `mcp__<server>__*` patterns against the supplied catalog. Non-pattern
 *  entries pass through unchanged. Order is preserved; duplicates are deduped.
 *  Pattern targeting an unknown server throws — loud failure beats a silent
 *  `tools:` allowlist that claude.exe quietly rejects at spawn. */
export function expandToolWildcards(
  tools: readonly string[],
  catalog: Record<string, readonly string[]>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push(name);
  };
  for (const entry of tools) {
    if (entry.startsWith('mcp__') && entry.endsWith('__*')) {
      const server = entry.slice('mcp__'.length, entry.length - '__*'.length);
      const list = catalog[server];
      if (!list) {
        throw new Error(
          `expandToolWildcards: unknown MCP server "${server}" for pattern "${entry}" — ` +
            `caller must supply mcpToolCatalog[${JSON.stringify(server)}]`,
        );
      }
      for (const tool of list) push(tool);
      continue;
    }
    push(entry);
  }
  return out;
}

function tryUnlink(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort */
  }
}
