import type { ToolContext, ToolResult } from './context.ts';

// Slice 016 — the per-tool *_TOOL consts (name + description + inputSchema)
// were relocated VERBATIM into @pc/domain PC_RIG_TOOL_REGISTRY (the single
// canonical pc-rig tool metadata source). This file now owns only the
// executable handler (localhost-HTTP dispatch).

export async function handleWorkflowTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case 'pc_node_failed': {
      const runId = typeof args.workflowRunId === 'string' ? args.workflowRunId.trim() : '';
      const nodeId = typeof args.nodeId === 'string' ? args.nodeId.trim() : '';
      const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
      if (!runId || !nodeId || !reason) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_node_failed: require { workflowRunId, nodeId, reason }',
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: `node failure signal registered for node ${nodeId} (run ${runId}): ${reason}`,
          },
        ],
      };
    }

    case 'pc_publish_workflow': {
      const def = args.def && typeof args.def === 'object' ? args.def : null;
      if (!def) {
        return {
          content: [{ type: 'text', text: 'pc_publish_workflow: def required' }],
          isError: true,
        };
      }
      const defObj = def as { id?: unknown };
      const slug = typeof defObj.id === 'string' ? defObj.id : '';
      if (!slug) {
        return {
          content: [
            { type: 'text', text: 'pc_publish_workflow: def.id (slug) required' },
          ],
          isError: true,
        };
      }
      if (!ctx.projectId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_publish_workflow: PC_PROJECT_ID env not set — workflow publish requires a project scope.',
            },
          ],
          isError: true,
        };
      }
      try {
        const listRes = await ctx.getServer(
          `/api/workflows?projectId=${encodeURIComponent(ctx.projectId)}`,
        );
        let existingId: string | null = null;
        if (listRes.status >= 200 && listRes.status < 300) {
          try {
            const parsed = JSON.parse(listRes.body) as {
              workflows?: Array<{
                id: string;
                slug: string;
                scope: 'project' | 'global';
              }>;
            };
            const match = (parsed.workflows ?? []).find(
              (w) => w.slug === slug && w.scope === 'project',
            );
            if (match) existingId = match.id;
          } catch {
            /* fall through to POST */
          }
        }
        const payload: Record<string, unknown> = {
          def,
          actor: 'orchestrator',
          reason: 'mcp-publish',
        };
        let res;
        if (existingId) {
          res = await ctx.putServer(
            `/api/workflows/${encodeURIComponent(existingId)}`,
            payload,
          );
        } else {
          payload.projectId = ctx.projectId;
          payload.scope = 'project';
          res = await ctx.postServer('/api/workflows', payload);
        }
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_publish_workflow failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_publish_workflow failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_list_workflows': {
      if (!ctx.projectId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_list_workflows: PC_PROJECT_ID env not set',
            },
          ],
          isError: true,
        };
      }
      try {
        const res = await ctx.getServer(
          `/api/workflows?projectId=${encodeURIComponent(ctx.projectId)}`,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_list_workflows failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_list_workflows failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_fire_workflow': {
      if (!ctx.projectId) {
        return {
          content: [
            { type: 'text', text: 'pc_fire_workflow: PC_PROJECT_ID env not set' },
          ],
          isError: true,
        };
      }
      const workflow = typeof args.workflow === 'string' ? args.workflow.trim() : '';
      if (!workflow) {
        return {
          content: [{ type: 'text', text: 'pc_fire_workflow: `workflow` (slug or id) required' }],
          isError: true,
        };
      }
      try {
        const looksLikeUlid = /^[0-9A-HJKMNP-TV-Z]{26}$/.test(workflow);
        let rowId = workflow;
        if (!looksLikeUlid) {
          const listRes = await ctx.getServer(
            `/api/workflows?projectId=${encodeURIComponent(ctx.projectId)}`,
          );
          if (listRes.status < 200 || listRes.status >= 300) {
            return {
              content: [
                { type: 'text', text: `pc_fire_workflow: list failed (${listRes.status}): ${listRes.body}` },
              ],
              isError: true,
            };
          }
          const parsed = JSON.parse(listRes.body) as {
            workflows?: Array<{ id: string; slug: string }>;
          };
          const match = (parsed.workflows ?? []).find((w) => w.slug === workflow);
          if (!match) {
            return {
              content: [
                { type: 'text', text: `pc_fire_workflow: no workflow with slug "${workflow}" in this project` },
              ],
              isError: true,
            };
          }
          rowId = match.id;
        }
        const trigger =
          args.trigger && typeof args.trigger === 'object'
            ? args.trigger
            : { kind: 'manual' };
        const body: Record<string, unknown> = { trigger, projectId: ctx.projectId };
        // Slice 011 — typed client parses WorkflowRunDto; raw body emitted verbatim.
        const res = await ctx.client.fireWorkflow(`/api/workflows/${encodeURIComponent(rowId)}/fire`, body);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_fire_workflow failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_fire_workflow failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_complete_node': {
      if (!ctx.projectId) {
        return {
          content: [
            { type: 'text', text: 'pc_complete_node: PC_PROJECT_ID env not set' },
          ],
          isError: true,
        };
      }
      const runId = typeof args.workflowRunId === 'string' ? args.workflowRunId.trim() : '';
      const nodeId = typeof args.nodeId === 'string' ? args.nodeId.trim() : '';
      const decision = args.decision;
      if (!runId || !nodeId || (decision !== 'approve' && decision !== 'reject')) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_complete_node: require { workflowRunId, nodeId, decision: "approve"|"reject", notes? }',
            },
          ],
          isError: true,
        };
      }
      try {
        const body: Record<string, unknown> = { runId, nodeId, decision };
        if (typeof args.notes === 'string' && args.notes.trim()) body.notes = args.notes;
        const res = await ctx.postServer(
          ctx.projectPath('workflow-v2/review'),
          body,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_complete_node failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_complete_node failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_create_workflow': {
      if (!ctx.projectId) {
        return {
          content: [{ type: 'text', text: 'pc_create_workflow: PC_PROJECT_ID not set' }],
          isError: true,
        };
      }
      const hasDef = args.def && typeof args.def === 'object';
      const hasYaml = typeof args.yaml === 'string' && (args.yaml as string).trim().length > 0;
      if (!hasDef && !hasYaml) {
        return {
          content: [{ type: 'text', text: 'pc_create_workflow: either yaml or def required' }],
          isError: true,
        };
      }
      const scope = args.scope === 'global' ? 'global' : 'project';
      try {
        const payload: Record<string, unknown> = {
          scope,
          actor: 'orchestrator',
          reason: 'mcp-create',
          ...(scope === 'project' ? { projectId: ctx.projectId } : {}),
        };
        if (hasYaml) payload.yaml = args.yaml;
        if (hasDef) payload.def = args.def;
        const res = await ctx.postServer('/api/workflows', payload);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_create_workflow failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_create_workflow failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_update_workflow': {
      const workflowId = typeof args.id === 'string' ? args.id.trim() : '';
      if (!workflowId) {
        return {
          content: [{ type: 'text', text: 'pc_update_workflow: id required' }],
          isError: true,
        };
      }
      try {
        const payload: Record<string, unknown> = {
          actor: 'orchestrator',
          reason: 'mcp-update',
        };
        if (typeof args.yaml === 'string') payload.yaml = args.yaml;
        if (args.def && typeof args.def === 'object') payload.def = args.def;
        if (typeof args.disabled === 'boolean') payload.disabled = args.disabled;
        const res = await ctx.putServer(`/api/workflows/${encodeURIComponent(workflowId)}`, payload);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_update_workflow failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_update_workflow failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_delete_workflow': {
      const workflowId = typeof args.id === 'string' ? args.id.trim() : '';
      if (!workflowId) {
        return {
          content: [{ type: 'text', text: 'pc_delete_workflow: id required' }],
          isError: true,
        };
      }
      try {
        const cancel = args.cancel === true;
        const qs = cancel ? '?cancel=1&actor=orchestrator&reason=mcp-delete' : '?actor=orchestrator&reason=mcp-delete';
        const res = await ctx.deleteServer(`/api/workflows/${encodeURIComponent(workflowId)}${qs}`);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_delete_workflow failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_delete_workflow failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_get_workflow': {
      const workflowId = typeof args.id === 'string' ? args.id.trim() : '';
      if (!workflowId) {
        return {
          content: [{ type: 'text', text: 'pc_get_workflow: id required' }],
          isError: true,
        };
      }
      try {
        const res = await ctx.client.getWorkflow(`/api/workflows/${encodeURIComponent(workflowId)}`);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_get_workflow failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_get_workflow failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    default:
      return null;
  }
}
