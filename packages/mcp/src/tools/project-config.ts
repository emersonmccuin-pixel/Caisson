import type { ToolContext, ToolResult } from './context.ts';

export const GET_STAGES_TOOL = {
  name: 'pc_get_stages',
  description:
    'Section 19.9 — list the project\'s stages live from the server. Use this BEFORE asking the user which stage should trigger a v2 workflow (`stage-on-entry` trigger). Returns { ok: true, stages: [{ id, name, order, isDone?, isCancelled?, isNew? }, ...] }. Stage `id` is what goes into `triggers[].stage` — never use the name. Use the flags for semantic roles. (Equivalent to `pc_list_stages`; kept under the locked Section 19 name.)',
  inputSchema: { type: 'object', properties: {} },
} as const;

export const WRITE_CLAUDE_MD_TOOL = {
  name: 'pc_write_claude_md',
  description:
    'Write the project-level CLAUDE.md from the conversational setup wizard (5.6 / D82). Overwrites the existing file. Use this as the SINGLE tool call at the end of the wizard interview, once the user confirms the preview. `content` is the full markdown body (the server does not interpolate). 400 if content is missing or empty. Broadcasts project-claude-md-changed on success so the modal can close.',
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'full CLAUDE.md markdown body (non-empty)',
      },
    },
    required: ['content'],
  },
} as const;

export const LIST_STAGES_TOOL = {
  name: 'pc_list_stages',
  description:
    'List the project\'s stages live from the server. Use this BEFORE asking the user which stage should trigger a workflow (or which stage a create/update-work-item step should target). Returns { ok: true, stages: [{ id, name, order, isDone?, isCancelled?, isNew? }, ...] }. Stage `id` is what goes into `triggers.on_enter.stage_id` — never use the name. Use `isDone` / `isCancelled` / `isNew` for semantic stage roles instead of guessing from labels. No arguments; PC_PROJECT_ID env is the implicit scope.',
  inputSchema: { type: 'object', properties: {} },
} as const;

export const LIST_FIELD_SCHEMAS_TOOL = {
  name: 'pc_list_field_schemas',
  description:
    'List the project\'s custom work-item field schemas. Use this BEFORE authoring a create-work-item / update-work-item step that sets `fields`, so the keys are real (not invented). Returns { ok: true, schemas: [{ key, label, type, options?, required, ... }, ...] }. The `key` is what goes into the step\'s `fields` object. No arguments; PC_PROJECT_ID env is the implicit scope.',
  inputSchema: { type: 'object', properties: {} },
} as const;

export const REPLACE_STAGES_TOOL = {
  name: 'pc_replace_stages',
  description:
    'Bulk-replace a project\'s stages. The server validates uniqueness, flag constraints, and in-use stage safety. When a removed stage still has work items, the server returns 409 STAGE_HAS_ITEMS with an `orphans` array — surface this to the caller instead of swallowing. Pass `force: true` + `fallbackStageId` (a retained stage id) to force-remove and reassign orphaned items. Always call `pc_request_approval` before removing, reordering, or re-flagging stages.',
  inputSchema: {
    type: 'object',
    properties: {
      stages: {
        type: 'array',
        description: 'full replacement stage list. Each stage needs id + name; order defaults to array index.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'stage slug id (e.g. "backlog")' },
            name: { type: 'string', description: 'display name' },
            order: { type: 'number', description: 'sort order (defaults to array index)' },
            isDone: { type: 'boolean', description: 'marks the terminal-success stage (at most one)' },
            isCancelled: { type: 'boolean', description: 'marks the terminal-abandon stage (at most one)' },
            isNew: { type: 'boolean', description: 'marks the intake/new stage (at most one)' },
          },
          required: ['id', 'name'],
        },
      },
      force: {
        type: 'boolean',
        description: 'force removal of stages that still have items. Requires fallbackStageId.',
      },
      fallbackStageId: {
        type: 'string',
        description: 'stage id to reassign orphaned items to when force=true.',
      },
    },
    required: ['stages'],
  },
} as const;

export const REPLACE_FIELD_SCHEMAS_TOOL = {
  name: 'pc_replace_field_schemas',
  description:
    'Bulk-replace a project\'s custom work-item field schemas. PUT /api/projects/:projectId/field-schemas. Returns { ok: true, items: [...] }. Call pc_list_field_schemas first to read current state before replacing. Always call pc_request_approval before replacing schemas.',
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'full replacement field schema list. Each item: { key, label, type, options?, required? }.',
        items: {
          type: 'object',
          additionalProperties: true,
        },
      },
    },
    required: ['items'],
  },
} as const;

