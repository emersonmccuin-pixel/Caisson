// Slice 016 — the pc-rig HANDLER MAP. The ONLY tool data left in @pc/mcp:
// name → executable handler. Metadata (name/inputSchema/label/descriptions/
// family) lives in @pc/domain's PC_RIG_TOOL_REGISTRY; `server.ts` zips the two
// into `TOOLS` in registry order.
//
// Dispatch is WRAPPED, not collapsed (slice-016 decision): each map entry runs
// the existing ordered `handleXTool(name, args, ctx)` switch chain, so dispatch
// behavior is byte-identical to before. Collapsing the chain into a pure
// per-name primitive is a deferred, separable cleanup.

// Barrel-free subpath import — keeps @pc/domain's `yaml` dep out of the esbuild
// bundle (see server.ts for the dynamic-require boot-break rationale).
import { PC_RIG_TOOL_REGISTRY } from '@pc/domain/tool-registry';

import type { ToolContext, ToolResult } from './context.ts';
import { handleAgentRunTool } from './agent-runs.ts';
import { handleAgentTool } from './agents.ts';
import { handleBoardHealthTool } from './board-health.ts';
import { handleContextDocTool } from './context-docs.ts';
import { handleMetaTool } from './meta.ts';
import { handleNextActionTool } from './next-action.ts';
import { handleProjectConfigTool } from './project-config.ts';
import { handleWorkItemTool } from './work-items.ts';
import { handleWorkItemDossierTool } from './work-item-dossiers.ts';
import { handleWorkflowTool } from './workflows.ts';

export type PcRigHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<ToolResult>;

/** Run the ordered handler chain for one tool name. Byte-identical to the
 *  pre-slice `CallTool` dispatch in `server.ts`: first non-null result wins;
 *  an unknown name throws the same error. */
export async function dispatchPcRigTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const workItemResult = await handleWorkItemTool(name, args, ctx);
  if (workItemResult) return workItemResult;
  const dossierResult = await handleWorkItemDossierTool(name, args, ctx);
  if (dossierResult) return dossierResult;
  const nextActionResult = await handleNextActionTool(name, args, ctx);
  if (nextActionResult) return nextActionResult;
  const boardHealthResult = await handleBoardHealthTool(name, args, ctx);
  if (boardHealthResult) return boardHealthResult;
  const agentResult = await handleAgentTool(name, args, ctx);
  if (agentResult) return agentResult;
  const contextDocResult = await handleContextDocTool(name, args, ctx);
  if (contextDocResult) return contextDocResult;
  const workflowResult = await handleWorkflowTool(name, args, ctx);
  if (workflowResult) return workflowResult;
  const projectConfigResult = await handleProjectConfigTool(name, args, ctx);
  if (projectConfigResult) return projectConfigResult;
  const agentRunResult = await handleAgentRunTool(name, args, ctx);
  if (agentRunResult) return agentRunResult;
  // FD-16 — the find/call door. Last in the chain; receives the chain itself
  // so pc_call_tool re-enters dispatch for its on-demand target.
  const metaResult = await handleMetaTool(name, args, ctx, dispatchPcRigTool);
  if (metaResult) return metaResult;
  throw new Error(`unknown tool: ${name}`);
}

/** name → handler, keyed by EVERY registry tool name. Each handler wraps the
 *  existing chain for its name, so the parity test's
 *  `handlers keys === registry names` holds and dispatch stays byte-identical. */
export const PC_RIG_HANDLERS: Record<string, PcRigHandler> = Object.fromEntries(
  PC_RIG_TOOL_REGISTRY.map((d) => [
    d.name,
    (args: Record<string, unknown>, ctx: ToolContext) =>
      dispatchPcRigTool(d.name, args, ctx),
  ]),
);
