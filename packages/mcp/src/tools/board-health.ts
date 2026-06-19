// pc-pty-chat-431 — pc_board_health handler.
// Read-only: proxies GET /api/projects/:projectId/board-health to the server.
// Activity signal and stall computation live server-side in @pc/db getBoardHealth.

import type { ToolContext, ToolResult } from './context.ts';

export async function handleBoardHealthTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case 'pc_board_health': {
      if (!ctx.projectId) {
        return {
          content: [{ type: 'text', text: 'pc_board_health: PC_PROJECT_ID not set' }],
          isError: true,
          // A1: no project context — list projects to find the target id.
          next_valid_actions: ['pc_list_projects'],
        };
      }

      const idleDaysRaw =
        typeof args.idle_days === 'number' && Number.isFinite(args.idle_days) && args.idle_days > 0
          ? Math.floor(args.idle_days)
          : 7;

      try {
        const q = new URLSearchParams({ idle_days: String(idleDaysRaw) });
        const res = await ctx.getServer(ctx.projectPath(`board-health?${q.toString()}`));
        if (res.status >= 200 && res.status < 300) {
          // A1: stalled items surfaced — natural follow-ons are to inspect, move,
          // or list all open work to prioritise.
          return {
            content: [{ type: 'text', text: res.body }],
            next_valid_actions: ['pc_get_work_item', 'pc_move_work_item', 'pc_list_work_items'],
          };
        }
        return {
          content: [
            { type: 'text', text: `pc_board_health failed (${res.status}): ${res.body}` },
          ],
          isError: true,
          // A1: project-level read failed — confirm the project is accessible.
          next_valid_actions: ['pc_list_projects'],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_board_health failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    default:
      return null;
  }
}
