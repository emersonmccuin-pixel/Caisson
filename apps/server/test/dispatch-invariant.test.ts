// Dispatch invariant guard tests (pc-pty-chat-273).
//
// (A) A dispatch that cannot create a contract REFUSES (cause: contract-required)
//     rather than spawning contract-less. The route must return 422, not 200.
//
// (B) When isolation: worktree is declared, the spawn worktreeDir must be a
//     provisioned worktree path, NOT project.folderPath. An agent can never
//     commit to the main repo from a worktree-isolation dispatch.
//
// (D) A contract-required rejection (pc-pty-chat-366) creates NO AgentRun row
//     and emits NO terminal event — the 422 is the only signal.
//
// (E) pc-pty-chat-415 (R3): isolation is derived from the output KIND.
//     `kind: "repo"` (code work) ALWAYS provisions a worktree — there is no
//     in_place option — and the factory refuses a repo dispatch whose cwd is
//     the live project folder (the structural backstop).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";

const tmpDir = mkdtempSync(join(tmpdir(), "pc-dispatch-invariant-"));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, createAgent, createProject, createWorkItem, listAgentRunsForSession, runMigrations, newId } = await import("@pc/db");
const { dispatchFreshAgent } = await import("../src/services/agent-run-factory.ts");
const { registerAgentRunRoutes } = await import("../src/features/agent-runs/routes.ts");
import type { AgentRunRouteDeps } from "../src/features/agent-runs/routes.ts";
import type { DispatchAgentFailure, DispatchAgentResult } from "../src/services/agent-run-factory.ts";
import type { ULID } from "@pc/domain";

const stages = [{ id: "todo", name: "Todo", order: 0 }];

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function mkApp(opts: {
  dispatchResult: DispatchAgentResult;
  capturedWorktreeDir?: { value: string };
  worktreeServiceFor?: AgentRunRouteDeps["worktreeServiceFor"];
  resolveAgentForDispatch?: AgentRunRouteDeps["resolveAgentForDispatch"];
}): Hono {
  const app = new Hono();
  registerAgentRunRoutes(app, {
    broadcastTo: () => {},
    getHostConnection: () => null,
    dispatchFreshAgent: async (input) => {
      if (opts.capturedWorktreeDir) opts.capturedWorktreeDir.value = input.worktreeDir;
      return opts.dispatchResult;
    },
    recordAgentInvoke: () => {},
    checkInvokeDepth: () => ({ ok: true, childDepth: 1 }),
    worktreeServiceFor: opts.worktreeServiceFor,
    resolveAgentForDispatch: opts.resolveAgentForDispatch,
  });
  return app;
}

test("dispatch-invariant (A): contract-required refusal returns 422 not 200", async () => {
  const project = createProject({
    slug: "inv-a-" + Date.now(),
    name: "Invariant A",
    stages,
    folderPath: join(tmpDir, "inv-a"),
  });

  const app = mkApp({
    dispatchResult: {
      ok: false,
      cause: "contract-required",
      error: "contract resolution failed",
    },
  });

  const res = await app.request(
    "/api/projects/" + project.id + "/agents/code-writer/invoke",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "fix the bug",
        dispatcherSessionId: "orch-session-1",
        // Non-repo kind: repo would route into worktree provisioning (R3)
        // before the dispatch mock — this test exercises the 422 mapping.
        expectedOutput: { kind: "answer" },
      }),
    },
  );

  assert.equal(res.status, 422, "contract-required must be 422");
  const body = await json<{ ok: boolean; cause: string }>(res);
  assert.equal(body.ok, false);
  assert.equal(body.cause, "contract-required");
});

