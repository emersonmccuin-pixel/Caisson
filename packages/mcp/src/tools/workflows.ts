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
        const body: Record<string, unknown> = { projectId: ctx.projectId };
        if (typeof args.work_item_id === 'string' && args.work_item_id.trim()) {
          body.workItemId = args.work_item_id.trim();
        }
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
        // 409 = idempotent already-resolved (build-plan step 6): the decision
        // was already committed (e.g. transport drop on a prior call that DID
        // commit server-side). Return a non-fatal "already resolved" so the
        // orchestrator doesn't retry as a hard failure.
        if (res.status === 409) {
          return {
            content: [
              {
                type: 'text',
                text: `pc_complete_node: gate already resolved — no-op (the decision was already committed). ${res.body}`,
              },
            ],
          };
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

    // M3a — the run-diary read (FD-11): one run's state + its readable story.
    case 'pc_get_workflow_run': {
      const runId = typeof args.runId === 'string' ? args.runId.trim() : '';
      if (!runId) {
        return {
          content: [{ type: 'text', text: 'pc_get_workflow_run: runId required' }],
          isError: true,
        };
      }
      if (!ctx.projectId) {
        return {
          content: [
            { type: 'text', text: 'pc_get_workflow_run: PC_PROJECT_ID env not set — requires a project scope.' },
          ],
          isError: true,
        };
      }
      try {
        const res = await ctx.getServer(
          `/api/projects/${encodeURIComponent(ctx.projectId)}/workflow-v2/runs/${encodeURIComponent(runId)}`,
        );
        if (res.status < 200 || res.status >= 300) {
          return {
            content: [{ type: 'text', text: `pc_get_workflow_run failed (${res.status}): ${res.body}` }],
            isError: true,
          };
        }
        const parsed = JSON.parse(res.body) as {
          run?: {
            id: string;
            workflowName?: string;
            status: string;
            lastReason?: string | null;
            startedAt?: number | null;
            endedAt?: number | null;
          };
          events?: Array<{
            type: string;
            nodeId: string | null;
            data: Record<string, unknown> | null;
            at: number;
          }>;
        };
        const run = parsed.run;
        if (!run) {
          return {
            content: [{ type: 'text', text: `pc_get_workflow_run: run ${runId} not found` }],
            isError: true,
          };
        }
        const diary = (parsed.events ?? []).map((ev) => ({
          at: ev.at,
          line: diaryLine(ev),
          type: ev.type,
          nodeId: ev.nodeId,
          data: ev.data,
        }));
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                run: {
                  id: run.id,
                  workflowName: run.workflowName,
                  status: run.status,
                  lastReason: run.lastReason ?? null,
                  startedAt: run.startedAt ?? null,
                  endedAt: run.endedAt ?? null,
                },
                diary,
              }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_get_workflow_run failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    // M6 slice C — FD-11 lifecycle: cancel-for-real + the repair-loop resume.
    case 'pc_cancel_workflow_run':
    case 'pc_resume_workflow_run': {
      const action = name === 'pc_cancel_workflow_run' ? 'cancel' : 'resume';
      const runId = typeof args.runId === 'string' ? args.runId.trim() : '';
      if (!runId) {
        return {
          content: [{ type: 'text', text: `${name}: runId required` }],
          isError: true,
        };
      }
      if (!ctx.projectId) {
        return {
          content: [
            { type: 'text', text: `${name}: PC_PROJECT_ID env not set — requires a project scope.` },
          ],
          isError: true,
        };
      }
      try {
        const res = await ctx.postServer(
          `/api/projects/${encodeURIComponent(ctx.projectId)}/workflow-v2/runs/${encodeURIComponent(runId)}/${action}`,
          {},
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `${name} failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `${name} failed: ${(err as Error).message}` }],
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

/** M3a — one diary row → one plain-English line. Dual-audience rule: the
 *  orchestrator narrates these to a non-technical user, so lead with what
 *  happened in normal words; ids stay in the structured fields alongside. */
function diaryLine(ev: {
  type: string;
  nodeId: string | null;
  data: Record<string, unknown> | null;
}): string {
  const node = ev.nodeId ? `step "${ev.nodeId}"` : 'the run';
  const d = ev.data ?? {};
  switch (ev.type) {
    case 'workflow_started':
      return `Run started (trigger: ${String(d.trigger ?? 'manual')}).`;
    case 'workflow_completed':
      return 'Run completed.';
    case 'workflow_failed':
      return 'Run failed.';
    case 'workflow_cancelled':
      return 'Run cancelled.';
    case 'run_interrupted':
      return `Run interrupted — the server restarted with it in flight (${String(d.reason ?? 'interrupted-on-boot')}).`;
    case 'node_started':
      return `${cap(node)} started.`;
    case 'node_completed':
      return `${cap(node)} completed.`;
    case 'node_failed':
      return `${cap(node)} failed${d.error ? ` — ${String(d.error)}` : ''}.`;
    case 'node_skipped':
      return `${cap(node)} skipped${d.reason ? ` (${String(d.reason)})` : ''}.`;
    case 'agent_dispatched':
      return `${cap(node)}: agent "${String(d.agent ?? '?')}" dispatched (agentRunId ${String(d.agentRunId ?? '?')} — inspectable via pc_inspect_agent_run).`;
    case 'review_requested':
      return `Review requested at ${node}.`;
    case 'review_approved':
      return `Review at ${node} approved.`;
    case 'review_rejected':
      return `Review at ${node} rejected — the work goes back for another round.`;
    case 'iteration_ceiling_hit':
      return `Reject ceiling reached at ${node} — held for a human decision.`;
    case 'card_moved':
      return d.error
        ? `Card move to "${String((d.stage as string) ?? '?')}" FAILED — ${String(d.error)}.`
        : `Card moved to "${String((d.stage as string) ?? '?')}".`;
    default:
      return `${ev.type}${ev.nodeId ? ` (${ev.nodeId})` : ''}.`;
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
