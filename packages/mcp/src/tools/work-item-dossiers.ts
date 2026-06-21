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

    case 'pc_synthesize_finding': {
      const ref = typeof args.work_item_id === 'string' ? args.work_item_id.trim() : '';
      const targetSection =
        args.target_section === 'state' ||
        args.target_section === 'decisions' ||
        args.target_section === 'open_questions'
          ? args.target_section
          : '';
      const finding = typeof args.finding === 'string' ? args.finding.trim() : '';

      if (!ref) {
        return {
          content: [{ type: 'text', text: 'pc_synthesize_finding: work_item_id required' }],
          isError: true,
          next_valid_actions: ['pc_list_work_items', 'pc_search_work_items'],
        };
      }
      if (!targetSection) {
        return {
          content: [
            {
              type: 'text',
              text: "pc_synthesize_finding: target_section must be 'state', 'decisions', or 'open_questions'",
            },
          ],
          isError: true,
        };
      }
      if (!finding) {
        return {
          content: [{ type: 'text', text: 'pc_synthesize_finding: finding required' }],
          isError: true,
        };
      }
      if (!ctx.projectId) {
        return {
          content: [{ type: 'text', text: 'pc_synthesize_finding: PC_PROJECT_ID not set' }],
          isError: true,
          next_valid_actions: ['pc_list_projects'],
        };
      }

      try {
        // 1. Resolve the investigation work item to find its parent + callsign.
        const wiRes = await ctx.getServer(
          ctx.projectPath(`work-items/${encodeURIComponent(ref)}`),
        );
        if (wiRes.status < 200 || wiRes.status >= 300) {
          return {
            content: [
              {
                type: 'text',
                text: `pc_synthesize_finding: could not resolve investigation item '${ref}' (${wiRes.status}): ${wiRes.body}`,
              },
            ],
            isError: true,
            next_valid_actions: ['pc_list_work_items', 'pc_search_work_items'],
          };
        }
        const wiParsed = JSON.parse(wiRes.body) as {
          ok?: boolean;
          workItem?: { id?: string; parentId?: string | null; callsign?: string | null };
        };
        if (!wiParsed.ok || !wiParsed.workItem) {
          return {
            content: [
              { type: 'text', text: `pc_synthesize_finding: could not resolve item '${ref}'` },
            ],
            isError: true,
          };
        }
        const { parentId, callsign } = wiParsed.workItem;
        if (!parentId) {
          return {
            content: [
              {
                type: 'text',
                text: `pc_synthesize_finding: investigation item '${ref}' has no parent — nothing to fold finding into`,
              },
            ],
            isError: true,
            next_valid_actions: ['pc_update_brief', 'pc_get_work_item'],
          };
        }

        // 2. Read the parent's current dossier to get the section's existing content.
        const dossierGetRes = await ctx.getServer(
          ctx.projectPath(`work-items/${encodeURIComponent(parentId)}/dossier`),
        );
        if (dossierGetRes.status < 200 || dossierGetRes.status >= 300) {
          return {
            content: [
              {
                type: 'text',
                text: `pc_synthesize_finding: could not read parent dossier (${dossierGetRes.status}): ${dossierGetRes.body}`,
              },
            ],
            isError: true,
          };
        }
        const dossierParsed = JSON.parse(dossierGetRes.body) as {
          ok?: boolean;
          dossier?: {
            state?: string;
            decisions?: string;
            openQuestions?: string;
            version?: number;
          };
        };
        if (!dossierParsed.ok) {
          return {
            content: [
              {
                type: 'text',
                text: `pc_synthesize_finding: parent dossier read returned ok:false — ${dossierGetRes.body}`,
              },
            ],
            isError: true,
          };
        }

        const existingDossier = dossierParsed.dossier ?? {};
        const fieldKey =
          targetSection === 'state'
            ? 'state'
            : targetSection === 'decisions'
              ? 'decisions'
              : 'openQuestions';
        const existingContent = (existingDossier[fieldKey] as string | undefined) ?? '';

        // 3. Build the appended entry (separator + date + source attribution).
        const now = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const sourceLabel = callsign ?? ref;
        const separator = existingContent.trim() ? '\n\n---\n' : '';
        const entry = `${separator}**[${now} · from ${sourceLabel}]** ${finding}`;
        const updatedContent = (existingContent + entry).trim();

        // 4. PUT the patched section back via the existing dossier route.
        const putBody: Record<string, unknown> = {
          agent_run_id: ctx.agentRunId ?? null,
        };
        if (targetSection === 'state') putBody.state = updatedContent;
        else if (targetSection === 'decisions') putBody.decisions = updatedContent;
        else putBody.open_questions = updatedContent;

        const putRes = await ctx.putServer(
          ctx.projectPath(`work-items/${encodeURIComponent(parentId)}/dossier`),
          putBody,
        );
        if (putRes.status >= 200 && putRes.status < 300) {
          return {
            content: [
              {
                type: 'text',
                text: `pc_synthesize_finding: finding appended to parent's '${targetSection}' dossier section. ${putRes.body}`,
              },
            ],
            next_valid_actions: ['pc_submit_deliverable', 'pc_get_brief'],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: `pc_synthesize_finding: dossier update failed (${putRes.status}): ${putRes.body}`,
            },
          ],
          isError: true,
          next_valid_actions: putRes.status === 409 ? ['pc_get_brief'] : ['pc_get_work_item'],
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_synthesize_finding failed: ${(err as Error).message}` },
          ],
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