test("dispatch-invariant (B): isolation:worktree passes provisioned path not project.folderPath", async () => {
  const projectFolderPath = join(tmpDir, "inv-b-main-repo");
  const project = createProject({
    slug: "inv-b-" + Date.now(),
    name: "Invariant B",
    stages,
    folderPath: projectFolderPath,
  });

  const WORKTREE_PATH = join(tmpDir, "worktrees", "inv-b", "agent-test");
  const capturedWorktreeDir = { value: "" };

  const app = mkApp({
    dispatchResult: {
      ok: true,
      agentRunId: newId() as ULID,
      ccSessionId: "cc-inv-b",
      podName: "code-writer",
      initialState: "queued",
      startedAt: Date.now(),
      done: new Promise<never>(() => {}),
    },
    capturedWorktreeDir,
    worktreeServiceFor: (_projectId) => ({
      ensureWorktree: async (_name: string) => ({ path: WORKTREE_PATH }),
    }),
  });

  const res = await app.request(
    "/api/projects/" + project.id + "/agents/code-writer/invoke",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "fix the bug",
        dispatcherSessionId: "orch-session-2",
        expectedOutput: { kind: "repo", isolation: "worktree" },
      }),
    },
  );

  assert.equal(res.status, 200, "dispatch should succeed");
  const body = await json<{ ok: boolean }>(res);
  assert.equal(body.ok, true);
  assert.notEqual(
    capturedWorktreeDir.value,
    projectFolderPath,
    "worktreeDir must not be the main project folder for isolation:worktree",
  );
  assert.equal(
    capturedWorktreeDir.value,
    WORKTREE_PATH,
    "worktreeDir must be the provisioned worktree path",
  );
});

test("dispatch-invariant (B2): same work item gets a fresh temp worktree branch each dispatch", async () => {
  const project = createProject({
    slug: "inv-b2-unique-" + Date.now(),
    name: "Invariant B2 Unique",
    stages,
    folderPath: join(tmpDir, "inv-b2-unique"),
  });
  const wi = createWorkItem({
    projectId: project.id as ULID,
    stageId: "todo",
    title: "Build this",
  });
  const names: string[] = [];

  const app = mkApp({
    dispatchResult: {
      ok: true,
      agentRunId: newId() as ULID,
      ccSessionId: "cc-inv-b2",
      podName: "code-writer",
      initialState: "queued",
      startedAt: Date.now(),
      done: new Promise<never>(() => {}),
    },
    worktreeServiceFor: () => ({
      ensureWorktree: async (name: string) => {
        names.push(name);
        return { path: join(tmpDir, "worktrees", name), baseBranch: "main", baseSha: "base" };
      },
    }),
  });

  for (let i = 0; i < 2; i += 1) {
    const res = await app.request(
      "/api/projects/" + project.id + "/agents/code-writer/invoke",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: "fix the bug",
          dispatcherSessionId: "orch-session-b2",
          workItemId: wi.id,
          expectedOutput: { kind: "repo" },
        }),
      },
    );
    assert.equal(res.status, 200);
  }

  assert.equal(names.length, 2);
  assert.match(names[0]!, /^agent-/);
  assert.match(names[1]!, /^agent-/);
  assert.notEqual(names[0], names[1], "separate dispatches must not reuse a work-item-keyed branch");
});

test("dispatch-invariant (B): isolation:worktree without worktreeService returns 503", async () => {
  const project = createProject({
    slug: "inv-b2-" + Date.now(),
    name: "Invariant B2",
    stages,
    folderPath: join(tmpDir, "inv-b2"),
  });

  const app = mkApp({
    dispatchResult: {
      ok: true,
      agentRunId: newId() as ULID,
      ccSessionId: "cc-never",
      podName: "code-writer",
      initialState: "queued",
      startedAt: Date.now(),
      done: new Promise<never>(() => {}),
    },
    worktreeServiceFor: undefined,
  });

  const res = await app.request(
    "/api/projects/" + project.id + "/agents/code-writer/invoke",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "fix the bug",
        dispatcherSessionId: "orch-session-3",
        expectedOutput: { kind: "repo", isolation: "worktree" },
      }),
    },
  );

  assert.equal(res.status, 503, "missing worktreeService must return 503");
  const body = await json<{ ok: boolean; cause: string }>(res);
  assert.equal(body.ok, false);
  assert.equal(body.cause, "worktree-provision-failed");
});

