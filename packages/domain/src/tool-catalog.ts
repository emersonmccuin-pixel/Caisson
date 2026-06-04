// Shared tool catalog — friendly labels + descriptions of every tool an agent
// can be granted in its allowlist.
//
// Two consumers:
//   1. Web UI (17d-v2 multi-select) — renders friendly label + dim slug +
//      description in the Settings tab tool picker.
//   2. MCP layer (17b agent-designer + orchestrator conversational tool
//      picks) — surfaces options by friendly name instead of raw slug.
//
// Entries are grouped by `source`. CC built-ins + the pc-rig server are
// always-on. Per-pod MCP servers added by the user fall through with a
// graceful `<slug>` rendering (no friendly name) until they're cataloged.
//
// Slice 016 — the `pc-rig` partition now DERIVES from PC_RIG_TOOL_REGISTRY
// (@pc/domain tool-registry.ts): the single ordered source of every pc-rig tool.
// Its `label` + `catalogDescription` feed each derived entry. The `cc-builtin`
// + `mcp-server` partitions and REQUIRED_AGENT_TOOLS stay hand-authored.

import { PC_RIG_TOOL_REGISTRY } from './tool-registry.ts';

export type ToolCatalogSource = 'cc-builtin' | 'pc-rig' | 'mcp-server';

export interface ToolCatalogEntry {
  /** Wire slug — what gets written into the agent's tools allowlist. */
  slug: string;
  /** Short human-facing label. Sentence case, no period. */
  label: string;
  /** One-line description. Renders as help text under the label. */
  description: string;
  /** Where this tool comes from. Drives partitioning in the UI picker. */
  source: ToolCatalogSource;
  /** For `mcp-server` entries only — names the server (used for wildcards). */
  serverName?: string;
}

/** Hand-authored CC built-in entries. Always-on; not part of the pc-rig
 *  registry. `AskUserQuestion` is granted to the workflow-builder pod. */
const CC_BUILTIN_ENTRIES: ToolCatalogEntry[] = [
  {
    slug: 'Read',
    label: 'Read files',
    description: "Read text files from the project's worktree.",
    source: 'cc-builtin',
  },
  {
    slug: 'Glob',
    label: 'Find files by pattern',
    description: 'Find files matching a glob like **/*.ts.',
    source: 'cc-builtin',
  },
  {
    slug: 'Grep',
    label: 'Search file contents',
    description: 'Search file contents with regex (ripgrep-backed).',
    source: 'cc-builtin',
  },
  {
    slug: 'Edit',
    label: 'Edit files',
    description: 'Modify existing files in the worktree.',
    source: 'cc-builtin',
  },
  {
    slug: 'Write',
    label: 'Write new files',
    description: 'Create new files in the worktree.',
    source: 'cc-builtin',
  },
  {
    slug: 'Bash',
    label: 'Run shell commands',
    description: 'Execute arbitrary bash/shell commands.',
    source: 'cc-builtin',
  },
  {
    slug: 'Task',
    label: 'Spawn sub-agents (Task tool)',
    description: "Use CC's built-in Task tool to spawn sub-agents.",
    source: 'cc-builtin',
  },
  {
    slug: 'WebFetch',
    label: 'Fetch a URL',
    description: 'Fetch a single web page or API endpoint.',
    source: 'cc-builtin',
  },
  {
    slug: 'WebSearch',
    label: 'Search the web',
    description: 'Run a web search query.',
    source: 'cc-builtin',
  },
  {
    slug: 'AskUserQuestion',
    label: 'Ask the user a question (CC built-in)',
    description: 'CC built-in: pause and surface a question to the user during a workflow-builder session.',
    source: 'cc-builtin',
  },
];

/** Slice 016 — the pc-rig partition DERIVED from the canonical registry, in
 *  registry (= ListTools) order. label + catalogDescription come straight from
 *  the registry record; the slug is the `mcp__pc-rig__` prefix + bare name. */
