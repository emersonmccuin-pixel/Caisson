import type { ToolContext, ToolResult } from './context.ts';

// Slice 016 — the per-tool *_TOOL consts (name + description + inputSchema)
// were relocated VERBATIM into @pc/domain PC_RIG_TOOL_REGISTRY (the single
// canonical pc-rig tool metadata source). This file now owns only the
// executable handler (localhost-HTTP dispatch).

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
      // Slice 019 (contract-first) — the dispatch may carry its own expected
      // output spec; the server authors it onto the contract. snake_case in,
      // camelCase out (route convention).
      const expectedOutput =
        args.expected_output && typeof args.expected_output === 'object'
          ? args.expected_output
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
      if (expectedOutput) payload.expectedOutput = expectedOutput;
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

    // ☠ M7 (FD-6, 2026-06-04) — `pc_ask_user` case deleted: ONE ask door.
    case 'pc_ask_orchestrator':
    case 'pc_request_approval': {
      const toolName = name;
      const isApproval = toolName === 'pc_request_approval';
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
      const kind: 'orchestrator' | 'approval' = isApproval ? 'approval' : 'orchestrator';
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

    case 'pc_get_contract': {
      // M5 (FD-5 addendum) — the agent reads its OWN contract mid-run,
      // including the acceptance criteria it will be verified against.
      // Resolved server-side from PC_AGENT_RUN_ID; no arguments.
      if (!ctx.agentRunId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_get_contract: PC_AGENT_RUN_ID not set — only dispatched agents have a contract to read',
            },
          ],
          isError: true,
        };
      }
      if (!ctx.projectId) {
        return {
          content: [{ type: 'text', text: 'pc_get_contract: PC_PROJECT_ID not set' }],
          isError: true,
        };
      }
      try {
        const res = await ctx.getServer(
          ctx.projectPath(`agent-runs/${encodeURIComponent(ctx.agentRunId)}/contract`),
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [{ type: 'text', text: `pc_get_contract failed (${res.status}): ${res.body}` }],
          isError: true,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `pc_get_contract failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }

    case 'pc_submit_deliverable': {
      // Slice 014b — the agent submits its typed deliverable against its
      // contract. This BECOMES the verified output source (replacing the
      // end_turn-then-scrape model). The contract is resolved server-side from
      // PC_AGENT_RUN_ID; the agent never needs to know its contract id.
      const kind = typeof args.kind === 'string' ? args.kind.trim() : '';
      if (!kind) {
        return {
          content: [{ type: 'text', text: 'pc_submit_deliverable: kind required' }],
          isError: true,
        };
      }
      if (!ctx.agentRunId) {
        return {
          content: [
            {
              type: 'text',
              text: 'pc_submit_deliverable: PC_AGENT_RUN_ID not set — only dispatched agents have a contract to submit against',
            },
          ],
          isError: true,
        };
      }
      if (!ctx.projectId) {
        return {
          content: [{ type: 'text', text: 'pc_submit_deliverable: PC_PROJECT_ID not set' }],
          isError: true,
        };
      }
      const deliverable =
        args.deliverable && typeof args.deliverable === 'object' && !Array.isArray(args.deliverable)
          ? (args.deliverable as Record<string, unknown>)
          : {};
      const payload: Record<string, unknown> = {
        agentRunId: ctx.agentRunId,
        // Merge `kind` into the deliverable so the agent may pass it at either
        // level; the explicit top-level `kind` wins.
        deliverable: { ...deliverable, kind },
      };
      if (typeof args.report === 'string') payload.report = args.report;
      try {
        const res = await ctx.postServer(
          ctx.projectPath(`agent-runs/${encodeURIComponent(ctx.agentRunId)}/deliverable`),
          payload,
        );
        if (res.status >= 200 && res.status < 300) {
          return { content: [{ type: 'text', text: res.body }] };
        }
        return {
          content: [
            { type: 'text', text: `pc_submit_deliverable failed (${res.status}): ${res.body}` },
          ],
          isError: true,
        };
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `pc_submit_deliverable failed: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }
    }

    default:
      return null;
  }
}
