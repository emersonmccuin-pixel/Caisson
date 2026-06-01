import type { ToolContext, ToolResult } from './context.ts';

export const SAVE_WORKFLOW_DRAFT_TOOL = {
  name: 'pc_save_workflow_draft',
  description:
    'Section 19.9 — push an in-progress draft of the v2 workflow currently being authored in the workflow-builder modal. Use this after each meaningful structural change (node added, edge wired, trigger set, position dragged) so the visualizer renders the workflow forming. The draft is NOT written to disk — only `pc_publish_workflow` does that. Server keys the draft by the transient PC_SESSION_ID env var (already set by the host); state clears automatically when the workflow-builder session ends. Drafts can be incomplete (missing nodes / wires) — they only need a top-level `id`. 400 on shape errors.',
  inputSchema: {
    type: 'object',
    properties: {
      def: {
        type: 'object',
        description: 'in-progress v2 workflow object: { id, name, triggers?, nodes: [...], ... }',
        additionalProperties: true,
      },
    },
    required: ['def'],
  },
} as const;

export const READ_WORKFLOW_DRAFT_TOOL = {
  name: 'pc_read_workflow_draft',
  description:
    'Section 19.9 — read the current v2 workflow-builder draft for this session. Use this at the start of edit-mode, or any time you suspect the user has dragged nodes / wired edges in the visualizer since your last `pc_save_workflow_draft` write (sync-model-A — the user can edit the graph between your turns). Returns { ok: true, def: <current draft or null> } if a draft exists; { ok: true, def: null } if none. PC_SESSION_ID env is the implicit scope.',
  inputSchema: { type: 'object', properties: {} },
} as const;

export const PUBLISH_WORKFLOW_TOOL = {
  name: 'pc_publish_workflow',
  description:
    'Section 19.17 — publish the v2 workflow to the DB-backed `/api/workflows` surface. Validates the graph (cycles, unknown node ids, `when:` grammar, trigger shape, ref integrity), upserts the row (GET → match by slug → PUT or POST), which records a `workflow.definition.changed` live-event so the Workflows tab refreshes. Returns 201 on first-write, 200 on overwrite. 400 on validation errors with per-path `errors:` array — translate to plain English and re-publish after fixing.',
  inputSchema: {
    type: 'object',
    properties: {
      def: {
        type: 'object',
        description: 'v2 workflow object: { id, name, triggers: [...], nodes: [...], description?, worktree?, max_concurrency? }',
        additionalProperties: true,
      },
    },
    required: ['def'],
  },
} as const;

export const LIST_WORKFLOWS_TOOL = {
  name: 'pc_list_workflows',
  description:
    'List workflows already authored in this project. Use this BEFORE asking the user which child workflow a nested `workflow:` step should call. Returns { valid: [{ id, fileName, ... }], invalid: [...] }; the `id` field is what goes into a nested-workflow step\'s `workflow:` field. No arguments; PC_PROJECT_ID env is the implicit scope.',
  inputSchema: { type: 'object', properties: {} },
} as const;

export const FIRE_WORKFLOW_TOOL = {
  name: 'pc_fire_workflow',
  description:
    'Fire a workflow by slug (the `id:` field, e.g. "triage") or DB ULID. Resolves the row, dispatches through the v2 executor, and returns the runId + rootWorkItemId. Use this when the user explicitly names a workflow ("run the triage workflow"). Trigger defaults to `{ kind: "manual" }`. Returns { ok: true, runId, rootWorkItemId } on success; 400 on disabled / invalid rows; 404 on unknown slug. PC_PROJECT_ID env is the implicit project scope.',
  inputSchema: {
    type: 'object',
    properties: {
      workflow: {
        type: 'string',
        description: 'workflow slug (preferred — the `id:` field in the YAML) or DB ULID',
      },
      trigger: {
        type: 'object',
        description: 'optional trigger payload. Defaults to { kind: "manual" }. For stage-on-entry, supply { kind: "stage-on-entry", stage: "<stageId>" } — but typically you fire manually.',
      },
    },
    required: ['workflow'],
  },
} as const;

export const COMPLETE_NODE_TOOL = {
  name: 'pc_complete_node',
  description:
    'Submit an orchestrator-review decision for a workflow run paused at a review node. Use when a `kind=orchestrator-review` envelope lands in chat with `{ workflowRunId, nodeId }` and you have judged the artifact. `decision: "approve"` resumes the run; `decision: "reject"` kicks back upstream (the reject loop re-fires the prior agent with your `notes` as feedback, up to `max_iterations`). Returns { ok: true, status: <new run status> } or 404 if the run / node is unknown / no longer paused. PC_PROJECT_ID env is the implicit project scope.',
  inputSchema: {
    type: 'object',
    properties: {
      workflowRunId: {
        type: 'string',
        description: 'the run id from the orchestrator-review envelope',
      },
      nodeId: {
        type: 'string',
        description: 'the review node id from the envelope',
      },
      decision: {
        type: 'string',
        enum: ['approve', 'reject'],
        description: 'approve resumes; reject kicks back upstream with notes as feedback',
      },
      notes: {
        type: 'string',
        description: 'optional — required in practice for reject so the upstream agent has feedback',
      },
    },
    required: ['workflowRunId', 'nodeId', 'decision'],
  },
} as const;

