// Slice 016 — the per-tool `*_TOOL` definition consts (name + description +
// inputSchema) were relocated VERBATIM into @pc/domain's PC_RIG_TOOL_REGISTRY,
// the single canonical source of pc-rig tool metadata. This file now owns only
// the executable handler (the localhost-HTTP dispatch), which cannot live in a
// browser-safe package.

import { COMMAND_PROJECT_SLUG } from '@pc/contracts';

import type { ToolContext, ToolResult } from './context.ts';

export async function handleWorkItemTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case 'pc_create_work_item': {
      const title = typeof args.title === 'string' ? args.title : '';
      const stageId = typeof args.stageId === 'string' ? args.stageId : undefined;
      const bodyText = typeof args.body === 'string' ? args.body : undefined;
      const targetProjectId =
        typeof args.targetProjectId === 'string' && args.targetProjectId.trim().length > 0
          ? args.targetProjectId.trim()
          : null;
      if (!title) {
        return {
          content: [{ type: 'text', text: 'pc_create_work_item: title required' }],
          isError: true,
        };
      }
      // Cross-project write: when targetProjectId is supplied use the target's
      // project-scoped create route instead of PC_PROJECT_ID. The server-side
      // resolveProject call returns 404 on unknown/soft-deleted projects.
      // Single-user app — no ownership/auth gate. Future multi-user pass should revisit.
      const targetPath = targetProjectId
        ? `/api/projects/${targetProjectId}/work-items/create`
        : ctx.projectPath('work-items/create');
      // Origin annotation when writing cross-project (mirrors pc_log_bug pattern).
      const originNote = targetProjectId
        ? `\n\n---\n*Created from project: ${ctx.projectId} · session: ${ctx.agentSessionId || 'interactive'}*`
        : '';
      const payload: Record<string, unknown> = { title };
      if (stageId) payload.stageId = stageId;
      if (typeof args.area_id === 'string' && args.area_id.trim()) payload.areaId = args.area_id.trim();
      else if (args.area_id === null) payload.areaId = null;
      if (typeof args.parent_work_item_id === 'string' && args.parent_work_item_id.trim())
        payload.parentId = args.parent_work_item_id.trim();
      if (bodyText !== undefined) payload.body = (bodyText + originNote).trim();
      else if (originNote) payload.body = originNote.trim();
      try {
        // Slice 011 — route through the typed client (parses WorkItemDto for
        // internal type-safety); emit the raw body verbatim (byte-compat).
        const res = await ctx.client.createWorkItem(targetPath, payload);
        if (res.status >= 200 && res.status < 300) {
          // A1: after creating a work item the most common next steps are to
          // dispatch an agent against it or to move/update it.
          return {
            ...ctx.withRichLinkHint(res.body),
            next_valid_actions: ['pc_invoke_agent', 'pc_move_work_item', 'pc_update_work_item'],
          };
        }
        return {
          content: [{ type: 'text', text: `pc_create_work_item failed (${res.status}): ${res.body}` }],
          isError: true,
          // A1: creation failure — check what stages/projects exist to pick valid values.
          next_valid_actions: ['pc_list_stages', 'pc_list_projects'],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_create_work_item failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_create_agent_work_item': {
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      const task = typeof args.task === 'string' ? args.task : '';
      const pod = typeof args.pod === 'string' ? args.pod.trim() : '';
      if (!title || !task || !pod) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_create_agent_work_item: title, task, and pod required',
            },
          ],
          isError: true,
        };
      }
      const payload: Record<string, unknown> = { title, task, pod };
      if (args.expected_output !== undefined) payload.expected_output = args.expected_output;
      if (typeof args.verification_tier === 'string')
        payload.verification_tier = args.verification_tier;
      if (typeof args.parent_work_item_id === 'string')
        payload.parent_work_item_id = args.parent_work_item_id;
      if (typeof args.stage_id === 'string') payload.stage_id = args.stage_id;
      if (typeof args.worktree === 'string') payload.worktree = args.worktree;
      if (args.raw_acceptance_criteria !== undefined)
        payload.raw_acceptance_criteria = args.raw_acceptance_criteria;
      try {
        const res = await ctx.postServer(
          ctx.projectPath('work-items/create-agent-contract'),
          payload,
        );
        if (res.status >= 200 && res.status < 300) {
          // A1: after a contract dispatch the caller will want to track the run.
          return {
            ...ctx.withRichLinkHint(res.body),
            next_valid_actions: ['pc_list_my_runs', 'pc_inspect_agent_run'],
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: `pc_create_agent_work_item failed (${res.status}): ${res.body}`,
            },
          ],
          isError: true,
          // A1: dispatch failure — list agents to verify pod name, or use
          // pc_invoke_agent for a lighter-weight fire-and-forget alternative.
          next_valid_actions: ['pc_list_agents', 'pc_invoke_agent'],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: `pc_create_agent_work_item failed: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }

    case 'pc_resolve_work_item': {
      const ref = typeof args.id === 'string' ? args.id.trim() : '';
      const decision =
        args.decision === 'approve' || args.decision === 'reject' ? args.decision : '';
      if (!ref || !decision) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_resolve_work_item: id and decision ("approve" | "reject") required',
            },
          ],
          isError: true,
        };
      }
      if (!ctx.projectId) {
        return {
          content: [{ type: 'text', text: 'pc_resolve_work_item: PC_PROJECT_ID not set' }],
          isError: true,
        };
      }
      const feedback = typeof args.feedback === 'string' ? args.feedback : '';
      if (decision === 'reject') {
        if (!feedback.trim()) {
          return {
            content: [
              {
                type: 'text',
                text: 'pc_resolve_work_item: non-empty feedback required when decision="reject"',
              },
            ],
            isError: true,
          };
        }
        if (!ctx.dispatcherSessionId) {
          return {
            content: [
              {
                type: 'text',
                text: 'pc_resolve_work_item: PC_SESSION_ID / PC_DISPATCHER_SESSION_ID not set (required for reject)',
              },
            ],
            isError: true,
          };
        }
      }
      const id = await ctx.resolveWorkItemIdViaServer(ref);
      // Build the shared request payload for either path.
      const wiPayload: Record<string, unknown> =
        decision === 'approve'
          ? typeof args.notes === 'string'
            ? { notes: args.notes }
            : {}
          : { feedback, dispatcherSessionId: ctx.dispatcherSessionId };

      // Helper: try ref as a contractId via the contract-native approve/reject route.
      const tryContractPath = async (contractId: string) => {
        const contractBase = `/api/contracts/${encodeURIComponent(contractId)}`;
        const contractPath = decision === 'approve' ? `${contractBase}/approve` : `${contractBase}/reject`;
        return ctx.postServer(contractPath, wiPayload);
      };

      if (!id) {
        // ref is a non-ULID callsign that didn't resolve to a WI → fall back to
        // contract path (e.g. a contract callsign if one is ever supported).
        try {
          const contractRes = await tryContractPath(ref);
          if (contractRes.status >= 200 && contractRes.status < 300) {
            return { content: [{ type: 'text', text: contractRes.body }] };
          }
          if (contractRes.status === 404) {
            return {
              content: [{ type: 'text', text: `pc_resolve_work_item: unknown work item or contract: ${ref}` }],
              isError: true,
            };
          }
          return {
            content: [
              { type: 'text', text: `pc_resolve_work_item failed (${contractRes.status}): ${contractRes.body}` },
            ],
            isError: true,
          };
        } catch (err) {
          return {
            content: [
              { type: 'text', text: `pc_resolve_work_item failed: ${(err as Error).message}` },
            ],
            isError: true,
          };
        }
      }
      try {
        const base = `/api/projects/${ctx.projectId}/work-items/${encodeURIComponent(id)}`;
        const path = decision === 'approve' ? `${base}/approve` : `${base}/reject`;
        const res = await ctx.postServer(path, wiPayload);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        // If the WI path returns 404, the ref may be a contractId ULID — fall
        // back to the contract-native route (Issue 4 fix).
        if (res.status === 404) {
          const contractRes = await tryContractPath(id);
          if (contractRes.status >= 200 && contractRes.status < 300) {
            return { content: [{ type: 'text', text: contractRes.body }] };
          }
          if (contractRes.status === 404) {
            return {
              content: [{ type: 'text', text: `pc_resolve_work_item: unknown work item or contract: ${ref}` }],
              isError: true,
            };
          }
          return {
            content: [
              { type: 'text', text: `pc_resolve_work_item failed (${contractRes.status}): ${contractRes.body}` },
            ],
            isError: true,
          };
        }
        return {
          content: [
            { type: 'text', text: `pc_resolve_work_item failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_resolve_work_item failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_log_bug': {
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      const description = typeof args.description === 'string' ? args.description : '';
      if (!title) {
        return { content: [{ type: 'text', text: 'pc_log_bug: title required' }], isError: true };
      }
      try {
        const settingsRes = await ctx.getServer('/api/settings');
        if (settingsRes.status < 200 || settingsRes.status >= 300) {
          return {
            content: [
              { type: 'text', text: `pc_log_bug: failed to read settings (${settingsRes.status}): ${settingsRes.body}` },
            ],
            isError: true,
          };
        }
        const settingsParsed = JSON.parse(settingsRes.body) as {
          settings?: { bugLogTargetProjectId?: string | null };
        };
        const targetId = settingsParsed.settings?.bugLogTargetProjectId ?? null;
        if (!targetId) {
          return {
            content: [
              {
                type: 'text',
                text: 'pc_log_bug: no bug-log target configured. Open App Settings → "Bug log target" and pick the project where bugs should land.',
              },
            ],
            isError: true,
          };
        }

        const targetRes = await ctx.getServer(`/api/projects/${targetId}`);
        if (targetRes.status < 200 || targetRes.status >= 300) {
          return {
            content: [
              { type: 'text', text: `pc_log_bug: target project unreachable (${targetRes.status}): ${targetRes.body}` },
            ],
            isError: true,
          };
        }
        const target = JSON.parse(targetRes.body) as {
          name?: string;
          stages?: Array<{ id: string; order?: number; isNew?: boolean }>;
        };
        const stages = (target.stages ?? []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        const intakeStage = stages.find((s) => s.isNew)?.id ?? stages[0]?.id;
        if (!intakeStage) {
          return {
            content: [
              { type: 'text', text: `pc_log_bug: target project '${target.name ?? targetId}' has no stages defined.` },
            ],
            isError: true,
          };
        }

        let sourceName = ctx.projectId;
        if (ctx.projectId) {
          const sourceRes = await ctx.getServer(`/api/projects/${ctx.projectId}`);
          if (sourceRes.status >= 200 && sourceRes.status < 300) {
            try {
              const source = JSON.parse(sourceRes.body) as { name?: string };
              if (source.name) sourceName = source.name;
            } catch {
              /* fall back to id */
            }
          }
        }

        const prefixParts = [`Logged from project: ${sourceName}`];
        if (ctx.sessionId) prefixParts.push(`session: ${ctx.sessionId}`);
        const prefix = prefixParts.join(' · ');
        const body = description.trim() ? `${prefix}\n\n${description}` : prefix;

        const createRes = await ctx.postServer(`/api/projects/${targetId}/work-items/create`, {
          title,
          stageId: intakeStage,
          body,
          type: 'bug',
        });
        if (createRes.status < 200 || createRes.status >= 300) {
          return {
            content: [
              { type: 'text', text: `pc_log_bug failed (${createRes.status}): ${createRes.body}` },
            ],
            isError: true,
          };
        }
        const parsed = JSON.parse(createRes.body) as { ok?: boolean; workItem?: { id?: string; callsign?: string | null } };
        const newId = parsed.workItem?.id ?? '?';
        const callsign = parsed.workItem?.callsign ?? null;
        const idDisplay = callsign ? `${callsign} (${newId})` : newId;
        return ctx.withRichLinkHint(
          `Bug filed in ${target.name ?? targetId} (id: ${idDisplay}, stage: ${intakeStage}). Body: ${prefix}`,
        );
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_log_bug failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_capture_todo': {
      // Open-write side of the Command rule: any orchestrator can drop a
      // cross-cutting to-do into Command on the user's behalf. Resolves Command
      // by its reserved slug (no setting to configure), mirrors pc_log_bug's
      // resolve-target + intake-stage + origin-note shape.
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      const note = typeof args.note === 'string' ? args.note : '';
      if (!title) {
        return { content: [{ type: 'text', text: 'pc_capture_todo: title required' }], isError: true };
      }
      try {
        const listRes = await ctx.getServer('/api/projects');
        if (listRes.status < 200 || listRes.status >= 300) {
          return {
            content: [{ type: 'text', text: `pc_capture_todo: failed to list projects (${listRes.status}): ${listRes.body}` }],
            isError: true,
          };
        }
        const parsed = JSON.parse(listRes.body) as {
          projects?: Array<{ id: string; name?: string; slug: string; stages?: Array<{ id: string; order?: number; isNew?: boolean }> }>;
        };
        const command = (parsed.projects ?? []).find((p) => p.slug === COMMAND_PROJECT_SLUG);
        if (!command) {
          return {
            content: [{ type: 'text', text: 'pc_capture_todo: Command space not found — it is seeded at server boot.' }],
            isError: true,
          };
        }
        const stages = (command.stages ?? []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        const intakeStage = stages.find((s) => s.isNew)?.id ?? stages[0]?.id;
        if (!intakeStage) {
          return {
            content: [{ type: 'text', text: 'pc_capture_todo: Command has no stages defined.' }],
            isError: true,
          };
        }

        let sourceName = ctx.projectId;
        if (ctx.projectId) {
          const sourceRes = await ctx.getServer(`/api/projects/${ctx.projectId}`);
          if (sourceRes.status >= 200 && sourceRes.status < 300) {
            try {
              const source = JSON.parse(sourceRes.body) as { name?: string };
              if (source.name) sourceName = source.name;
            } catch {
              /* fall back to id */
            }
          }
        }
        const prefixParts = [`Captured from project: ${sourceName ?? 'interactive'}`];
        if (ctx.sessionId) prefixParts.push(`session: ${ctx.sessionId}`);
        const prefix = prefixParts.join(' · ');
        const body = note.trim() ? `${prefix}\n\n${note}` : prefix;

        const createRes = await ctx.postServer(`/api/projects/${command.id}/work-items/create`, {
          title,
          stageId: intakeStage,
          body,
        });
        if (createRes.status < 200 || createRes.status >= 300) {
          return {
            content: [{ type: 'text', text: `pc_capture_todo failed (${createRes.status}): ${createRes.body}` }],
            isError: true,
          };
        }
        const created = JSON.parse(createRes.body) as { workItem?: { id?: string; callsign?: string | null } };
        const newId = created.workItem?.id ?? '?';
        const callsign = created.workItem?.callsign ?? null;
        const idDisplay = callsign ? `${callsign} (${newId})` : newId;
        return ctx.withRichLinkHint(`Captured in Command (id: ${idDisplay}, stage: ${intakeStage}).`);
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_capture_todo failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_set_focus': {
      // Command focus — star/unstar a project or work item. Single unified
      // route resolves the owning project server-side for work items.
      const kind = args.kind === 'project' || args.kind === 'work_item' ? args.kind : '';
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      const focused = args.focused !== false;
      if (!kind || !id) {
        return {
          content: [{ type: 'text', text: "pc_set_focus: kind ('project' | 'work_item') and id required" }],
          isError: true,
        };
      }
      try {
        const res = await ctx.postServer('/api/focus', { kind, id, focused });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_set_focus failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_set_focus failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_move_work_item': {
      const ref = typeof args.id === 'string' ? args.id : '';
      const toStage = typeof args.toStage === 'string' ? args.toStage : '';
      const toFlag = typeof args.toFlag === 'string' ? args.toFlag : '';
      const notes = typeof args.notes === 'string' ? args.notes : '';
      if (!ref) {
        return { content: [{ type: 'text', text: 'pc_move_work_item: id required' }], isError: true };
      }
      if (!toStage && !toFlag) {
        return {
          content: [{ type: 'text', text: 'pc_move_work_item: pass either toStage (slug) or toFlag (done/cancelled/new)' }],
          isError: true,
        };
      }
      if (toStage && toFlag) {
        return {
          content: [{ type: 'text', text: 'pc_move_work_item: pass exactly one of toStage / toFlag (not both)' }],
          isError: true,
        };
      }
      const id = await ctx.resolveWorkItemIdViaServer(ref);
      if (!id) {
        return {
          content: [{ type: 'text', text: `pc_move_work_item: unknown work item: ${ref}` }],
          isError: true,
        };
      }
      try {
        const body: Record<string, string> = { id };
        if (toStage) body.toStage = toStage;
        if (toFlag) body.toFlag = toFlag;
        if (notes) body.notes = notes;
        const res = await ctx.client.moveWorkItem(ctx.projectPath('work-items/move'), body);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return { content: [{ type: 'text', text: `pc_move_work_item failed (${res.status}): ${res.body}` }], isError: true };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_move_work_item failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_update_work_item': {
      const ref = typeof args.id === 'string' ? args.id : '';
      const fields = args.fields && typeof args.fields === 'object' ? args.fields : null;
      const bodyText = typeof args.body === 'string' ? args.body : undefined;
      const titleText = typeof args.title === 'string' ? args.title : undefined;
      const areaIdProvided = typeof args.area_id === 'string' || args.area_id === null;
      const parentIdProvided = typeof args.parent_work_item_id === 'string' || args.parent_work_item_id === null;
      if (!ref) {
        return { content: [{ type: 'text', text: 'pc_update_work_item: id required' }], isError: true };
      }
      if (!fields && bodyText === undefined && titleText === undefined && !areaIdProvided && !parentIdProvided) {
        return {
          content: [{ type: 'text', text: 'pc_update_work_item: at least one of fields, body, title, area_id, or parent_work_item_id required' }],
          isError: true,
        };
      }
      const id = await ctx.resolveWorkItemIdViaServer(ref);
      if (!id) {
        return {
          content: [{ type: 'text', text: `pc_update_work_item: unknown work item: ${ref}` }],
          isError: true,
        };
      }
      try {
        const payload: Record<string, unknown> = { id };
        if (fields) payload.fields = fields;
        if (bodyText !== undefined) payload.body = bodyText;
        if (titleText !== undefined) payload.title = titleText;
        if (typeof args.area_id === 'string' && args.area_id.trim()) payload.areaId = args.area_id.trim();
        else if (args.area_id === null) payload.areaId = null;
        if (typeof args.parent_work_item_id === 'string' && args.parent_work_item_id.trim())
          payload.parentId = args.parent_work_item_id.trim();
        else if (args.parent_work_item_id === null) payload.parentId = null;
        const res = await ctx.client.updateWorkItem(ctx.projectPath('work-items/update'), payload);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return { content: [{ type: 'text', text: `pc_update_work_item failed (${res.status}): ${res.body}` }], isError: true };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_update_work_item failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_get_work_item': {
      const id = typeof args.id === 'string' ? args.id : '';
      const includeArchived = args.includeArchived === true;
      const targetProjectId =
        typeof args.targetProjectId === 'string' && args.targetProjectId.trim().length > 0
          ? args.targetProjectId.trim()
          : null;
      if (!id) {
        return { content: [{ type: 'text', text: 'pc_get_work_item: id required' }], isError: true };
      }
      try {
        const suffix = `work-items/${encodeURIComponent(id)}${includeArchived ? '?includeArchived=1' : ''}`;
        // Cross-project read: when targetProjectId is set use that project's route
        // instead of the current project's. Fixes the 404 when a ULID/callsign
        // belongs to another project (the route's project-scope guard returns null).
        const getPath = targetProjectId
          ? `/api/projects/${targetProjectId}/${suffix}`
          : ctx.projectPath(suffix);
        const res = await ctx.client.getWorkItem(getPath);
        if (res.status >= 200 && res.status < 300) {
          // A1: after fetching a work item the common follow-ons are to
          // modify it or drill into its attachments.
          return {
            ...ctx.withRichLinkHint(res.body),
            next_valid_actions: ['pc_update_work_item', 'pc_move_work_item', 'pc_attach_to_work_item'],
          };
        }
        return {
          content: [{ type: 'text', text: `pc_get_work_item failed (${res.status}): ${res.body}` }],
          isError: true,
          // A1: item not found — search or list to locate the correct id.
          next_valid_actions: ['pc_list_work_items', 'pc_search_work_items'],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_get_work_item failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_list_work_items': {
      const q = new URLSearchParams();
      if (typeof args.stage === 'string' && args.stage) q.set('stage', args.stage);
      if (typeof args.parentId === 'string') q.set('parentId', args.parentId);
      if (args.includeArchived === true) q.set('includeArchived', '1');
      if (typeof args.limit === 'number' && Number.isFinite(args.limit)) {
        q.set('limit', String(args.limit));
      }
      if (typeof args.cursor === 'string' && args.cursor) q.set('cursor', args.cursor);
      // pc-pty-chat-254 — new filters.
      if (args.includeBody === true) q.set('includeBody', '1');
      if (typeof args.status === 'string' && args.status) q.set('status', args.status);
      if (args.open === true) q.set('open', '1');
      if (typeof args.area_id === 'string' && args.area_id) q.set('areaId', args.area_id);
      const query = q.toString();
      const suffix = `work-items${query ? `?${query}` : ''}`;
      // Cross-project read (Command planner): targetProjectId overrides the
      // session's PC_PROJECT_ID. Same project-scoped route, different id.
      const listTargetPid =
        typeof args.targetProjectId === 'string' && args.targetProjectId.trim()
          ? args.targetProjectId.trim()
          : null;
      const listPath = listTargetPid ? `/api/projects/${listTargetPid}/${suffix}` : ctx.projectPath(suffix);
      try {
        const res = await ctx.client.listWorkItems(listPath);
        if (res.status >= 200 && res.status < 300) {
          return ctx.withRichLinkHint(res.body);
        }
        return {
          content: [
            { type: 'text', text: `pc_list_work_items failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_list_work_items failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    // pc-pty-chat-254 — FTS5 search (separate tool, not a `query` param on list).
    case 'pc_search_work_items': {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) {
        return {
          content: [{ type: 'text', text: 'pc_search_work_items: query required' }],
          isError: true,
        };
      }
      const targetProjectId =
        typeof args.targetProjectId === 'string' && args.targetProjectId.trim().length > 0
          ? args.targetProjectId.trim()
          : null;
      const q = new URLSearchParams({ q: query });
      if (typeof args.area_id === 'string' && args.area_id) q.set('areaId', args.area_id);
      if (typeof args.status === 'string' && args.status) q.set('status', args.status);
      if (args.open === true) q.set('open', '1');
      try {
        const searchPath = targetProjectId
          ? `/api/projects/${targetProjectId}/work-items/search?${q.toString()}`
          : ctx.projectPath(`work-items/search?${q.toString()}`);
        const res = await ctx.getServer(searchPath);
        if (res.status >= 200 && res.status < 300) {
          return ctx.withRichLinkHint(res.body);
        }
        return {
          content: [
            { type: 'text', text: `pc_search_work_items failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_search_work_items failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_list_projects': {
      // Cross-project read for the Command planner: every project in the
      // workspace, so it can then pull each one's work items / areas by id.
      try {
        const res = await ctx.getServer('/api/projects');
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_list_projects failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_list_projects failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_list_waiting_on_you': {
      // Cross-project read: all pending asks + workflow human-review gates +
      // actionable inbox items, grouped by project.
      try {
        const res = await ctx.getServer('/api/waiting-on-you');
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_list_waiting_on_you failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_list_waiting_on_you failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_list_areas': {
      const areasTargetPid =
        typeof args.targetProjectId === 'string' && args.targetProjectId.trim()
          ? args.targetProjectId.trim()
          : null;
      const areasPath = areasTargetPid ? `/api/projects/${areasTargetPid}/areas` : ctx.projectPath('areas');
      try {
        const res = await ctx.client.listAreas(areasPath);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_list_areas failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_list_areas failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_create_area': {
      // FD-19 — the orchestrator mints a new Area when work opens a genuinely
      // new track. POSTs the existing area-create route (AreaService writes the
      // area.changed live_outbox row in-txn).
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (!name) {
        return {
          content: [{ type: 'text', text: 'pc_create_area: name required' }],
          isError: true,
        };
      }
      const summary = typeof args.summary === 'string' ? args.summary : undefined;
      try {
        const payload: Record<string, unknown> = { name };
        if (summary !== undefined) payload.summary = summary;
        const res = await ctx.postServer(ctx.projectPath('areas'), payload);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_create_area failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_create_area failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_update_area': {
      // FD-19 — the orchestrator maintains Area names/summaries itself. The
      // PATCH route needs the current version (optimistic concurrency), so
      // read the live row first and send its version as expectedVersion.
      const areaId = typeof args.area_id === 'string' ? args.area_id.trim() : '';
      if (!areaId) {
        return {
          content: [{ type: 'text', text: 'pc_update_area: area_id required' }],
          isError: true,
        };
      }
      const name = typeof args.name === 'string' ? args.name.trim() : undefined;
      const summary = typeof args.summary === 'string' ? args.summary : undefined;
      if (name === undefined && summary === undefined) {
        return {
          content: [
            { type: 'text', text: 'pc_update_area: at least one of name or summary required' },
          ],
          isError: true,
        };
      }
      try {
        const list = await ctx.client.listAreas(ctx.projectPath('areas'));
        if (!list.parsed.ok) {
          return {
            content: [
              { type: 'text', text: `pc_update_area failed (${list.status}): ${list.body}` },
            ],
            isError: true,
          };
        }
        const area = list.parsed.value.find((a) => a.id === areaId);
        if (!area) {
          return {
            content: [
              { type: 'text', text: `pc_update_area: unknown area ${areaId} — see pc_list_areas` },
            ],
            isError: true,
          };
        }
        const res = await ctx.patchServer(ctx.projectPath(`areas/${areaId}`), {
          expectedVersion: area.version,
          ...(name !== undefined ? { name } : {}),
          ...(summary !== undefined ? { summary } : {}),
        });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_update_area failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_update_area failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_attach_to_work_item': {
      const ref = typeof args.workItemId === 'string' ? args.workItemId : '';
      const nameArg = typeof args.name === 'string' ? args.name : '';
      const content = typeof args.content === 'string' ? args.content : '';
      const kind = typeof args.kind === 'string' && args.kind.trim() ? args.kind.trim() : 'markdown';
      const contentType = typeof args.contentType === 'string' ? args.contentType : undefined;
      const agentName = typeof args.agentName === 'string' ? args.agentName : undefined;
      const workflowRunId = typeof args.workflowRunId === 'string' ? args.workflowRunId : undefined;
      const nodeId = typeof args.nodeId === 'string' ? args.nodeId : undefined;
      if (!ref || !nameArg || !content) {
        return {
          content: [
            { type: 'text', text: 'pc_attach_to_work_item: workItemId, name, and content required' },
          ],
          isError: true,
        };
      }
      const workItemId = await ctx.resolveWorkItemIdViaServer(ref);
      if (!workItemId) {
        return {
          content: [{ type: 'text', text: `pc_attach_to_work_item: unknown work item: ${ref}` }],
          isError: true,
        };
      }
      try {
        const payload: Record<string, unknown> = {
          kind,
          name: nameArg,
          content,
          source: 'agent',
        };
        if (contentType !== undefined) payload.contentType = contentType;
        if (agentName !== undefined) payload.agentName = agentName;
        if (workflowRunId !== undefined) payload.runId = workflowRunId;
        if (nodeId !== undefined) payload.nodeId = nodeId;
        const res = await ctx.client.attachToWorkItem(
          ctx.projectPath(`work-items/${encodeURIComponent(workItemId)}/attachments`),
          payload,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_attach_to_work_item failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_attach_to_work_item failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_list_attachments': {
      // M5 (dispatch-payload audit 🔴) — the READ half of attachments. The
      // dispatch prompt has always pointed agents at a card's attachments;
      // this is the first tool that can actually fetch the list.
      const ref = typeof args.workItemId === 'string' ? args.workItemId.trim() : '';
      if (!ref) {
        return {
          content: [{ type: 'text', text: 'pc_list_attachments: workItemId required' }],
          isError: true,
        };
      }
      const workItemId = await ctx.resolveWorkItemIdViaServer(ref);
      if (!workItemId) {
        return {
          content: [{ type: 'text', text: `pc_list_attachments: unknown work item: ${ref}` }],
          isError: true,
        };
      }
      try {
        const res = await ctx.getServer(
          ctx.projectPath(`work-items/${encodeURIComponent(workItemId)}/attachments`),
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_list_attachments failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_list_attachments failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_set_done_checklist': {
      const ref = typeof args.workItemId === 'string' ? args.workItemId.trim() : '';
      if (!ref) {
        return {
          content: [{ type: 'text', text: 'pc_set_done_checklist: workItemId required' }],
          isError: true,
        };
      }
      if (!Array.isArray(args.items)) {
        return {
          content: [{ type: 'text', text: 'pc_set_done_checklist: items (array) required' }],
          isError: true,
        };
      }
      const id = await ctx.resolveWorkItemIdViaServer(ref);
      if (!id) {
        return {
          content: [{ type: 'text', text: `pc_set_done_checklist: unknown work item: ${ref}` }],
          isError: true,
        };
      }
      try {
        const res = await ctx.postServer(ctx.projectPath('work-items/set-done-checklist'), {
          id,
          items: args.items,
        });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_set_done_checklist failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_set_done_checklist failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_tick_done_checklist_item': {
      const ref = typeof args.workItemId === 'string' ? args.workItemId.trim() : '';
      const itemId = typeof args.itemId === 'string' ? args.itemId.trim() : '';
      const done = args.done !== false; // default true; explicit false to un-tick
      if (!ref) {
        return {
          content: [{ type: 'text', text: 'pc_tick_done_checklist_item: workItemId required' }],
          isError: true,
        };
      }
      if (!itemId) {
        return {
          content: [{ type: 'text', text: 'pc_tick_done_checklist_item: itemId required' }],
          isError: true,
        };
      }
      const id = await ctx.resolveWorkItemIdViaServer(ref);
      if (!id) {
        return {
          content: [{ type: 'text', text: `pc_tick_done_checklist_item: unknown work item: ${ref}` }],
          isError: true,
        };
      }
      try {
        const res = await ctx.postServer(ctx.projectPath('work-items/tick-done-checklist-item'), {
          id,
          itemId,
          done,
        });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_tick_done_checklist_item failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_tick_done_checklist_item failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_get_attachment': {
      const attachmentId = typeof args.attachmentId === 'string' ? args.attachmentId.trim() : '';
      if (!attachmentId) {
        return {
          content: [{ type: 'text', text: 'pc_get_attachment: attachmentId required' }],
          isError: true,
        };
      }
      try {
        const res = await ctx.getServer(
          ctx.projectPath(`attachments/${encodeURIComponent(attachmentId)}`),
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_get_attachment failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_get_attachment failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    default:
      return null;
  }
}
