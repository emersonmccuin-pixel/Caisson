import type { ToolContext, ToolResult } from './context.ts';

export const INVOKE_AGENT_TOOL = {
  name: 'pc_invoke_agent',
  description:
    "Dispatch a named agent (kebab-case, e.g. \"researcher\") in this project. Always async — returns `{ ok, mode: 'async', sessionId, runId, agentName, startedAt, status }` immediately. The terminal `agent-completed` / `agent-failed` channel event lands on your next turn (handler protocol entries #4 + #5). For any non-trivial dispatch, call `pc_create_agent_work_item` first and pass the returned id as `workItemId` — the agent then knows its task, expected output, and acceptance criteria via the work item rather than a sprawling input string (keep `input` to \"Begin.\" or a one-liner pointer). Optional `parentWorkItemId` pins the child to a parent work-item for lineage — defaults to `PC_AGENT_PARENT_WORK_ITEM_ID` when called from inside another agent. The project route URL is derived from `PC_PROJECT_ID`.",
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'pod name (kebab-case)' },
      input: {
        type: 'string',
        description:
          "free-form input — becomes the child's first user message. When you also pass workItemId, keep this trivial (\"Begin.\" or shorter); the agent reads its task from the work item, not from here.",
      },
      workItemId: {
        type: 'string',
        description:
          'work-item ULID this dispatch is assigned to. The agent fetches it via pc_get_work_item as its first action and reads body / acceptance_criteria / attachments from there. Create via pc_create_agent_work_item.',
      },
      parentWorkItemId: {
        type: 'string',
        description:
          'optional parent work-item ULID for lineage (not the assignment — that is `workItemId`); defaults to PC_AGENT_PARENT_WORK_ITEM_ID',
      },
    },
    required: ['name', 'input'],
  },
} as const;

export const CONTINUE_AGENT_TOOL = {
  name: 'pc_continue_agent',
  description:
    "Resume a recent terminal agent run (`completed` or `failed`) with a follow-up input by spawning via `--resume <ccSessionId>` — the prior conversation is preserved so phrase your input as a continuation, not a fresh ask. Cancelled runs cannot be continued; start a fresh dispatch. Single-active-continuation guard per parent (409 on concurrent). JSONL retention guard (410 on session-expired). Optional `workItemId` re-anchors the resumed run to a (possibly different) work-item contract; omit to carry the parent run's assignment forward. Returns the same shape as `pc_invoke_agent`.",
  inputSchema: {
    type: 'object',
    properties: {
      runId: { type: 'string', description: 'ULID of the prior AgentRun to continue' },
      input: {
        type: 'string',
        description:
          "free-form follow-up — becomes the next user message in the resumed conversation. Phrase as a continuation, not a fresh request.",
      },
      workItemId: {
        type: 'string',
        description:
          'optional work-item ULID. Omitted = inherit the parent run\'s assignment. Supply when the follow-up swaps in a new contract (rare).',
      },
    },
    required: ['runId', 'input'],
  },
} as const;

export const LIST_MY_RUNS_TOOL = {
  name: 'pc_list_my_runs',
  description:
    "List recent agent runs YOU dispatched in this project (scoped to caller's `pc_session_id`). Use when you've lost track of a runId and need to pick one to continue via `pc_continue_agent`. Filters: `agentName`, `status`, `limit` (default 20, max 100). Newest-first. Row shape: `{ runId, agentName, status, dispatchedAt, completedAt, summary, continues }`.",
  inputSchema: {
    type: 'object',
    properties: {
      agentName: {
        type: 'string',
        description: 'optional — filter by pod name (kebab-case)',
      },
      status: {
        type: 'string',
        enum: ['queued', 'spawning', 'running', 'paused', 'completed', 'failed', 'cancelled'],
        description:
          'optional — filter by persisted status (full state machine).',
      },
      limit: {
        type: 'number',
        description: 'optional — cap on returned rows. Default 20, max 100.',
      },
    },
    required: [],
  },
} as const;

export const ASK_ORCHESTRATOR_TOOL = {
  name: 'pc_ask_orchestrator',
  description:
    "Pause your run and ask the dispatcher a question. Returns `{ ok, pendingAskId, status: 'waiting' }` immediately; the answer arrives as the next user message when your session resumes via --resume. After calling, do not call any other tools and end your turn naturally. Requires `PC_AGENT_RUN_ID` + `PC_DISPATCHER_SESSION_ID` in env (set by the spawn path).",
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'the question to ask the orchestrator' },
      context: {
        type: 'string',
        description:
          'optional context — recent transcript snippet, files inspected, candidate options',
      },
    },
    required: ['question'],
  },
} as const;

