import type { ToolContext, ToolResult } from './context.ts';

export const CREATE_AGENT_TOOL = {
  name: 'pc_create_agent',
  description:
    "Create a NEW agent pod (DB-resident). Returns the new pod row with its ULID id. Defaults to scope='project' (pod is owned by the current project — set via PC_PROJECT_ID). Pass scope='global' only when the user explicitly says this agent should be reusable across every project. Use this for fresh agent design — the user said 'build me an agent that does X'. For structural design from scratch you should usually dispatch agent-designer first (pc_invoke_agent agent='agent-designer') so the design conversation happens in its specialised pod; call pc_create_agent directly only for trivial extractors / utilities or when continuing a design conversation. Stock-pod names (orchestrator/researcher/writer/code-writer/reviewer/planner/extractor/agent-designer) are reserved — 400 if name collides with a global. Broadcasts pod-changed on success.",
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'lowercase kebab-case agent name (letters/numbers/dashes)' },
      scope: {
        type: 'string',
        enum: ['project', 'global'],
        description: "scope. Default 'project' — pod is owned by the current project. Use 'global' only when the user explicitly wants the pod reusable across every project.",
      },
      prompt: { type: 'string', description: "the agent's system prompt body (markdown)" },
      description: { type: 'string', description: 'one-line description for the dispatch picker' },
      model: { type: 'string', description: "model slug (e.g. 'opus' / 'sonnet' / 'haiku')" },
      effort: { type: 'string', description: 'reasoning effort: low / medium / high / xhigh / max' },
      maxTurns: { type: 'integer', description: 'optional cap on the number of conversation turns' },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: "allowlist of tool slugs (e.g. ['Read','Grep','mcp__pc-rig__pc_get_work_item']). Empty = inherit all.",
      },
      outputDestination: {
        type: 'string',
        description: "where the agent's output goes (per AgentOutputDestination enum)",
      },
    },
    required: ['name'],
  },
} as const;

export const GET_AGENT_TOOL = {
  name: 'pc_get_agent',
  description:
    "Fetch the full pod bundle for an agent: prompt + knowledge docs + secret env-var names (NEVER values) + MCP servers + scalar settings. Use when you need to read an agent's current configuration before recommending a change, answering 'what does <agent> know about X?', or auditing a pod's setup. Accepts either { id } (ULID) or { name } (resolved to id via list lookup).",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'pod ULID id (mutually exclusive with name)' },
      name: { type: 'string', description: 'pod name (looked up if id absent)' },
    },
  },
} as const;

export const UPDATE_AGENT_PROMPT_TOOL = {
  name: 'pc_update_agent_prompt',
  description:
    "Replace an agent's system prompt body. Most-used edit path: 'make orchestrator terser', 'teach researcher to cite sources'. Audits as actor='orchestrator'. Stock-pod prompts (orchestrator/researcher/...) are editable — be deliberate; danger-zone editing in the UI is gated for a reason. Accepts either { id } or { name }. Triggers restart-on-edit for any live session.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'pod ULID id (mutually exclusive with name)' },
      name: { type: 'string', description: 'pod name (looked up if id absent)' },
      prompt: { type: 'string', description: 'the new system prompt body (markdown)' },
      reason: { type: 'string', description: 'optional one-line audit reason' },
    },
    required: ['prompt'],
  },
} as const;

export const UPDATE_AGENT_SETTINGS_TOOL = {
  name: 'pc_update_agent_settings',
  description:
    "Update an agent's scalar settings: model, effort, maxTurns, tools, outputDestination, description, or name. Pass only the fields you want to change. For prompt edits use pc_update_agent_prompt instead. Audits as actor='orchestrator'; multi-field updates audit under a shared change-set. Accepts either { id } or { name }.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'pod ULID id (mutually exclusive with name)' },
      name: { type: 'string', description: 'pod name (looked up if id absent)' },
      newName: { type: 'string', description: 'rename (lowercase kebab-case)' },
      description: { type: 'string', description: 'new one-line description' },
      model: { type: 'string' },
      effort: { type: 'string', description: 'low / medium / high / xhigh / max' },
      maxTurns: { type: 'integer' },
      tools: { type: 'array', items: { type: 'string' } },
      outputDestination: { type: 'string' },
      reason: { type: 'string', description: 'optional one-line audit reason' },
    },
  },
} as const;

