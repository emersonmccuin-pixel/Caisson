import type { ToolContext, ToolResult } from './context.ts';

export const CREATE_WORK_ITEM_TOOL = {
  name: 'pc_create_work_item',
  description:
    'Create a new work item in the given stage. Returns the new WorkItem with its generated ULID id. Use this when the user asks for a fresh card / task / item; do not seed one via pc_update_work_item. Pass `targetProjectId` to write into a different project (cross-project capture); omit to write into the current project. When `targetProjectId` is set, `stageId` is optional — the server defaults to the target project\'s first (intake) stage.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'short title for the work item' },
      stageId: {
        type: 'string',
        description: 'destination stage id (slug, e.g. "draft" / "review" / "done"). Optional when targetProjectId is set — defaults to the target project\'s first stage.',
      },
      body: { type: 'string', description: 'optional free-form body / spec' },
      targetProjectId: {
        type: 'string',
        description: 'optional project id (ULID) to write the work item into a different project. When absent the work item lands in the current project (PC_PROJECT_ID). Single-user app — no ownership gate; a future multi-user pass should revisit.',
      },
      area_id: {
        type: 'string',
        description: 'optional Area id (ULID) to file the work item under. Omit (or pass null) for Uncaptured. See pc_list_areas.',
      },
    },
    required: ['title'],
  },
} as const;

export const CREATE_AGENT_WORK_ITEM_TOOL = {
  name: 'pc_create_agent_work_item',
  description:
    "Create a dispatch contract for a subagent. Use this — NOT pc_create_work_item — whenever you're about to delegate to a specialist pod via pc_invoke_agent. The work item IS the contract: title + task (body) + pod + expected output shape (drives auto-verification of \"done\"). The new work item is_agent_task=true (hidden from the kanban by default; surfaces inline in chat). Returns the new WorkItem; pass its id to pc_invoke_agent so the worker fetches its assignment on boot. `expected_output` defaults to the pod's standard shape when omitted; override for non-standard tasks. `verification_tier` defaults to 'auto' (structured predicates). Set `ephemeral: true` for throwaway lookups (auto-archives 24h after done).",
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'short scannable title for the dispatch' },
      task: {
        type: 'string',
        description:
          "free-form task description — this becomes the work item's body and the agent reads it on boot via pc_get_work_item",
      },
      pod: {
        type: 'string',
        description:
          'pod name to dispatch (researcher / writer / code-writer / reviewer / planner / extractor / agent-designer or a custom pod). Drives default expected_output.',
      },
      expected_output: {
        type: 'object',
        description:
          "structured spec for what the agent's output should look like. kind ∈ {text, files, structured, side-effect, mixed}. Falls back to the pod's default if omitted. AC is derived from this; the agent's prompt also surfaces it so the agent knows what's being checked.",
        additionalProperties: true,
      },
      verification_tier: {
        type: 'string',
        enum: ['auto', 'orchestrator-review', 'human-review'],
        description:
          "who verifies 'done'. 'auto' (default) runs structured predicates. 'orchestrator-review' wakes you on agent-done to approve / reject. 'human-review' queues in the Human Review inbox.",
      },
      parent_work_item_id: {
        type: 'string',
        description:
          "optional parent work item id (ULID). Use to link to an in-flight workflow root or to thread agent dispatches under a parent task.",
      },
      stage_id: {
        type: 'string',
        description:
          "stage to land the work item in. Defaults to the project's first stage when omitted. Agent work items are hidden from the kanban by default regardless of stage.",
      },
      worktree: {
        type: 'string',
        description: 'optional absolute path to a worktree the agent should write into.',
      },
      ephemeral: {
        type: 'boolean',
        description:
          "true marks the work item for auto-archive 24h after reaching 'done'. Use for throwaway lookups ('what's Node LTS?'). Defaults to false.",
      },
      raw_acceptance_criteria: {
        type: 'array',
        description:
          "Escape hatch: override the derived AC predicate list. Rare-use; prefer expected_output. Each entry needs a 'kind' from: files_exist, fields_populated, field_matches, bash_exit_zero, attachments_present, body_contains, child_work_items_done.",
        items: { type: 'object', additionalProperties: true },
      },
    },
    required: ['title', 'task', 'pod'],
  },
} as const;

