import type { ToolContext, ToolResult } from './context.ts';

// Slice 016 — the per-tool *_TOOL consts (name + description + inputSchema)
// were relocated VERBATIM into @pc/domain PC_RIG_TOOL_REGISTRY (the single
// canonical pc-rig tool metadata source). This file now owns only the
// executable handler (localhost-HTTP dispatch).

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