export const DELETE_AGENT_TOOL = {
  name: 'pc_delete_agent',
  description:
    "Soft-delete an agent pod. Stock pods (orchestrator/researcher/writer/code-writer/reviewer/planner/extractor/agent-designer) are NOT deletable — returns 409. The pod can be restored via the History tab. Audits as actor='orchestrator'. Accepts either { id } or { name }.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'pod ULID id (mutually exclusive with name)' },
      name: { type: 'string', description: 'pod name (looked up if id absent)' },
      reason: { type: 'string', description: 'optional one-line audit reason' },
    },
  },
} as const;

export const CREATE_KNOWLEDGE_TOOL = {
  name: 'pc_create_knowledge',
  description:
    "Attach a knowledge document to an agent (reference material the agent can read at runtime via pc_knowledge_read). Low-friction add path: paste the content, omit the docName and we'll auto-derive from the first markdown heading or first non-empty line. Use this when the user says 'teach <agent> about <topic>: …'. Accepts either { agentId } or { agentName }. Audits as actor='orchestrator'. Returns the new knowledge row including its id.",
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'pod ULID id (mutually exclusive with agentName)' },
      agentName: { type: 'string', description: 'pod name (looked up if agentId absent)' },
      content: { type: 'string', description: 'document body (markdown / plain text)' },
      docName: {
        type: 'string',
        description: 'optional doc name — auto-derived from H1 / first line if omitted',
      },
      reason: { type: 'string', description: 'optional one-line audit reason' },
    },
    required: ['content'],
  },
} as const;

export const UPDATE_KNOWLEDGE_TOOL = {
  name: 'pc_update_knowledge',
  description:
    "Wholesale-replace a knowledge document's content (and optionally its name). The prior version is preserved in the audit log for revert. Use for 'the pricing tiers changed — update <agent>'s pricing doc: …'. Audits as actor='orchestrator'. Accepts either { agentId } or { agentName } plus { knowledgeId }.",
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'pod ULID id (mutually exclusive with agentName)' },
      agentName: { type: 'string', description: 'pod name (looked up if agentId absent)' },
      knowledgeId: { type: 'string', description: 'knowledge doc ULID id' },
      content: { type: 'string', description: 'new document body' },
      docName: { type: 'string', description: 'optional rename' },
      reason: { type: 'string', description: 'optional one-line audit reason' },
    },
    required: ['knowledgeId'],
  },
} as const;

export const DELETE_KNOWLEDGE_TOOL = {
  name: 'pc_delete_knowledge',
  description:
    "Remove a knowledge document from an agent. Audits as actor='orchestrator'. Accepts either { agentId } or { agentName } plus { knowledgeId }.",
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'pod ULID id (mutually exclusive with agentName)' },
      agentName: { type: 'string', description: 'pod name (looked up if agentId absent)' },
      knowledgeId: { type: 'string', description: 'knowledge doc ULID id' },
      reason: { type: 'string', description: 'optional one-line audit reason' },
    },
    required: ['knowledgeId'],
  },
} as const;

export const KNOWLEDGE_READ_TOOL = {
  name: 'pc_knowledge_read',
  description:
    "Read a single knowledge document's full content by id. Worker agents call this at runtime to pull reference material (the agent's spawn-time prompt lists available docs + their ids). The orchestrator uses it to surface knowledge content inline ('what does <agent> know about <topic>?'). Accepts either { agentId } or { agentName } plus { knowledgeId }.",
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'pod ULID id (mutually exclusive with agentName)' },
      agentName: { type: 'string', description: 'pod name (looked up if agentId absent)' },
      knowledgeId: { type: 'string', description: 'knowledge doc ULID id' },
    },
    required: ['knowledgeId'],
  },
} as const;

export const CREATE_AGENT_SECRET_TOOL = {
  name: 'pc_create_agent_secret',
  description:
    "Attach a plaintext env-var secret to an agent. The value is stored in plain text in v1 (encryption lands in v2) — the user has been warned via the UI banner. Pod gets `envVarName=value` materialised into its environment at spawn. Use for things like API keys / tokens needed by per-pod MCP servers. Audits event-only (value never logged). Accepts either { agentId } or { agentName }.",
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'pod ULID id (mutually exclusive with agentName)' },
      agentName: { type: 'string', description: 'pod name (looked up if agentId absent)' },
      envVarName: { type: 'string', description: 'environment variable name (e.g. GMAIL_TOKEN)' },
      valuePlaintext: { type: 'string', description: 'secret value (stored plaintext in v1)' },
      reason: { type: 'string', description: 'optional one-line audit reason' },
    },
    required: ['envVarName', 'valuePlaintext'],
  },
} as const;