export const ASK_USER_TOOL = {
  name: 'pc_ask_user',
  description:
    "Pause your run and route a question to the user via the orchestrator-as-proxy. Returns `{ ok, pendingAskId, status: 'waiting' }` immediately; the answer arrives as the next user message when your session resumes. After calling, do not call any other tools and end your turn naturally. Use this when the question genuinely needs the human; use `pc_ask_orchestrator` first if the orchestrator might know from project context. Multi-choice `options` array supported.",
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'the question to surface to the user' },
      context: {
        type: 'string',
        description: 'optional context — what you tried, why you need the user',
      },
      options: {
        type: 'array',
        description:
          'optional multi-choice options ([{value, label}, ...]). When supplied, the orchestrator renders them as a numbered list; the user reply will be one of the option values.',
        items: {
          type: 'object',
          properties: {
            value: { type: 'string', description: 'machine value returned as the answer' },
            label: { type: 'string', description: 'user-facing label for this choice' },
          },
          required: ['value', 'label'],
        },
      },
    },
    required: ['question'],
  },
} as const;

export const REQUEST_APPROVAL_TOOL = {
  name: 'pc_request_approval',
  description:
    "Pause your run and request explicit human approval for a decision. Returns `{ ok, pendingAskId, status: 'waiting' }` immediately; the user's decision arrives as the next user message when your session resumes. Use this when proceeding requires explicit go/no-go (destructive operations, irreversible writes). `options` is required and must be non-empty.",
  inputSchema: {
    type: 'object',
    properties: {
      decision: {
        type: 'string',
        description:
          'the decision the user is being asked to approve — what will happen, in plain English',
      },
      options: {
        type: 'array',
        description: 'non-empty list of approval choices ([{value, label}, ...])',
        items: {
          type: 'object',
          properties: {
            value: { type: 'string', description: 'machine value returned as the answer' },
            label: { type: 'string', description: 'user-facing label for this choice' },
          },
          required: ['value', 'label'],
        },
      },
      context: {
        type: 'string',
        description:
          'optional context — what produced this decision, alternatives, what the user should weigh',
      },
    },
    required: ['decision', 'options'],
  },
} as const;

export const ANSWER_PENDING_TOOL = {
  name: 'pc_answer_pending',
  description:
    'Resume a paused agent with an answer. Atomic open→answered flip. Idempotent: a second call returns `cause: "already-answered"`. Pod-revision drift (pod edited between dispatch and resume) surfaces in the response as `podRevisionDrifted: true`. Orchestrator usage only — agents that need to forward an answer should use pc_ask_orchestrator instead.',
  inputSchema: {
    type: 'object',
    properties: {
      pendingAskId: { type: 'string', description: 'pending-ask ULID from the agent-asks-* event' },
      answer: { type: 'string', description: 'the answer to thread back into the paused agent' },
      answeredBy: {
        type: 'string',
        enum: ['orchestrator', 'user'],
        description:
          '"orchestrator" when answered from your own context, "user" when forwarding the user\'s reply',
      },
    },
    required: ['pendingAskId', 'answer', 'answeredBy'],
  },
} as const;

export const INSPECT_AGENT_RUN_TOOL = {
  name: 'pc_inspect_agent_run',
  description:
    "Peek at a single agent run: current status, OS pid + whether that process is still alive, how long since its last activity (idleMs), and the last thing it did (last JSONL action). Use this to tell a working run from a wedged one before deciding to wait or kill. Returns `{ ok, inspection: { runId, status, pid, processAlive, lastActivityAt, idleMs, lastAction, ... } }`. Read-only.",
  inputSchema: {
    type: 'object',
    properties: {
      runId: { type: 'string', description: 'ULID of the agent run to inspect' },
    },
    required: ['runId'],
  },
} as const;

export const KILL_AGENT_RUN_TOOL = {
  name: 'pc_kill_agent_run',
  description:
    "Force-end an agent run NOW: kills the real OS process (its persisted pid + child tree) AND finalizes the run row to `cancelled` with full effects (rail + dispatcher notify). Unlike a graceful cancel this works on a PHANTOM — a run wedged or whose in-memory handle was lost. Idempotent: an already-terminal run returns ok without re-killing. Use when `pc_inspect_agent_run` shows a run stuck with no activity. Returns `{ ok, status, alreadyTerminal, processKilled }`.",
  inputSchema: {
    type: 'object',
    properties: {
      runId: { type: 'string', description: 'ULID of the agent run to force-kill' },
    },
    required: ['runId'],
  },
} as const;

