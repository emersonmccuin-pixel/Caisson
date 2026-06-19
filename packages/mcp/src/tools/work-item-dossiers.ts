// pc-pty-chat-434 — pc_get_brief / pc_update_brief handlers.
//
// Read and partial-patch the persistent dossier for a work item.
// Server-side route handles callsign→ULID resolution and optimistic-concurrency.

import type { ToolContext, ToolResult } from './context.ts';

export async function handleWorkItemDossierTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case 'pc_get_brief': {
      const ref = typeof args.work_item_id === 'string' ? args.work_item_id.trim() : '';
      if (!ref) {
        return {
          content: [{ type: 'text', text: 'pc_get_brief: work_item_id required' }],
          isError: true,
          next_valid_actions: ['pc_list_work_items', 'pc_search_work_items'],
        };
      }
      if (!ctx.projectId) {
        return {
          content: [{ type: 'text', text: 'pc_get_brief: PC_PROJECT_ID not set' }],
          isError: true,
          next_valid_actions: ['pc_list_projects'],
        };
      }
      try {
        const res = await ctx.getServer(
          ctx.projectPath(`work-items/${encodeURIComponent(ref)}/dossier`),
        );
        if (res.status >= 200 && res.status < 300) {
          return {
            content: [{ type: 'text', text: res.body }],
            next_valid_actions: ['pc_update_brief', 'pc_get_work_item'],
          };
        }
        return {
          content: [{ type: 'text', text: `pc_get_brief failed (${res.status}): ${res.body}` }],
          isError: true,
          next_valid_actions: ['pc_resolve_work_item', 'pc_list_work_items'],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_get_brief failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_update_brief': {
      const ref = typeof args.work_item_id === 'string' ? args.work_item_id.trim() : '';
      if (!ref) {
        return {
          content: [{ type: 'text', text: 'pc_update_brief: work_item_id required' }],
          isError: true,
          next_valid_actions: ['pc_list_work_items', 'pc_search_work_items'],
        };
      }
      if (!ctx.projectId) {
        return {
          content: [{ type: 'text', text: 'pc_update_brief: PC_PROJECT_ID not set' }],
          isError: true,
          next_valid_actions: ['pc_list_projects'],
        };
      }

      const body: Record<string, unknown> = {
        agent_run_id: ctx.agentRunId ?? null,
      };
      if (typeof args.state === 'string') body.state = args.state;
      if (typeof args.decisions === 'string') body.decisions = args.decisions;
      if (typeof args.open_questions === 'string') body.open_questions = args.open_questions;
      if (typeof args.expected_version === 'number') body.expected_version = args.expected_version;

      try {
        const res = await ctx.putServer(
          ctx.projectPath(`work-items/${encodeURIComponent(ref)}/dossier`),
          body,
        );
        if (res.status >= 200 && res.status < 300) {
          return {
            content: [{ type: 'text', text: res.body }],
            next_valid_actions: ['pc_get_brief', 'pc_get_work_item'],
          };
        }
        // 409 = version conflict — surface the current row from the response.
        return {
          content: [{ type: 'text', text: `pc_update_brief failed (${res.status}): ${res.body}` }],
          isError: true,
          next_valid_actions: res.status === 409 ? ['pc_get_brief'] : ['pc_resolve_work_item'],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_update_brief failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    default:
      return null;
  }
}