export const APPROVE_WORK_ITEM_TOOL = {
  name: 'pc_approve_work_item',
  description:
    "Approve a tier-2/3 agent work item that's parked in `awaiting-verification`. Flips the work item to `complete` + `verification_status: 'passed'`. Use after reading the agent's report (body / attachments / fields via pc_get_work_item) when the work meets the bar. Optional `notes` get persisted on the work item as `verificationNotes` + an audit-logged history entry. The producer agent run is already terminal — no further dispatch is triggered. `id` accepts ULID or callsign (e.g. `pc-2.1`). Fails 404 if the id is unknown, 400 if it's not an agent contract, 409 if it isn't currently awaiting verification.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'work item id (ULID or callsign like pc-2.1)' },
      notes: {
        type: 'string',
        description: 'optional reviewer note — persists on the work item + history',
      },
    },
    required: ['id'],
  },
} as const;

export const REJECT_WORK_ITEM_TOOL = {
  name: 'pc_reject_work_item',
  description:
    "Reject a tier-2/3 agent work item that's parked in `awaiting-verification` and wake the producer agent with feedback. Flips the work item to `in-progress` + `verification_status: 'failed'` with the feedback in `verificationNotes`, then spawns a continuation of the producer's agent run (via the Section 21 `pc_continue_agent` primitive) so the same agent gets the feedback in its conversation and tries again. Returns `{ ok, workItem, continuation: { ok, runId, sessionId, agentName, status, continues } }` so you can track the new run. `id` accepts ULID or callsign (e.g. `pc-2.1`). `feedback` is required + non-empty. Fails 404 if the id is unknown, 400 if it's not an agent contract or feedback is missing, 409 if it isn't currently awaiting verification or has no assigned agent run.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'work item id (ULID or callsign like pc-2.1)' },
      feedback: {
        type: 'string',
        description:
          "free-form rejection feedback — what's wrong, what the agent should do differently. Becomes the agent's next user message on resume.",
      },
    },
    required: ['id', 'feedback'],
  },
} as const;

export const LOG_BUG_TOOL = {
  name: 'pc_log_bug',
  description:
    "File a bug in the user's Caisson dogfood tracker, no matter which project this chat is bound to. Reads the target project id from GlobalSettings.bugLogTargetProjectId; if unset, returns an error telling the user to configure 'Bug log target' in App Settings. The new work item is created with type='bug', dropped into the target project's FIRST stage, and the body is prefixed with 'Logged from project: <source-name> · session: <id>' so the bug carries its origin context. Use whenever the user says something like 'log a bug', 'log this as a bug', 'file a bug report', or otherwise reports a defect they want tracked.",
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'short, scannable bug title' },
      description: {
        type: 'string',
        description: 'free-form bug description (steps, expected, actual, anything useful). Optional but strongly recommended.',
      },
    },
    required: ['title'],
  },
} as const;

export const MOVE_WORK_ITEM_TOOL = {
  name: 'pc_move_work_item',
  description:
    "Move a work item to a different stage. Pass EITHER `toStage` (an explicit stage slug) OR `toFlag` (one of 'done' | 'cancelled' | 'new' — the system resolves to whichever stage carries that flag, surviving renames). When the destination has an `on_enter` workflow trigger, that workflow fires automatically against the bound wi-<id> worktree. Landing in an is_done stage flips status to `complete`; is_cancelled → `cancelled`. Use the optional `notes` to capture a reason (e.g. when cancelling) — lands on the card's move history. `id` accepts ULID or callsign (e.g. `pc-2.1`).",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'work item id (ULID or callsign like pc-2.1)' },
      toStage: {
        type: 'string',
        description: 'destination stage id (use exactly one of toStage / toFlag)',
      },
      toFlag: {
        type: 'string',
        enum: ['done', 'cancelled', 'new'],
        description:
          "resolve the destination stage by flag instead of slug. 'done' = terminal-success stage; 'cancelled' = terminal-abandon stage; 'new' = intake stage. Errors if no stage in the project carries that flag.",
      },
      notes: {
        type: 'string',
        description: "optional free-form line saved to the card's move-history entry (cancellation reason, context).",
      },
    },
    required: ['id'],
  },
} as const;

export const UPDATE_WORK_ITEM_TOOL = {
  name: 'pc_update_work_item',
  description:
    'Merge fields and/or set body/title on a work item. At least one of fields, body, or title is required. `id` accepts ULID or callsign (e.g. `pc-2.1`).',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'work item id (ULID or callsign like pc-2.1)' },
      title: { type: 'string', description: 'new title for the work item' },
      body: {
        type: 'string',
        description: 'new body / spec for the work item (replaces current body)',
      },
      fields: {
        type: 'object',
        description: 'fields to merge into workItem.fields (shallow merge)',
        additionalProperties: true,
      },
      area_id: {
        type: 'string',
        description: 'set the work item\'s Area (ULID). Pass null to move it to Uncaptured. See pc_list_areas.',
      },
    },
    required: ['id'],
  },
} as const;