export const NODE_FAILED_TOOL = {
  name: 'pc_node_failed',
  description:
    'Signal a hard failure from a workflow agent node. Call this when you cannot produce the contracted output (bad input, missing files, unrecoverable error). The v2 subagent spawner detects this call from the JSONL transcript and closes the node as `agent-self-failed` carrying your reason. After calling, end your turn normally — do NOT call this from ad-hoc (non-workflow) dispatch. Schema: { workflowRunId, nodeId, reason }.',
  inputSchema: {
    type: 'object',
    properties: {
      workflowRunId: {
        type: 'string',
        description: 'the workflow run id from the dispatch tokens',
      },
      nodeId: {
        type: 'string',
        description: 'the node id from the dispatch tokens',
      },
      reason: {
        type: 'string',
        description: 'one-line human-readable reason surfaced in the UI',
      },
    },
    required: ['workflowRunId', 'nodeId', 'reason'],
  },
} as const;

export const CREATE_WORKFLOW_TOOL = {
  name: 'pc_create_workflow',
  description:
    'Create a new workflow in this project. Body: { yaml?, def?, scope? }. `scope` defaults to "project" (PC_PROJECT_ID is the implicit owner). Either `yaml` (raw YAML string) or `def` (workflow graph object) is required. Returns the created workflow row including `status` and `parseError` so the caller sees invalid-YAML feedback immediately.',
  inputSchema: {
    type: 'object',
    properties: {
      yaml: {
        type: 'string',
        description: 'raw YAML workflow definition (preferred for plain-text authoring)',
      },
      def: {
        type: 'object',
        description: 'workflow graph object (alternative to yaml)',
        additionalProperties: true,
      },
      scope: {
        type: 'string',
        enum: ['project', 'global'],
        description: 'default "project" — owned by PC_PROJECT_ID. Pass "global" only when the workflow should be reusable across every project.',
      },
    },
  },
} as const;

export const UPDATE_WORKFLOW_TOOL = {
  name: 'pc_update_workflow',
  description:
    'Update an existing workflow by DB id (ULID). Pass `yaml` or `def` to replace the definition; omit both to patch metadata only (`disabled`, display name). Slug is immutable — rename by duplicate + delete. Returns the updated row including `status` / `parseError` so the caller sees feedback on invalid definitions.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'workflow DB ULID' },
      yaml: { type: 'string', description: 'new YAML definition' },
      def: {
        type: 'object',
        description: 'new workflow graph object',
        additionalProperties: true,
      },
      disabled: {
        type: 'boolean',
        description: 'when true the workflow is disabled (will not fire)',
      },
    },
    required: ['id'],
  },
} as const;

export const DELETE_WORKFLOW_TOOL = {
  name: 'pc_delete_workflow',
  description:
    'Soft-delete a workflow by DB id (ULID). Returns 409 when in-flight runs exist unless `cancel: true` is passed (cancels them first). Use `pc_list_workflows` to find the id; prefer `pc_get_workflow` to read-before-delete.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'workflow DB ULID' },
      cancel: {
        type: 'boolean',
        description: 'cancel in-flight runs before deleting (appends ?cancel=1 to the request)',
      },
    },
    required: ['id'],
  },
} as const;

export const GET_WORKFLOW_TOOL = {
  name: 'pc_get_workflow',
  description:
    'Fetch the full workflow row by DB id (ULID), including the yaml text. Use this to read-before-edit so you don\'t clobber unknown fields. Returns { ok: true, workflow: { id, slug, yaml, status, parseError, ... } } or 404.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'workflow DB ULID' },
    },
    required: ['id'],
  },
} as const;

export const WORKFLOW_TOOLS = [
  SAVE_WORKFLOW_DRAFT_TOOL,
  READ_WORKFLOW_DRAFT_TOOL,
  PUBLISH_WORKFLOW_TOOL,
  LIST_WORKFLOWS_TOOL,
  FIRE_WORKFLOW_TOOL,
  COMPLETE_NODE_TOOL,
  NODE_FAILED_TOOL,
  CREATE_WORKFLOW_TOOL,
  UPDATE_WORKFLOW_TOOL,
  DELETE_WORKFLOW_TOOL,
  GET_WORKFLOW_TOOL,
] as const;

export const WORKFLOW_TOOL_NAMES = WORKFLOW_TOOLS.map((tool) => tool.name);

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

    case 'pc_save_workflow_draft': {
      const def = args.def && typeof args.def === 'object' ? args.def : null;
      if (!def) {
        return {
          content: [{ type: 'text', text: 'pc_save_workflow_draft: def required' }],
          isError: true,
        };
      }
      const sessionId = ctx.sessionId;
      if (!sessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_save_workflow_draft: PC_SESSION_ID env not set (transient workflow-builder session is the only valid caller)',
            },
          ],
          isError: true,
        };
      }
      try {
        const res = await ctx.postServer(ctx.projectPath('workflow-builder/draft'), {
          sessionId,
          def,
        });
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_save_workflow_draft failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_save_workflow_draft failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_read_workflow_draft': {
      const sessionId = ctx.sessionId;
      if (!sessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_read_workflow_draft: PC_SESSION_ID env not set (transient workflow-builder session is the only valid caller)',
            },
          ],
          isError: true,
        };
      }
      try {
        const res = await ctx.getServer(
          ctx.projectPath(`workflow-builder/draft/${encodeURIComponent(sessionId)}`),
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_read_workflow_draft failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_read_workflow_draft failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
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