export const DELETE_AGENT_SECRET_TOOL = {
  name: 'pc_delete_agent_secret',
  description:
    "Detach a secret env-var from an agent. Audits as actor='orchestrator'. Accepts either { agentId } or { agentName } plus { secretId }.",
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'pod ULID id (mutually exclusive with agentName)' },
      agentName: { type: 'string', description: 'pod name (looked up if agentId absent)' },
      secretId: { type: 'string', description: 'secret ULID id' },
      reason: { type: 'string', description: 'optional one-line audit reason' },
    },
    required: ['secretId'],
  },
} as const;

export const ADD_AGENT_MCP_SERVER_TOOL = {
  name: 'pc_add_agent_mcp_server',
  description:
    "Configure a per-pod MCP server (e.g. gmail, jira, custom). The pod's materialised mcp.json will merge this server into the baseline at spawn time; pod entry wins per-server-name. Pass the standard MCP config shape: { command, args, env } OR { url } (for HTTP transports). Accepts either { agentId } or { agentName }.",
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'pod ULID id (mutually exclusive with agentName)' },
      agentName: { type: 'string', description: 'pod name (looked up if agentId absent)' },
      serverName: { type: 'string', description: 'MCP server name (e.g. "gmail")' },
      config: {
        type: 'object',
        description: 'MCP server config: { command, args?, env? } or { url }',
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          env: { type: 'object', additionalProperties: { type: 'string' } },
          url: { type: 'string' },
        },
      },
      reason: { type: 'string', description: 'optional one-line audit reason' },
    },
    required: ['serverName', 'config'],
  },
} as const;

export const DELETE_AGENT_MCP_SERVER_TOOL = {
  name: 'pc_delete_agent_mcp_server',
  description:
    "Detach a per-pod MCP server. Audits as actor='orchestrator'. Accepts either { agentId } or { agentName } plus { mcpServerId }.",
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'pod ULID id (mutually exclusive with agentName)' },
      agentName: { type: 'string', description: 'pod name (looked up if agentId absent)' },
      mcpServerId: { type: 'string', description: 'MCP server row ULID id' },
      reason: { type: 'string', description: 'optional one-line audit reason' },
    },
    required: ['mcpServerId'],
  },
} as const;

export const LIST_AGENT_AUDIT_TOOL = {
  name: 'pc_list_agent_audit',
  description:
    "Read an agent's change history. Returns audit rows newest-first. Filter by actor ('orchestrator' / 'user'), field ('prompt' / 'model' / 'effort' / 'tools' / 'description' / 'name' / 'maxTurns' / 'outputDestination' / 'knowledge' / 'secret' / 'mcp-server'), limit (default 50), beforeCreatedAt (epoch ms — for paging). Use when reasoning about 'why does this agent behave this way?' or auditing recent changes. Accepts either { agentId } or { agentName }.",
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'pod ULID id (mutually exclusive with agentName)' },
      agentName: { type: 'string', description: 'pod name (looked up if agentId absent)' },
      actor: { type: 'string', description: "filter by actor ('orchestrator' / 'user')" },
      field: { type: 'string', description: 'filter by audit field key' },
      limit: { type: 'integer', description: 'max rows returned (default 50)' },
      beforeCreatedAt: {
        type: 'integer',
        description: 'page boundary (epoch ms); rows older than this',
      },
    },
  },
} as const;

export const LIST_AGENTS_TOOL = {
  name: 'pc_list_agents',
  description:
    'List available agents for this project. Returns global pods plus project overrides/project-only pods. Use before pc_invoke_agent when deciding which specialist to delegate to.',
  inputSchema: { type: 'object', properties: {} },
} as const;

export const AGENT_MANAGEMENT_TOOLS = [
  CREATE_AGENT_TOOL,
  GET_AGENT_TOOL,
  UPDATE_AGENT_PROMPT_TOOL,
  UPDATE_AGENT_SETTINGS_TOOL,
  DELETE_AGENT_TOOL,
  CREATE_KNOWLEDGE_TOOL,
  UPDATE_KNOWLEDGE_TOOL,
  DELETE_KNOWLEDGE_TOOL,
  KNOWLEDGE_READ_TOOL,
  CREATE_AGENT_SECRET_TOOL,
  DELETE_AGENT_SECRET_TOOL,
  ADD_AGENT_MCP_SERVER_TOOL,
  DELETE_AGENT_MCP_SERVER_TOOL,
  LIST_AGENT_AUDIT_TOOL,
] as const;