export const LIST_AREAS_TOOL = {
  name: 'pc_list_areas',
  description:
    'List the project\'s Areas — first-class buckets a work item can belong to (or none, "Uncaptured"). Use this to discover Area ids before filing/assigning a work item to an Area. Returns { areas: [{ id, name, summary, sortOrder, ... }, ...] } ordered by sortOrder. No arguments; PC_PROJECT_ID env is the implicit scope.',
  inputSchema: { type: 'object', properties: {} },
} as const;

export const GET_WORK_ITEM_TOOL = {
  name: 'pc_get_work_item',
  description:
    'Fetch the full work item by id or callsign — title, body, fields, stage, status, parent. Use this when an agent needs to read the work item it is operating on without filesystem digging. `id` accepts ULID or callsign (e.g. `pc-2.1`). Returns { ok: true, workItem } (the workItem includes `callsign` when present, NULL for agent contracts) or { ok: false, error } for unknown / archived ids.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'work item id (ULID or callsign like pc-2.1)' },
      includeArchived: {
        type: 'boolean',
        description: 'when true, also returns soft-deleted work items',
      },
    },
    required: ['id'],
  },
} as const;

export const LIST_WORK_ITEMS_TOOL = {
  name: 'pc_list_work_items',
  description:
    'List work items in this project. Use this when the orchestrator / an agent needs to find a card by some property (title fragment, stage, parent) rather than knowing its ULID up front. Optional filters: `stage` (stage id slug), `parentId` (a ULID, or `""` for top-level only), `includeArchived` (boolean, default false). When called with no filters, returns the project\'s full work-item set (the same shape the kanban renders from). PC_PROJECT_ID env is the implicit scope.',
  inputSchema: {
    type: 'object',
    properties: {
      stage: { type: 'string', description: 'optional: stage slug to filter by' },
      parentId: {
        type: 'string',
        description:
          "optional: parent work item ULID, or empty string '' to only return top-level items",
      },
      includeArchived: {
        type: 'boolean',
        description: 'when true, also returns soft-deleted work items',
      },
      limit: { type: 'number', description: 'optional: cap on rows returned' },
      cursor: { type: 'string', description: 'optional: pagination cursor (ULID)' },
    },
  },
} as const;

export const ATTACH_TO_WORK_ITEM_TOOL = {
  name: 'pc_attach_to_work_item',
  description:
    'Attach a text/markdown/JSON payload to a work item. The default destination for agent output per Section 3 D13 (the "report I will read later" path). Server stamps provenance: source = "agent" + the passed agentName + nodeId + workflowRunId. `workItemId` accepts ULID or callsign (e.g. `pc-2.1`). Returns { ok: true, attachment } or { ok: false, error }.',
  inputSchema: {
    type: 'object',
    properties: {
      workItemId: { type: 'string', description: 'destination work item id (ULID or callsign like pc-2.1)' },
      name: { type: 'string', description: 'attachment display name' },
      content: { type: 'string', description: 'attachment body (inline; no filesystem path variant)' },
      kind: {
        type: 'string',
        description: 'free-form kind tag — known set: text / markdown / json. Defaults to "markdown".',
      },
      contentType: { type: 'string', description: 'optional MIME type' },
      agentName: { type: 'string', description: 'name of the agent producing this attachment' },
      workflowRunId: {
        type: 'string',
        description: 'workflow run id from the dispatch envelope ([workflowRunId: ...])',
      },
      nodeId: {
        type: 'string',
        description: 'workflow node id from the dispatch envelope ([nodeId: ...])',
      },
    },
    required: ['workItemId', 'name', 'content'],
  },
} as const;

export const WORK_ITEM_TOOLS = [
  CREATE_WORK_ITEM_TOOL,
  CREATE_AGENT_WORK_ITEM_TOOL,
  APPROVE_WORK_ITEM_TOOL,
  REJECT_WORK_ITEM_TOOL,
  LOG_BUG_TOOL,
  MOVE_WORK_ITEM_TOOL,
  UPDATE_WORK_ITEM_TOOL,
  GET_WORK_ITEM_TOOL,
  LIST_WORK_ITEMS_TOOL,
  LIST_AREAS_TOOL,
  ATTACH_TO_WORK_ITEM_TOOL,
] as const;

