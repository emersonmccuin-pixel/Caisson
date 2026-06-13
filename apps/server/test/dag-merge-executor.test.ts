// pc-pty-chat-270 Chunk B -- DagExecutor merge node (steps 4, 5, 8).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ULID, WorkflowV2 } from "@pc/domain";
import { DagExecutor, type DagExecutorDeps, type NodeOutcome } from "../src/services/dag-executor.ts";

type MergeOutcome = { outcome: "merged" | "conflict" | "failed"; error?: string };

function baseDeps(over: Partial<DagExecutorDeps> = {}): DagExecutorDeps {
  return {
    resolveRef: () => () => "",
    dispatchAgent: async (): Promise<NodeOutcome> => ({ state: "completed" }),
    callTool: async (): Promise<NodeOutcome> => ({ state: "completed", output: "" }),
    moveCard: async () => ({ ok: true }),
    mergeToIntegration: async (): Promise<MergeOutcome> => ({ outcome: "merged" }),
    requestReview: async () => {},
    persist: () => {},
    event: () => {},
    isCancelled: () => false,
    ...over,
  };
}

const ctxBase = { runId: "run-m" as ULID, rootWorkItemId: "wi-m" as ULID, worktreePath: "/wt/wf-AAAA1234" };

function mergeWorkflow(reviewer: "orchestrator" | "human" = "orchestrator"): WorkflowV2.Workflow {
  return {
    id: "wf-merge", name: "Merge Test",
    nodes: [{ id: "merge", kind: "merge", target: "dev", conflict_reviewer: reviewer }],
  };
}

function agentThenMergeWorkflow(): WorkflowV2.Workflow {
  return {
    id: "wf-atm", name: "Agent then Merge",
    nodes: [
      { id: "build", kind: "agent", agent: "coder", task: "go", next: ["merge"] },
      { id: "merge", kind: "merge", target: "dev", conflict_reviewer: "orchestrator" },
    ],
  };
}

test("clean merge: node settles completed, run advances to completed", async () => {
  const mergeCalls: WorkflowV2.MergeNode[] = [];
  const events: string[] = [];
  const persisted: string[] = [];
  const deps = baseDeps({
    mergeToIntegration: async (node): Promise<MergeOutcome> => { mergeCalls.push(node); return { outcome: "merged" }; },
    event: (ev) => events.push(ev.type),
    persist: (_s, status) => persisted.push(status),
  });
  const exec = DagExecutor.start(mergeWorkflow(), deps, ctxBase);
  const status = await exec.advance();
  assert.equal(status, "completed", "run completes after a clean merge");
  assert.equal(mergeCalls.length, 1, "mergeToIntegration called exactly once");
  assert.equal(mergeCalls[0]!.kind, "merge");
  assert.ok(events.includes("node_completed"), "node_completed event emitted");
  assert.ok(events.includes("workflow_completed"), "workflow_completed event emitted");
  assert.equal(persisted[persisted.length - 1], "completed");
});

test("agent-then-merge: both nodes complete, run completes", async () => {
  let mergeCount = 0;
  const deps = baseDeps({ mergeToIntegration: async (): Promise<MergeOutcome> => { mergeCount += 1; return { outcome: "merged" }; } });
  const exec = DagExecutor.start(agentThenMergeWorkflow(), deps, ctxBase);
  const status = await exec.advance();
  assert.equal(status, "completed");
  assert.equal(mergeCount, 1, "merge ran exactly once after the agent completed");
});