test("dispatch-invariant (C): isolation:worktree from pod DEFAULT (no inline spec) provisions worktree", async () => {
  // This is the hole pc-pty-chat-353 closes: when the CALLER omits
  // `expectedOutput` entirely but the pod's default declares
  // `isolation: "worktree"`, the route must still provision a worktree.
  const projectFolderPath = join(tmpDir, "inv-c2-main-repo");
  const project = createProject({
    slug: "inv-c2-" + Date.now(),
    name: "Invariant C2",
    stages,
    folderPath: projectFolderPath,
  });

  const WORKTREE_PATH = join(tmpDir, "worktrees", "inv-c2", "agent-test");
  const capturedWorktreeDir = { value: "" };

  // Simulate a pod whose stored default is isolation:worktree.
  const podWithWorktreeDefault: AgentRunRouteDeps["resolveAgentForDispatch"] =
    (_name, _projectId) => ({ expectedOutput: { kind: "repo", isolation: "worktree" } });

  const app = mkApp({
    dispatchResult: {
      ok: true,
      agentRunId: newId() as ULID,
      ccSessionId: "cc-inv-c2",
      podName: "code-writer",
      initialState: "queued",
      startedAt: Date.now(),
      done: new Promise<never>(() => {}),
    },
    capturedWorktreeDir,
    resolveAgentForDispatch: podWithWorktreeDefault,
    worktreeServiceFor: (_projectId) => ({
      ensureWorktree: async (_name: string) => ({ path: WORKTREE_PATH }),
    }),
  });

  const res = await app.request(
    "/api/projects/" + project.id + "/agents/code-writer/invoke",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "fix the bug",
        dispatcherSessionId: "orch-session-c2",
        // NO inline expectedOutput — isolation must come from the pod default.
      }),
    },
  );

  assert.equal(res.status, 200, "dispatch should succeed");
  const body = await json<{ ok: boolean }>(res);
  assert.equal(body.ok, true);
  assert.notEqual(
    capturedWorktreeDir.value,
    projectFolderPath,
    "worktreeDir must not be the main project folder when pod default is isolation:worktree",
  );
  assert.equal(
    capturedWorktreeDir.value,
    WORKTREE_PATH,
    "worktreeDir must be the provisioned worktree path",
  );
});

// ── (D) pc-pty-chat-366: contract-required must create zero rows + zero events ──

test("dispatch-invariant (D): contract-required creates NO AgentRun row and NO terminal event", async () => {
  // Create a project + a project-scoped pod with NO expectedOutput.
  // A project-scoped pod is dispatchable (resolveAgentForDispatch finds it).
  const project = createProject({
    slug: "inv-d-" + Date.now(),
    name: "Invariant D",
    stages,
    folderPath: join(tmpDir, "inv-d"),
  });
  createAgent(
    { name: "no-spec-pod-d", scope: "project", projectId: project.id as ULID },
    { actor: "user" },
  );

  const sessionId = "sess-inv-d-" + Date.now();
  const result = await dispatchFreshAgent(
    {
      projectId: project.id as ULID,
      worktreeDir: join(tmpDir, "inv-d"),
      agentName: "no-spec-pod-d",
      input: "do something",
      dispatcherSessionId: sessionId,
      invokeDepth: 1,
      slug: "inv-d",
      // No expectedOutput — the pod has no stored default and is not in the
      // stock default table, so the resolution chain returns null.
    },
    {
      // No deps needed — the pre-check fires before any dep is consulted.
    },
  );

  // (a) synchronous 422 cause
  assert.equal(result.ok, false);
  assert.equal((result as DispatchAgentFailure).cause, "contract-required");

  // (b) zero agent_runs rows — the row must NOT have been inserted
  const runs = listAgentRunsForSession(project.id as ULID, sessionId, { limit: 10 });
  assert.equal(
    runs.length,
    0,
    "contract-required rejection must not insert an agent_runs row",
  );

  // (c) zero terminal events: no row means no queued or failed announce was
  // possible (announceAgentRunChange re-reads the row; without a row there is
  // nothing to announce).
});