export const AGENT_TOOLS = [...AGENT_MANAGEMENT_TOOLS, LIST_AGENTS_TOOL] as const;

export const AGENT_TOOL_NAMES = AGENT_TOOLS.map((tool) => tool.name);

/** Project a ResolvedAgent (web-UI-shaped) down to a slim listing entry.
 *  Falls through to the original body string on any parse / shape mismatch
 *  so a server-side response change can't crash the tool. */
function slimAgentList(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      ok?: unknown;
      globals?: unknown;
      overrides?: unknown;
      projectOnly?: unknown;
      [k: string]: unknown;
    };
    const slimOne = (entry: unknown) => {
      if (!entry || typeof entry !== 'object') return entry;
      const r = entry as Record<string, unknown>;
      const def = (r.def && typeof r.def === 'object' ? r.def : {}) as Record<string, unknown>;
      const out: Record<string, unknown> = {
        name: typeof r.name === 'string' ? r.name : def.name,
      };
      if (typeof def.description === 'string') out.description = def.description;
      if (typeof def.model === 'string') out.model = def.model;
      if (Array.isArray(def.tools) && def.tools.length > 0) out.tools = def.tools;
      return out;
    };
    const slimArr = (v: unknown) => (Array.isArray(v) ? v.map(slimOne) : v);
    return JSON.stringify({
      ...parsed,
      globals: slimArr(parsed.globals),
      overrides: slimArr(parsed.overrides),
      projectOnly: slimArr(parsed.projectOnly),
    });
  } catch {
    return body;
  }
}

/** Knowledge / secret / mcp-server tools accept { agentId } / { agentName }
 *  while agent tools use { id } / { name }. Adapt the former to the shape
 *  resolvePodId expects. */
function agentArgs(args: Record<string, unknown>): Record<string, unknown> {
  return {
    id: args.agentId,
    name: args.agentName,
  };
}

/** Auto-derive a knowledge-doc name from the content body. Priority: first
 *  H1 (`# Heading`) → first non-empty line → fallback to a timestamp slug.
 *  Whitespace trimmed; capped at 64 chars; kebab-cased. */
