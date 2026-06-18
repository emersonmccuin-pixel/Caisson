// A4 — pc_next_action: deterministic "what to work on next" picker.
//
// Priority order (mirrors AInativePM coreNextAction):
//   1. Item with focusedAt set (Command-planner focus) — pick most-recently focused.
//   2. Oldest item in a non-terminal, non-intake stage (i.e. actively in-progress).
//   3. Oldest non-terminal item overall.
//
// "Oldest" = smallest ULID (ULIDs encode epoch-ms, lexicographically sortable by
// creation time). Excludes done/cancelled/archived (status via ?open=1 filter).
// Optional targetProjectId overrides PC_PROJECT_ID for cross-project reads.

import type { ToolContext, ToolResult } from './context.ts';

interface SlimStage {
  id: string;
  name: string;
  order: number;
  isDone?: boolean;
  isCancelled?: boolean;
  isNew?: boolean;
}

interface SlimWorkItem {
  id: string;
  callsign: string | null;
  title: string;
  stageId: string;
  status: string;
  focusedAt: number | null;
}

export async function handleNextActionTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  if (name !== 'pc_next_action') return null;

  const targetProjectId =
    typeof args.targetProjectId === 'string' && args.targetProjectId.trim().length > 0
      ? args.targetProjectId.trim()
      : ctx.projectId;

  if (!targetProjectId) {
    return {
      content: [{ type: 'text', text: 'pc_next_action: PC_PROJECT_ID not set and targetProjectId not provided' }],
      isError: true,
      next_valid_actions: ['pc_list_projects'],
    };
  }

  try {
    // ── 1. Fetch stages ──────────────────────────────────────────────────────
    const projectRes = await ctx.getServer(`/api/projects/${targetProjectId}`);
    if (projectRes.status < 200 || projectRes.status >= 300) {
      return {
        content: [{ type: 'text', text: `pc_next_action: failed to fetch project (${projectRes.status}): ${projectRes.body}` }],
        isError: true,
        next_valid_actions: ['pc_list_projects'],
      };
    }
    const projectDoc = JSON.parse(projectRes.body) as { stages?: unknown[] };
    const rawStages = Array.isArray(projectDoc.stages) ? projectDoc.stages : [];
    const stages: SlimStage[] = rawStages.map((s) => {
      const st = s as Record<string, unknown>;
      return {
        id: String(st.id ?? ''),
        name: String(st.name ?? ''),
        order: typeof st.order === 'number' ? st.order : 0,
        ...(st.isDone === true ? { isDone: true as const } : {}),
        ...(st.isCancelled === true ? { isCancelled: true as const } : {}),
        ...(st.isNew === true ? { isNew: true as const } : {}),
      };
    }).sort((a, b) => a.order - b.order);

    const terminalStageIds = new Set(stages.filter((s) => s.isDone || s.isCancelled).map((s) => s.id));
    const intakeStageIds = new Set(stages.filter((s) => s.isNew).map((s) => s.id));
    const inProgressStageIds = new Set(
      stages.filter((s) => !s.isDone && !s.isCancelled && !s.isNew).map((s) => s.id),
    );

    // ── 2. Fetch open work items ─────────────────────────────────────────────
    const wiRes = await ctx.getServer(`/api/projects/${targetProjectId}/work-items?open=1`);
    if (wiRes.status < 200 || wiRes.status >= 300) {
      return {
        content: [{ type: 'text', text: `pc_next_action: failed to fetch work items (${wiRes.status}): ${wiRes.body}` }],
        isError: true,
        next_valid_actions: ['pc_list_work_items', 'pc_list_stages'],
      };
    }
    const wiDoc = JSON.parse(wiRes.body) as { workItems?: unknown[] };
    const rawItems = Array.isArray(wiDoc.workItems) ? wiDoc.workItems : [];

    // Map to slim shape; exclude items whose stage is terminal (belt + suspenders
    // on top of ?open=1 which filters by status).
    const items: SlimWorkItem[] = rawItems
      .map((item) => {
        const it = item as Record<string, unknown>;
        return {
          id: String(it.id ?? ''),
          callsign: typeof it.callsign === 'string' ? it.callsign : null,
          title: String(it.title ?? ''),
          stageId: String(it.stageId ?? ''),
          status: String(it.status ?? ''),
          focusedAt: typeof it.focusedAt === 'number' ? it.focusedAt : null,
        };
      })
      .filter((it) => it.id && !terminalStageIds.has(it.stageId));

    // ── 3. Apply picker ──────────────────────────────────────────────────────
    let chosen: SlimWorkItem | null = null;
    let reason: string;

    // Priority 1: focused items (most-recently focused first, then oldest ULID as tie-break)
    const focused = items
      .filter((it) => it.focusedAt !== null)
      .sort((a, b) => (b.focusedAt ?? 0) - (a.focusedAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (focused.length > 0) {
      chosen = focused[0];
      reason = 'focused';
    } else {
      // Priority 2: oldest item in an in-progress (non-intake, non-terminal) stage
      const inProgress = items
        .filter((it) => inProgressStageIds.has(it.stageId))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (inProgress.length > 0) {
        chosen = inProgress[0];
        reason = 'oldest in-progress';
      } else {
        // Priority 3: oldest open item overall (intake + in-progress, non-terminal)
        const all = items
          .filter((it) => !terminalStageIds.has(it.stageId))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        if (all.length > 0) {
          chosen = all[0];
          reason = 'oldest open';
        } else {
          // Empty project
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ok: true,
                item: null,
                reason: 'no open items',
                legalNextStages: stages,
              }),
            }],
            // A1: no work items — create one or list stages to plan next steps.
            next_valid_actions: ['pc_create_work_item', 'pc_list_stages', 'pc_list_work_items'],
          };
        }
      }
    }

    // ── 4. Compute legal next stages ─────────────────────────────────────────
    // All stages except the chosen item's current stage, sorted by order.
    // This is additive — the caller decides which transitions are meaningful.
    const legalNextStages = stages.filter((s) => s.id !== chosen!.stageId);

    const inProgressCount = items.filter((it) => inProgressStageIds.has(it.stageId)).length;
    const intakeCount = items.filter((it) => intakeStageIds.has(it.stageId)).length;

    const responsePayload = {
      ok: true,
      item: {
        id: chosen.id,
        callsign: chosen.callsign,
        title: chosen.title,
        stageId: chosen.stageId,
        status: chosen.status,
      },
      reason,
      legalNextStages,
      summary: {
        totalOpen: items.length,
        inProgress: inProgressCount,
        intake: intakeCount,
        focused: focused.length,
      },
    };

    return {
      ...ctx.withRichLinkHint(JSON.stringify(responsePayload)),
      // A1: after picking the next item, common follow-ons are to read it,
      // dispatch an agent against it, or move it forward.
      next_valid_actions: ['pc_get_work_item', 'pc_invoke_agent', 'pc_move_work_item'],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `pc_next_action failed: ${(err as Error).message}` }],
      isError: true,
      next_valid_actions: ['pc_list_work_items', 'pc_list_stages'],
    };
  }
}