test("dispatch-invariant (E1, pc-pty-chat-415 R3): repo kind with NO isolation field still provisions a worktree", async () => {
  // in_place is deleted — isolation derives from the KIND. A bare
  // `{ kind: "repo" }` spec must route through worktree provisioning.
  const projectFolderPath = join(tmpDir, "inv-e1-main-repo");
  const project = createProject({
    slug: "inv-e1-" + Date.now(),
    name: "Invariant E1",
    stages,
    folderPath: projectFolderPath,
  });

  const WORKTREE_PATH = join(tmpDir, "worktrees", "inv-e1", "agent-test");
  const capturedWorktreeDir = { value: "" };
  const app = mkApp({
    dispatchResult: {
      ok: true,
      agentRunId: newId() as ULID,
      ccSessionId: "cc-inv-e1",
      podName: "code-writer",
      initialState: "queued",
      startedAt: Date.now(),
      done: new Promise<never>(() => {}),
    },
    capturedWorktreeDir,
    worktreeServiceFor: (_id) => ({
      ensureWorktree: async () => ({ path: WORKTREE_PATH }),
    }),
  });

  const res = await app.request(
    "/api/projects/" + project.id + "/agents/code-writer/invoke",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "fix the bug",
        dispatcherSessionId: "orch-session-4",
        expectedOutput: { kind: "repo" },
      }),
    },
  );

  assert.equal(res.status, 200);
  assert.notEqual(
    capturedWorktreeDir.value,
    projectFolderPath,
    "repo kind must never run in the live project folder",
  );
  assert.equal(
    capturedWorktreeDir.value,
    WORKTREE_PATH,
    "repo kind must use the provisioned worktree path",
  );
});

test("dispatch-invariant (E2, pc-pty-chat-415 R3): factory refuses a repo-kind dispatch aimed at the live project folder", async () => {
  // The structural backstop BELOW the route layer: even a caller that skips
  // the HTTP route (e.g. a future internal caller) cannot run code work in
  // the live working copy. code-writer's stock default is repo-kind.
  const projectFolderPath = join(tmpDir, "inv-e2-main-repo");
  const project = createProject({
    slug: "inv-e2-" + Date.now(),
    name: "Invariant E2",
    stages,
    folderPath: projectFolderPath,
  });
  createAgent(
    { name: "repo-pod-e2", scope: "project", projectId: project.id as ULID },
    { actor: "user" },
  );

  const sessionId = "sess-inv-e2-" + Date.now();
  const result = await dispatchFreshAgent(
    {
      projectId: project.id as ULID,
      worktreeDir: projectFolderPath, // the live copy — must be refused
      agentName: "repo-pod-e2",
      input: "fix the bug",
      dispatcherSessionId: sessionId,
      invokeDepth: 1,
      slug: "inv-e2",
      expectedOutput: { kind: "repo" },
    },
    {},
  );

  assert.equal(result.ok, false);
  assert.equal(
    (result as DispatchAgentFailure).cause,
    "worktree-provision-failed",
    "repo dispatch in the live copy must refuse with worktree-provision-failed",
  );
  const runs = listAgentRunsForSession(project.id as ULID, sessionId, { limit: 10 });
  assert.equal(runs.length, 0, "isolation refusal must not insert an agent_runs row");
});

// ── (F) pc-pty-chat-439: non-repo dispatch uses scratch dir, not project root ──

test("dispatch-invariant (F, pc-pty-chat-439): non-repo dispatch cwd is scratch dir, not project.folderPath", async () => {
  const projectFolderPath = join(tmpDir, "inv-f-main-repo");
  const project = createProject({
    slug: "inv-f-" + Date.now(),
    name: "Invariant F",
    stages,
    folderPath: projectFolderPath,
  });

  const capturedWorktreeDir = { value: "" };

  const app = mkApp({
    dispatchResult: {
      ok: true,
      agentRunId: newId() as ULID,
      ccSessionId: "cc-inv-f",
      podName: "researcher",
      initialState: "queued",
      startedAt: Date.now(),
      done: new Promise<never>(() => {}),
    },
    capturedWorktreeDir,
  });

  const res = await app.request(
    "/api/projects/" + project.id + "/agents/researcher/invoke",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "investigate something",
        dispatcherSessionId: "orch-session-f",
        expectedOutput: { kind: "answer" }, // non-repo: must get scratch dir
      }),
    },
  );

  assert.equal(res.status, 200, "non-repo dispatch should succeed");
  const body = await json<{ ok: boolean }>(res);
  assert.equal(body.ok, true);
  assert.notEqual(
    capturedWorktreeDir.value,
    projectFolderPath,
    "non-repo dispatch must not run in the live project folder",
  );
  assert.ok(
    capturedWorktreeDir.value.startsWith(join(tmpDir, "scratch")),
    `worktreeDir (${capturedWorktreeDir.value}) must be under PC_DATA_DIR/scratch`,
  );
});