const PC_RIG_ENTRIES: ToolCatalogEntry[] = PC_RIG_TOOL_REGISTRY.map((d) => ({
  slug: `mcp__pc-rig__${d.name}`,
  label: d.label,
  description: d.catalogDescription,
  source: 'pc-rig',
}));

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  ...CC_BUILTIN_ENTRIES,
  ...PC_RIG_ENTRIES,
];

const BY_SLUG = new Map(TOOL_CATALOG.map((e) => [e.slug, e]));

/** Tools every dispatched agent ALWAYS has. Contract-first (slice 021): an
 *  agent works against a CONTRACT, so the required set is the contract loop —
 *  `pc_get_work_item` to read any linked work item that carries the source
 *  material, and `pc_submit_deliverable` to submit the typed, verified output
 *  (the completion condition — replaces the old "write the WI body and end your
 *  turn" model). The WI-WRITE tools (`pc_update_work_item` /
 *  `pc_attach_to_work_item`) are NO LONGER forced — landing output on a work
 *  item is optional, only when the dispatch has an output-home work item, so a
 *  pod opts into those per its job. `pc_ask_orchestrator` stays required: any
 *  agent that hits ambiguity must be able to escalate (one door — the
 *  orchestrator answers or relays to the human; FD-6).
 *
 *  Enforcement is layered:
 *    1. `createAgent` + `updateAgent` repos union-merge these into the row's
 *       `tools` so the DB reflects truth.
 *    2. `materializePod` re-unions at spawn time as the load-bearing safety
 *       net — even a hand-edited row that dropped them gets them back in the
 *       rendered `.claude/agents/<name>.md`.
 *    3. Stock pod seeds list them explicitly for diff visibility.
 *  Any one layer is sufficient; together they make removal accidental-only. */
export const REQUIRED_AGENT_TOOLS: readonly string[] = [
  'mcp__pc-rig__pc_get_work_item',
  'mcp__pc-rig__pc_submit_deliverable',
  // THE one escalation door (FD-6, M7): any dispatched worker that hits trouble
  // asks the orchestrator, which answers from project context or takes the
  // question to the human in chat and relays. ☠ pc_ask_user deleted — agents
  // never ask the human directly. A custom pod can no longer silently lose the
  // ability to ask for help. Conversational / passthrough pods receive this via
  // the force-merge too, but their prompts forbid use and the tool hard-errors
  // there (no PC_AGENT_* env); exempting those pods from the merge stays a
  // noted future item.
  'mcp__pc-rig__pc_ask_orchestrator',
  // M5 (FD-5 addendum + dispatch-payload audit) — the agent can READ ITS JOB:
  // its own contract incl. the acceptance criteria it's verified against, and
  // the work-item attachments the dispatch prompt points it at (the audit's
  // 🔴: agents were DIRECTED to use attachments no tool could fetch).
  'mcp__pc-rig__pc_get_contract',
  'mcp__pc-rig__pc_list_attachments',
  'mcp__pc-rig__pc_get_attachment',
] as const;

/** Union the required WI tools into an arbitrary tools list. Preserves order
 *  for non-required entries (callers may rely on UI display order); appends
 *  any missing required tools at the tail. Idempotent. */
export function mergeRequiredAgentTools(tools: readonly string[]): string[] {
  const seen = new Set(tools);
  const out: string[] = [...tools];
  for (const required of REQUIRED_AGENT_TOOLS) {
    if (!seen.has(required)) out.push(required);
  }
  return out;
}

/** Friendly label for a slug, or the slug itself if not cataloged. */
export function friendlyName(slug: string): string {
  return BY_SLUG.get(slug)?.label ?? slug;
}

/** One-line description for a slug, or null if not cataloged. */
export function descriptionOf(slug: string): string | null {
  return BY_SLUG.get(slug)?.description ?? null;
}

/** Full entry, or null. */
export function lookupTool(slug: string): ToolCatalogEntry | null {
  return BY_SLUG.get(slug) ?? null;
}
