// orchestrator-review step dispatcher (4a.6 / D23). Pauses the run + posts a
// channel event to the orchestrator with the review prompt. Run goes async;
// the orchestrator decides (approve / reject / revise) and calls
// `pc_complete_node({ workflowRunId, nodeId, output: { decision, notes? } })`.
// The runtime's existing `nodeComplete` path resumes the run on receipt.
//
// Pure async function with all dependencies injected so it's unit-testable
// without standing up a real channel server. Matches the 4a.5 pattern.

import type {
  NodeOutput,
  OrchestratorReviewNode,
  Workflow,
  WorkflowRun,
} from '@pc/domain';

import { buildWorkflowEventHeader } from './workflow-event-header.ts';
import type { SubstituteTemplate } from './typed-substitution.ts';

export type PostChannel = (body: string) => Promise<void>;
export type BroadcastFn = (event: unknown) => void;

/** Slice 008 — gated mailbox review delivery for the legacy step dispatcher.
 *  When present and it returns true, the review prompt was enqueued as a
 *  mailbox message and `postChannel` is skipped. Absent ⟹ unchanged Channel. */
export type DeliverReview = (input: {
  runId: string;
  nodeId: string;
  body: string;
}) => boolean;

export interface OrchestratorReviewStepResult {
  kind: 'sync' | 'async';
  output?: NodeOutput;
}

export interface OrchestratorReviewStepDeps {
  workflow: Workflow;
  substituteTemplate: SubstituteTemplate;
  postChannel: PostChannel;
  broadcast: BroadcastFn;
  /** Slice 008 — optional gated mailbox delivery (default: Channel via postChannel). */
  deliverReview?: DeliverReview;
}

export async function runOrchestratorReviewStep(
  node: OrchestratorReviewNode,
  run: WorkflowRun,
  deps: OrchestratorReviewStepDeps,
): Promise<OrchestratorReviewStepResult> {
  const cfg = node['orchestrator-review'];
  const prompt = deps.substituteTemplate(cfg.prompt);
  const artifact = cfg.artifact ? deps.substituteTemplate(cfg.artifact) : null;
  const onRevisePrompt = cfg.on_revise?.prompt ?? null;
  const body = buildOrchestratorReviewChannelBody({
    runId: run.id,
    nodeId: node.id,
    workflowId: deps.workflow.id,
    prompt,
    artifact,
    onRevisePrompt,
  });
  const deliveredViaMailbox =
    deps.deliverReview?.({ runId: run.id, nodeId: node.id, body }) ?? false;
  if (!deliveredViaMailbox) {
    try {
      await deps.postChannel(body);
    } catch (err) {
      return {
        kind: 'sync',
        output: {
          status: 'failed',
          error: `channel POST failed: ${(err as Error).message}`,
          completedAt: new Date().toISOString(),
        },
      };
    }
  }
  deps.broadcast({
    type: 'event',
    event: {
      kind: 'review-pending',
      flavor: 'orchestrator',
      ts: new Date().toISOString(),
      workflowRunId: run.id,
      nodeId: node.id,
      prompt,
      artifact,
      on_revise_prompt: onRevisePrompt,
    },
  });
  return { kind: 'async' };
}

export function buildOrchestratorReviewChannelBody(args: {
  runId: string;
  nodeId: string;
  workflowId: string;
  prompt: string;
  artifact: string | null;
  onRevisePrompt: string | null;
}): string {
  const artifactLine = args.artifact ? `\nArtifact: ${args.artifact}\n` : '';
  const reviseLine = args.onRevisePrompt
    ? `\nIf you want revisions, choose "revise" and use these notes as guidance for the workflow author: ${args.onRevisePrompt}\n`
    : '';
  return [
    buildWorkflowEventHeader('orchestrator-review'),
    `Workflow review request: workflow="${args.workflowId}" node="${args.nodeId}".`,
    ``,
    `${args.prompt}${artifactLine}${reviseLine}`,
    `[workflowRunId: ${args.runId}] [nodeId: ${args.nodeId}]`,
    ``,
    `Decide and close this node by calling pc_complete_node({ workflowRunId, nodeId, output: { decision: "approve" | "reject" | "revise", notes?: string } }). The run is paused until you do.`,
  ].join('\n');
}