export const PROJECT_CONFIG_TOOLS = [
  GET_STAGES_TOOL,
  WRITE_CLAUDE_MD_TOOL,
  LIST_STAGES_TOOL,
  LIST_FIELD_SCHEMAS_TOOL,
  REPLACE_STAGES_TOOL,
  REPLACE_FIELD_SCHEMAS_TOOL,
] as const;

export const PROJECT_CONFIG_TOOL_NAMES = PROJECT_CONFIG_TOOLS.map((tool) => tool.name);

interface McpStage {
  id: string;
  name: string;
  order: number;
  isDone?: boolean;
  isCancelled?: boolean;
  isNew?: boolean;
}

interface ProjectStagesResponse {
  stages?: McpStage[];
}

function stageForMcp(s: McpStage): {
  id: string;
  name: string;
  order: number;
  isDone?: true;
  isCancelled?: true;
  isNew?: true;
} {
  return {
    id: s.id,
    name: s.name,
    order: s.order,
    ...(s.isDone === true ? { isDone: true } : {}),
    ...(s.isCancelled === true ? { isCancelled: true } : {}),
    ...(s.isNew === true ? { isNew: true } : {}),
  };
}

async function listStages(
  toolName: 'pc_get_stages' | 'pc_list_stages',
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    if (!ctx.projectId) throw new Error('PC_PROJECT_ID required');
    // Slice 011 — route through the typed client (parses StageDto[] off the
    // project doc for internal type-safety); the emitted text stays the custom
    // MCP stage projection below, byte-identical to before.
    const res = await ctx.client.listStages(`/api/projects/${ctx.projectId}`);
    if (res.status >= 200 && res.status < 300) {
      try {
        const project = JSON.parse(res.body) as ProjectStagesResponse;
        const stages = (project.stages ?? []).map(stageForMcp);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, stages }) }] };
      } catch {
        return {
          content: [
            { type: 'text', text: `${toolName} parse error: ${res.body.slice(0, 200)}` },
          ],
          isError: true,
        };
      }
    }
    return {
      content: [{ type: 'text', text: `${toolName} failed (${res.status}): ${res.body}` }],
      isError: true,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `${toolName} failed: ${(err as Error).message}` }],
      isError: true,
    };
  }
}

export async function handleProjectConfigTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case 'pc_get_stages':
      return listStages('pc_get_stages', ctx);

    case 'pc_write_claude_md': {
      const content = typeof args.content === 'string' ? args.content : '';
      if (!content.trim()) {
        return {
          content: [{ type: 'text', text: 'pc_write_claude_md: content required (non-empty)' }],
          isError: true,
        };
      }
      try {
        const res = await ctx.putServer(ctx.projectPath('claude-md'), { content });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_write_claude_md failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_write_claude_md failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_list_stages':
      return listStages('pc_list_stages', ctx);

    case 'pc_list_field_schemas': {
      try {
        const res = await ctx.client.listFieldSchemas(ctx.projectPath('field-schemas'));
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_list_field_schemas failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_list_field_schemas failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_replace_stages': {
      if (!ctx.projectId) {
        return {
          content: [{ type: 'text', text: 'pc_replace_stages: PC_PROJECT_ID not set' }],
          isError: true,
        };
      }
      const stages = Array.isArray(args.stages) ? args.stages : null;
      if (!stages) {
        return {
          content: [{ type: 'text', text: 'pc_replace_stages: stages array required' }],
          isError: true,
        };
      }
      try {
        const payload: Record<string, unknown> = { stages };
        if (args.force === true) payload.force = true;
        if (typeof args.fallbackStageId === 'string') payload.fallbackStageId = args.fallbackStageId;
        const res = await ctx.patchServer(`/api/projects/${ctx.projectId}/stages`, payload);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_replace_stages failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_replace_stages failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_replace_field_schemas': {
      if (!ctx.projectId) {
        return {
          content: [{ type: 'text', text: 'pc_replace_field_schemas: PC_PROJECT_ID not set' }],
          isError: true,
        };
      }
      const items = Array.isArray(args.items) ? args.items : null;
      if (!items) {
        return {
          content: [{ type: 'text', text: 'pc_replace_field_schemas: items array required' }],
          isError: true,
        };
      }
      try {
        const res = await ctx.putServer(`/api/projects/${ctx.projectId}/field-schemas`, { items });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_replace_field_schemas failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_replace_field_schemas failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    default:
      return null;
  }
}