function deriveKnowledgeName(content: string): string {
  const lines = content.split(/\r?\n/);
  let candidate = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      candidate = line.replace(/^#+\s*/, '').trim();
    } else {
      candidate = line;
    }
    if (candidate) break;
  }
  if (!candidate) {
    return `knowledge-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  }
  const slug = candidate
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || `knowledge-${Date.now()}`;
}

/** Resolve a pod by either { id } or { name }. Name lookup hits the global
 *  list endpoint. Used by every pc_*_agent / pc_*_knowledge MCP tool so the
 *  orchestrator can refer to pods by their human name without needing to
 *  juggle ULIDs across turns. */
async function resolvePodId(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (typeof args.id === 'string' && args.id.trim().length > 0) {
    return { ok: true, id: args.id.trim() };
  }
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) {
    return { ok: false, error: 'either id or name required' };
  }
  const res = await ctx.getServer('/api/agents/pods');
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, error: `pod-list lookup failed (${res.status}): ${res.body}` };
  }
  try {
    const parsed = JSON.parse(res.body) as { pods?: Array<{ id: string; name: string }> };
    const pod = (parsed.pods ?? []).find((p) => p.name === name);
    if (!pod) return { ok: false, error: `no pod named '${name}'` };
    return { ok: true, id: pod.id };
  } catch (err) {
    return { ok: false, error: `pod-list parse failed: ${(err as Error).message}` };
  }
}

// Slice 011 (11E) — pod-CRUD responses are LEFT RAW. `@pc/contracts/pods.ts`
// only models pod live-events (PodChanged*), not the pod-CRUD HTTP response
// bodies (create/get/update/delete pod, knowledge, secret, mcp-server, audit,
// list). Adding a pod-response DTO to @pc/contracts is a STOP-and-confirm per
// the plan §16, so these handlers keep emitting the raw res.body via the
// existing ctx.* helpers — byte-identical, no typed-client seam.
export async function handleAgentTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case 'pc_create_agent': {
      const agentName = typeof args.name === 'string' ? args.name.trim() : '';
      if (!agentName) {
        return { content: [{ type: 'text', text: 'pc_create_agent: name required' }], isError: true };
      }
      const scope = args.scope === 'global' ? 'global' : 'project';
      if (scope === 'project' && !ctx.projectId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_create_agent: scope="project" but PC_PROJECT_ID is not set — pass scope="global" if you really want a global pod, or call from inside a project context.',
            },
          ],
          isError: true,
        };
      }
      try {
        const payload: Record<string, unknown> = {
          name: agentName,
          scope,
          ...(scope === 'project' ? { projectId: ctx.projectId } : {}),
          actor: 'orchestrator',
          reason: 'mcp-create',
        };
        if (typeof args.prompt === 'string') payload.prompt = args.prompt;
        if (typeof args.description === 'string') payload.description = args.description;
        if (typeof args.model === 'string') payload.model = args.model;
        if (typeof args.effort === 'string') payload.effort = args.effort;
        if (typeof args.maxTurns === 'number') payload.maxTurns = args.maxTurns;
        if (Array.isArray(args.tools)) payload.tools = args.tools;
        if (typeof args.outputDestination === 'string') {
          payload.outputDestination = args.outputDestination;
        }
        const res = await ctx.postServer('/api/agents/pods', payload);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_create_agent failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_create_agent failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_get_agent': {
      try {
        const id = await resolvePodId(args, ctx);
        if (!id.ok) {
          return { content: [{ type: 'text', text: `pc_get_agent: ${id.error}` }], isError: true };
        }
        const res = await ctx.getServer(`/api/agents/pods/${encodeURIComponent(id.id)}`);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_get_agent failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_get_agent failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_update_agent_prompt': {
      const prompt = typeof args.prompt === 'string' ? args.prompt : '';
      if (typeof args.prompt !== 'string') {
        return {
          content: [{ type: 'text', text: 'pc_update_agent_prompt: prompt required (string)' }],
          isError: true,
        };
      }
      try {
        const id = await resolvePodId(args, ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_update_agent_prompt: ${id.error}` }],
            isError: true,
          };
        }
        const payload: Record<string, unknown> = {
          prompt,
          actor: 'orchestrator',
          reason: typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-edit-prompt',
        };
        const res = await ctx.patchServer(`/api/agents/pods/${encodeURIComponent(id.id)}`, payload);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_update_agent_prompt failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_update_agent_prompt failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_update_agent_settings': {
      try {
        const id = await resolvePodId(args, ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_update_agent_settings: ${id.error}` }],
            isError: true,
          };
        }
        const payload: Record<string, unknown> = {
          actor: 'orchestrator',
          reason: typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-edit-settings',
        };
        if (typeof args.newName === 'string') payload.name = args.newName.trim();
        if (typeof args.description === 'string') payload.description = args.description;
        if (typeof args.model === 'string') payload.model = args.model;
        if (typeof args.effort === 'string') payload.effort = args.effort;
        if (typeof args.maxTurns === 'number') payload.maxTurns = args.maxTurns;
        if (Array.isArray(args.tools)) payload.tools = args.tools;
        if (typeof args.outputDestination === 'string') {
          payload.outputDestination = args.outputDestination;
        }
        // Body must contain at least one mutating field — the `actor` + `reason`
        // alone produces a no-op update.
        const fieldKeys = Object.keys(payload).filter(
          (k) => k !== 'actor' && k !== 'reason',
        );
        if (fieldKeys.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'pc_update_agent_settings: at least one setting field required (newName / description / model / effort / maxTurns / tools / outputDestination)',
              },
            ],
            isError: true,
          };
        }
        const res = await ctx.patchServer(`/api/agents/pods/${encodeURIComponent(id.id)}`, payload);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_update_agent_settings failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_update_agent_settings failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_delete_agent': {
      try {
        const id = await resolvePodId(args, ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_delete_agent: ${id.error}` }],
            isError: true,
          };
        }
        const reason =
          typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-delete';
        const qs = `actor=orchestrator&reason=${encodeURIComponent(reason)}`;
        const res = await ctx.deleteServer(`/api/agents/pods/${encodeURIComponent(id.id)}?${qs}`);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_delete_agent failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_delete_agent failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_create_knowledge': {
      const content = typeof args.content === 'string' ? args.content : '';
      if (typeof args.content !== 'string') {
        return {
          content: [{ type: 'text', text: 'pc_create_knowledge: content required (string)' }],
          isError: true,
        };
      }
      const explicitName =
        typeof args.docName === 'string' && args.docName.trim().length > 0
          ? args.docName.trim()
          : null;
      const docName = explicitName ?? deriveKnowledgeName(content);
      try {
        const id = await resolvePodId(agentArgs(args), ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_create_knowledge: ${id.error}` }],
            isError: true,
          };
        }
        const payload: Record<string, unknown> = {
          name: docName,
          content,
          actor: 'orchestrator',
          reason: typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-create-knowledge',
        };
        const res = await ctx.postServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/knowledge`,
          payload,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_create_knowledge failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_create_knowledge failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_update_knowledge': {
      const knowledgeId = typeof args.knowledgeId === 'string' ? args.knowledgeId.trim() : '';
      if (!knowledgeId) {
        return {
          content: [{ type: 'text', text: 'pc_update_knowledge: knowledgeId required' }],
          isError: true,
        };
      }
      try {
        const id = await resolvePodId(agentArgs(args), ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_update_knowledge: ${id.error}` }],
            isError: true,
          };
        }
        const payload: Record<string, unknown> = {
          actor: 'orchestrator',
          reason: typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-edit-knowledge',
        };
        if (typeof args.content === 'string') payload.content = args.content;
        if (typeof args.docName === 'string') payload.name = args.docName.trim();
        const fieldKeys = Object.keys(payload).filter(
          (k) => k !== 'actor' && k !== 'reason',
        );
        if (fieldKeys.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'pc_update_knowledge: at least one of { content, docName } required',
              },
            ],
            isError: true,
          };
        }
        const res = await ctx.patchServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/knowledge/${encodeURIComponent(knowledgeId)}`,
          payload,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_update_knowledge failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_update_knowledge failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_delete_knowledge': {
      const knowledgeId = typeof args.knowledgeId === 'string' ? args.knowledgeId.trim() : '';
      if (!knowledgeId) {
        return {
          content: [{ type: 'text', text: 'pc_delete_knowledge: knowledgeId required' }],
          isError: true,
        };
      }
      try {
        const id = await resolvePodId(agentArgs(args), ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_delete_knowledge: ${id.error}` }],
            isError: true,
          };
        }
        const reason =
          typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-delete-knowledge';
        const qs = `actor=orchestrator&reason=${encodeURIComponent(reason)}`;
        const res = await ctx.deleteServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/knowledge/${encodeURIComponent(knowledgeId)}?${qs}`,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_delete_knowledge failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_delete_knowledge failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_knowledge_read': {
      const knowledgeId = typeof args.knowledgeId === 'string' ? args.knowledgeId.trim() : '';
      if (!knowledgeId) {
        return {
          content: [{ type: 'text', text: 'pc_knowledge_read: knowledgeId required' }],
          isError: true,
        };
      }
      try {
        const id = await resolvePodId(agentArgs(args), ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_knowledge_read: ${id.error}` }],
            isError: true,
          };
        }
        const res = await ctx.getServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/knowledge/${encodeURIComponent(knowledgeId)}`,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_knowledge_read failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_knowledge_read failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_create_agent_secret': {
      const envVarName = typeof args.envVarName === 'string' ? args.envVarName.trim() : '';
      const valuePlaintext = typeof args.valuePlaintext === 'string' ? args.valuePlaintext : '';
      if (!envVarName) {
        return {
          content: [{ type: 'text', text: 'pc_create_agent_secret: envVarName required' }],
          isError: true,
        };
      }
      if (typeof args.valuePlaintext !== 'string') {
        return {
          content: [
            { type: 'text', text: 'pc_create_agent_secret: valuePlaintext required (string)' },
          ],
          isError: true,
        };
      }
      try {
        const id = await resolvePodId(agentArgs(args), ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_create_agent_secret: ${id.error}` }],
            isError: true,
          };
        }
        const payload: Record<string, unknown> = {
          envVarName,
          valuePlaintext,
          actor: 'orchestrator',
          reason: typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-create-secret',
        };
        const res = await ctx.postServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/secrets`,
          payload,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_create_agent_secret failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_create_agent_secret failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_delete_agent_secret': {
      const secretId = typeof args.secretId === 'string' ? args.secretId.trim() : '';
      if (!secretId) {
        return {
          content: [{ type: 'text', text: 'pc_delete_agent_secret: secretId required' }],
          isError: true,
        };
      }
      try {
        const id = await resolvePodId(agentArgs(args), ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_delete_agent_secret: ${id.error}` }],
            isError: true,
          };
        }
        const reason =
          typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-delete-secret';
        const qs = `actor=orchestrator&reason=${encodeURIComponent(reason)}`;
        const res = await ctx.deleteServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/secrets/${encodeURIComponent(secretId)}?${qs}`,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_delete_agent_secret failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_delete_agent_secret failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_add_agent_mcp_server': {
      const serverName = typeof args.serverName === 'string' ? args.serverName.trim() : '';
      const config = args.config && typeof args.config === 'object' ? args.config : null;
      if (!serverName) {
        return {
          content: [{ type: 'text', text: 'pc_add_agent_mcp_server: serverName required' }],
          isError: true,
        };
      }
      if (!config) {
        return {
          content: [{ type: 'text', text: 'pc_add_agent_mcp_server: config required (object)' }],
          isError: true,
        };
      }
      try {
        const id = await resolvePodId(agentArgs(args), ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_add_agent_mcp_server: ${id.error}` }],
            isError: true,
          };
        }
        const payload: Record<string, unknown> = {
          name: serverName,
          config,
          actor: 'orchestrator',
          reason: typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-add-server',
        };
        const res = await ctx.postServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/mcp-servers`,
          payload,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_add_agent_mcp_server failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_add_agent_mcp_server failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_list_agent_audit': {
      try {
        const id = await resolvePodId(agentArgs(args), ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_list_agent_audit: ${id.error}` }],
            isError: true,
          };
        }
        const params: string[] = [];
        if (typeof args.actor === 'string' && args.actor.trim()) {
          params.push(`actor=${encodeURIComponent(args.actor.trim())}`);
        }
        if (typeof args.field === 'string' && args.field.trim()) {
          params.push(`field=${encodeURIComponent(args.field.trim())}`);
        }
        if (typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0) {
          params.push(`limit=${args.limit}`);
        }
        if (
          typeof args.beforeCreatedAt === 'number' &&
          Number.isFinite(args.beforeCreatedAt)
        ) {
          params.push(`beforeCreatedAt=${args.beforeCreatedAt}`);
        }
        const qs = params.length > 0 ? `?${params.join('&')}` : '';
        const res = await ctx.getServer(`/api/agents/pods/${encodeURIComponent(id.id)}/audit${qs}`);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_list_agent_audit failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_list_agent_audit failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_delete_agent_mcp_server': {
      const mcpServerId = typeof args.mcpServerId === 'string' ? args.mcpServerId.trim() : '';
      if (!mcpServerId) {
        return {
          content: [{ type: 'text', text: 'pc_delete_agent_mcp_server: mcpServerId required' }],
          isError: true,
        };
      }
      try {
        const id = await resolvePodId(agentArgs(args), ctx);
        if (!id.ok) {
          return {
            content: [{ type: 'text', text: `pc_delete_agent_mcp_server: ${id.error}` }],
            isError: true,
          };
        }
        const reason =
          typeof args.reason === 'string' && args.reason.trim().length > 0
            ? args.reason.trim()
            : 'mcp-delete-server';
        const qs = `actor=orchestrator&reason=${encodeURIComponent(reason)}`;
        const res = await ctx.deleteServer(
          `/api/agents/pods/${encodeURIComponent(id.id)}/mcp-servers/${encodeURIComponent(mcpServerId)}?${qs}`,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            {
              type: 'text',
              text: `pc_delete_agent_mcp_server failed (${res.status}): ${res.body}`,
            },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: `pc_delete_agent_mcp_server failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case 'pc_list_agents': {
      try {
        const res = await ctx.getServer(ctx.projectPath('agents'));
        if (res.status >= 200 && res.status < 300) {
          // Route returns ResolvedAgent[] shaped for the web UI's agent
          // editor (`body` + `markdown` each carry the entire prompt;
          // `def.name` duplicates the top-level `name`). For MCP callers
          // the only useful fields are name + description + a couple of
          // hints for picking an agent — slim it before returning so a
          // 10-pod project doesn't ship 90k chars into the caller's
          // context every call.
          const slim = slimAgentList(res.body);
          return { content: [{ type: 'text', text: slim }] };
        }
        return {
          content: [{ type: 'text', text: `pc_list_agents failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_list_agents failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    default:
      return null;
  }
}