export const AGENT_RUN_TOOLS = [
  INVOKE_AGENT_TOOL,
  CONTINUE_AGENT_TOOL,
  LIST_MY_RUNS_TOOL,
  INSPECT_AGENT_RUN_TOOL,
  KILL_AGENT_RUN_TOOL,
  ASK_ORCHESTRATOR_TOOL,
  ASK_USER_TOOL,
  REQUEST_APPROVAL_TOOL,
  ANSWER_PENDING_TOOL,
] as const;

export const AGENT_RUN_TOOL_NAMES = AGENT_RUN_TOOLS.map((tool) => tool.name);

export async function handleAgentRunTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult | null> {
  switch (name) {
    case 'pc_invoke_agent': {
      const agentName = typeof args.name === 'string' ? args.name.trim() : '';
      const input = typeof args.input === 'string' ? args.input : '';
      if (!agentName || !input.trim()) {
        return {
          content: [{ type: 'text', text: 'pc_invoke_agent: name and input required' }],
          isError: true,
        };
      }
      if (!ctx.projectId) {
        return {
          content: [
            { type: 'text', text: 'pc_invoke_agent: PC_PROJECT_ID not set' },
          ],
          isError: true,
        };
      }
      if (!ctx.dispatcherSessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_invoke_agent: PC_SESSION_ID (orchestrator) or PC_DISPATCHER_SESSION_ID (agent) not set',
            },
          ],
          isError: true,
        };
      }
      const parentWorkItemId =
        typeof args.parentWorkItemId === 'string' && args.parentWorkItemId.trim()
          ? args.parentWorkItemId.trim()
          : ctx.agentParentWorkItemId || undefined;
      const workItemId =
        typeof args.workItemId === 'string' && args.workItemId.trim()
          ? args.workItemId.trim()
          : undefined;
      const rawDepth = Number(ctx.agentInvokeDepth ?? 0);
      const parentInvokeDepth =
        Number.isFinite(rawDepth) && rawDepth > 0 ? Math.floor(rawDepth) : 0;
      const payload: Record<string, unknown> = {
        input,
        parentInvokeDepth,
        dispatcherSessionId: ctx.dispatcherSessionId,
      };
      if (parentWorkItemId) payload.parentWorkItemId = parentWorkItemId;
      if (workItemId) payload.workItemId = workItemId;
      try {
        // Slice 011 — typed client parses AgentRunDto; raw body emitted verbatim.
        const res = await ctx.client.invokeAgent(
          `/api/projects/${ctx.projectId}/agents/${encodeURIComponent(agentName)}/invoke`,
          payload,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_invoke_agent failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_invoke_agent failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_continue_agent': {
      const runId = typeof args.runId === 'string' ? args.runId.trim() : '';
      const input = typeof args.input === 'string' ? args.input : '';
      if (!runId || !input.trim()) {
        return {
          content: [{ type: 'text', text: 'pc_continue_agent: runId and input required' }],
          isError: true,
        };
      }
      if (!ctx.projectId) {
        return {
          content: [
            { type: 'text', text: 'pc_continue_agent: PC_PROJECT_ID not set' },
          ],
          isError: true,
        };
      }
      if (!ctx.dispatcherSessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_continue_agent: PC_SESSION_ID / PC_DISPATCHER_SESSION_ID not set',
            },
          ],
          isError: true,
        };
      }
      const continueWorkItemId =
        typeof args.workItemId === 'string' && args.workItemId.trim()
          ? args.workItemId.trim()
          : undefined;
      try {
        const continuePayload: Record<string, unknown> = {
          input,
          dispatcherSessionId: ctx.dispatcherSessionId,
        };
        if (continueWorkItemId) continuePayload.workItemId = continueWorkItemId;
        const res = await ctx.client.continueAgent(
          `/api/projects/${ctx.projectId}/agent-runs/${encodeURIComponent(runId)}/continue`,
          continuePayload,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_continue_agent failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_continue_agent failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_list_my_runs': {
      if (!ctx.projectId) {
        return {
          content: [{ type: 'text', text: 'pc_list_my_runs: PC_PROJECT_ID not set' }],
          isError: true,
        };
      }
      if (!ctx.dispatcherSessionId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_list_my_runs: PC_SESSION_ID / PC_DISPATCHER_SESSION_ID not set',
            },
          ],
          isError: true,
        };
      }
      const params = new URLSearchParams();
      params.set('dispatcherSessionId', ctx.dispatcherSessionId);
      if (typeof args.agentName === 'string' && args.agentName.trim()) {
        params.set('agentName', args.agentName.trim());
      }
      if (typeof args.status === 'string' && args.status.trim()) {
        params.set('status', args.status.trim());
      }
      if (typeof args.limit === 'number' && Number.isFinite(args.limit)) {
        params.set('limit', String(Math.floor(args.limit)));
      }
      try {
        const res = await ctx.getServer(
          `/api/projects/${ctx.projectId}/agent-runs/by-dispatcher?${params.toString()}`,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_list_my_runs failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_list_my_runs failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_inspect_agent_run': {
      const runId = typeof args.runId === 'string' ? args.runId.trim() : '';
      if (!runId) {
        return {
          content: [{ type: 'text', text: 'pc_inspect_agent_run: runId required' }],
          isError: true,
        };
      }
      if (!ctx.projectId) {
        return {
          content: [{ type: 'text', text: 'pc_inspect_agent_run: PC_PROJECT_ID not set' }],
          isError: true,
        };
      }
      try {
        const res = await ctx.getServer(
          `/api/projects/${ctx.projectId}/agent-runs/${encodeURIComponent(runId)}/inspect`,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_inspect_agent_run failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_inspect_agent_run failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_kill_agent_run': {
      const runId = typeof args.runId === 'string' ? args.runId.trim() : '';
      if (!runId) {
        return {
          content: [{ type: 'text', text: 'pc_kill_agent_run: runId required' }],
          isError: true,
        };
      }
      if (!ctx.projectId) {
        return {
          content: [{ type: 'text', text: 'pc_kill_agent_run: PC_PROJECT_ID not set' }],
          isError: true,
        };
      }
      try {
        const res = await ctx.postServer(
          `/api/projects/${ctx.projectId}/agent-runs/${encodeURIComponent(runId)}/kill`,
          {},
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_kill_agent_run failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_kill_agent_run failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    case 'pc_ask_orchestrator':
    case 'pc_ask_user':
    case 'pc_request_approval': {
      const toolName = name;
      const isApproval = toolName === 'pc_request_approval';
      const isAskUser = toolName === 'pc_ask_user';
      const promptField = isApproval ? 'decision' : 'question';
      const promptValue =
        typeof args[promptField] === 'string' ? (args[promptField] as string).trim() : '';
      const context = typeof args.context === 'string' ? args.context : undefined;
      const options = Array.isArray(args.options) ? args.options : undefined;
      if (!promptValue) {
        return {
          content: [{ type: 'text', text: `${toolName}: ${promptField} required` }],
          isError: true,
        };
      }
      if (isApproval && (!options || options.length === 0)) {
        return {
          content: [{ type: 'text', text: `${toolName}: options required (non-empty array)` }],
          isError: true,
        };
      }
      if (!ctx.agentRunId) {
        return {
          content: [
            {
              type: 'text',
              text: `${toolName}: PC_AGENT_RUN_ID not set — only v2-dispatched agents can pause-and-ask`,
            },
          ],
          isError: true,
        };
      }
      if (!ctx.projectId) {
        return {
          content: [{ type: 'text', text: `${toolName}: PC_PROJECT_ID not set` }],
          isError: true,
        };
      }
      const kind: 'orchestrator' | 'user' | 'approval' = isApproval
        ? 'approval'
        : isAskUser
          ? 'user'
          : 'orchestrator';
      const payload: Record<string, unknown> = {
        agentRunId: ctx.agentRunId,
        kind,
        promptBody: promptValue,
      };
      if (context !== undefined) payload.context = context;
      if (options !== undefined) payload.options = options;
      try {
        const res = await ctx.client.createPendingAsk(ctx.projectPath('agent-pending-asks'), payload);
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
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

    case 'pc_answer_pending': {
      const pendingAskId = typeof args.pendingAskId === 'string' ? args.pendingAskId.trim() : '';
      const answer = typeof args.answer === 'string' ? args.answer : '';
      const answeredByRaw = typeof args.answeredBy === 'string' ? args.answeredBy : '';
      if (!pendingAskId || !answer) {
        return {
          content: [
            { type: 'text', text: 'pc_answer_pending: pendingAskId and answer required' },
          ],
          isError: true,
        };
      }
      if (answeredByRaw !== 'orchestrator' && answeredByRaw !== 'user') {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_answer_pending: answeredBy must be "orchestrator" or "user"',
            },
          ],
          isError: true,
        };
      }
      try {
        const res = await ctx.client.answerPendingAsk(
          ctx.projectPath(`agent-pending-asks/${encodeURIComponent(pendingAskId)}/answer`),
          { answer, answeredBy: answeredByRaw },
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_answer_pending failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_answer_pending failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    default:
      return null;
  }
}