test("conflict: run pauses awaiting-review, requestReview called once", async () => {
  const reviews: WorkflowV2.ReviewNode[] = [];
  const events: string[] = [];
  const persisted: string[] = [];
  const deps = baseDeps({
    mergeToIntegration: async (): Promise<MergeOutcome> => ({ outcome: "conflict" }),
    requestReview: async (node) => { reviews.push(node); },
    event: (ev) => events.push(ev.type),
    persist: (_s, status) => persisted.push(status),
  });
  const exec = DagExecutor.start(mergeWorkflow(), deps, ctxBase);
  const status = await exec.advance();
  assert.equal(status, "awaiting-review", "run pauses at the conflict gate");
  assert.equal(reviews.length, 1, "requestReview called exactly once");
  assert.equal(reviews[0]!.reviewer, "orchestrator", "default reviewer is orchestrator");
  assert.ok(events.includes("review_requested"), "review_requested event emitted");
  assert.equal(persisted[persisted.length - 1], "awaiting-review");
  assert.equal(exec.getState().nodes["merge"]?.state, "awaiting-review");
});

test("conflict with human reviewer: gate uses human reviewer", async () => {
  const reviews: WorkflowV2.ReviewNode[] = [];
  const deps = baseDeps({
    mergeToIntegration: async (): Promise<MergeOutcome> => ({ outcome: "conflict" }),
    requestReview: async (node) => { reviews.push(node); },
  });
  const exec = DagExecutor.start(mergeWorkflow("human"), deps, ctxBase);
  await exec.advance();
  assert.equal(reviews[0]!.reviewer, "human", "human reviewer respected");
});

test("hard error: run fails with the returned error message", async () => {
  const events: string[] = [];
  const persisted: string[] = [];
  const deps = baseDeps({
    mergeToIntegration: async (): Promise<MergeOutcome> => ({ outcome: "failed", error: "git push: permission denied" }),
    event: (ev) => events.push(ev.type),
    persist: (_s, status) => persisted.push(status),
  });
  const exec = DagExecutor.start(mergeWorkflow(), deps, ctxBase);
  const status = await exec.advance();
  assert.equal(status, "failed", "run fails on a hard merge error");
  assert.ok(events.includes("node_failed"), "node_failed event emitted");
  assert.ok(events.includes("workflow_failed"), "workflow_failed event emitted");
  const mergeRec = exec.getState().nodes["merge"];
  assert.equal(mergeRec?.state, "failed");
  assert.match(mergeRec?.error ?? "", /permission denied/);
  assert.equal(persisted[persisted.length - 1], "failed");
});

test("conflict gate: approve without resolving re-arms gate (no false advance)", async () => {
  let mergeCallCount = 0;
  let reviewCallCount = 0;
  const deps = baseDeps({
    mergeToIntegration: async (): Promise<MergeOutcome> => { mergeCallCount += 1; return { outcome: "conflict" }; },
    requestReview: async () => { reviewCallCount += 1; },
  });
  const exec = DagExecutor.start(mergeWorkflow(), deps, ctxBase);
  const s1 = await exec.advance();
  assert.equal(s1, "awaiting-review", "first advance pauses at gate");
  assert.equal(mergeCallCount, 1);
  assert.equal(reviewCallCount, 1);
  const s2 = await exec.onReviewDecision("merge", { kind: "approve" });
  assert.equal(s2, "awaiting-review", "approve without resolving re-arms the gate");
  assert.equal(mergeCallCount, 2, "merge re-attempted after approve");
  assert.equal(reviewCallCount, 2, "review gate re-posted");
  assert.equal(exec.getState().nodes["merge"]?.state, "awaiting-review", "no false advance");
});

test("conflict gate: approve after resolution -> run advances and completes", async () => {
  let mergeCallCount = 0;
  const deps = baseDeps({
    mergeToIntegration: async (): Promise<MergeOutcome> => {
      mergeCallCount += 1;
      return mergeCallCount === 1 ? { outcome: "conflict" } : { outcome: "merged" };
    },
  });
  const exec = DagExecutor.start(mergeWorkflow(), deps, ctxBase);
  const s1 = await exec.advance();
  assert.equal(s1, "awaiting-review", "conflict gate armed");
  const s2 = await exec.onReviewDecision("merge", { kind: "approve" });
  assert.equal(s2, "completed", "run completes after conflict is resolved and approved");
  assert.equal(mergeCallCount, 2, "merge re-run exactly once after approve");
  assert.equal(exec.getState().nodes["merge"]?.state, "completed");
});