export const WORK_ITEM_TOOL_NAMES = WORK_ITEM_TOOLS.map((tool) => tool.name);

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
      if (bodyText !== undefined) payload.body = (bodyText + originNote).trim();
      else if (originNote) payload.body = originNote.trim();
      try {
        // Slice 011 — route through the typed client (parses WorkItemDto for
        // internal type-safety); emit the raw body verbatim (byte-compat).
        const res = await ctx.client.createWorkItem(targetPath, payload);
        if (res.status >= 200 && res.status < 300) {
          return ctx.withRichLinkHint(res.body);
        }
        return {
          content: [{ type: 'text', text: `pc_create_work_item failed (${res.status}): ${res.body}` }],
          isError: true,
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
      if (typeof args.ephemeral === 'boolean') payload.ephemeral = args.ephemeral;
      if (args.raw_acceptance_criteria !== undefined)
        payload.raw_acceptance_criteria = args.raw_acceptance_criteria;
      try {
        const res = await ctx.postServer(
          ctx.projectPath('work-items/create-agent-contract'),
          payload,
        );
        if (res.status >= 200 && res.status < 300) {
          return ctx.withRichLinkHint(res.body);
        }
        return {
          content: [
            {
              type: 'text',
              text: `pc_create_agent_work_item failed (${res.status}): ${res.body}`,
            },
          ],
          isError: true,
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

    case 'pc_approve_work_item': {
      const ref = typeof args.id === 'string' ? args.id.trim() : '';
      if (!ref) {
        return {
          content: [{ type: 'text', text: 'pc_approve_work_item: id required' }],
          isError: true,
        };
      }
      if (!ctx.projectId) {
        return {
          content: [{ type: 'text', text: 'pc_approve_work_item: PC_PROJECT_ID not set' }],
          isError: true,
        };
      }
      const id = await ctx.resolveWorkItemIdViaServer(ref);
      if (!id) {
        return {
          content: [{ type: 'text', text: `pc_approve_work_item: unknown work item: ${ref}` }],
          isError: true,
        };
      }
      const payload: Record<string, unknown> = {};
      if (typeof args.notes === 'string') payload.notes = args.notes;
      try {
        const res = await ctx.postServer(
          `/api/projects/${ctx.projectId}/work-items/${encodeURIComponent(id)}/approve`,
          payload,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_approve_work_item failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_approve_work_item failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_reject_work_item': {
      const ref = typeof args.id === 'string' ? args.id.trim() : '';
      const feedback = typeof args.feedback === 'string' ? args.feedback : '';
      if (!ref || !feedback.trim()) {
        return {
          content: [
            { type: 'text', text: 'pc_reject_work_item: id and non-empty feedback required' },
          ],
          isError: true,
        };
      }
      if (!ctx.projectId) {
        return {
          content: [{ type: 'text', text: 'pc_reject_work_item: PC_PROJECT_ID not set' }],
          isError: true,
        };
      }
      if (!ctx.dispatcherSessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_reject_work_item: PC_SESSION_ID / PC_DISPATCHER_SESSION_ID not set',
            },
          ],
          isError: true,
        };
      }
      const id = await ctx.resolveWorkItemIdViaServer(ref);
      if (!id) {
        return {
          content: [{ type: 'text', text: `pc_reject_work_item: unknown work item: ${ref}` }],
          isError: true,
        };
      }
      try {
        const res = await ctx.postServer(
          `/api/projects/${ctx.projectId}/work-items/${encodeURIComponent(id)}/reject`,
          { feedback, dispatcherSessionId: ctx.dispatcherSessionId },
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_reject_work_item failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_reject_work_item failed: ${(err as Error).message}` },
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
      if (!ref) {
        return { content: [{ type: 'text', text: 'pc_update_work_item: id required' }], isError: true };
      }
      if (!fields && bodyText === undefined && titleText === undefined && !areaIdProvided) {
        return {
          content: [{ type: 'text', text: 'pc_update_work_item: at least one of fields, body, title, or area_id required' }],
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
      if (!id) {
        return { content: [{ type: 'text', text: 'pc_get_work_item: id required' }], isError: true };
      }
      try {
        const suffix = `work-items/${encodeURIComponent(id)}${includeArchived ? '?includeArchived=1' : ''}`;
        const res = await ctx.client.getWorkItem(ctx.projectPath(suffix));
        if (res.status >= 200 && res.status < 300) {
          return ctx.withRichLinkHint(res.body);
        }
        return {
          content: [{ type: 'text', text: `pc_get_work_item failed (${res.status}): ${res.body}` }],
          isError: true,
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
      const query = q.toString();
      const suffix = `work-items${query ? `?${query}` : ''}`;
      try {
        const res = await ctx.client.listWorkItems(ctx.projectPath(suffix));
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

    case 'pc_list_areas': {
      try {
        const res = await ctx.client.listAreas(ctx.projectPath('areas'));
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

    default:
      return null;
  }
}
