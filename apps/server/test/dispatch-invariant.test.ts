// Dispatch invariant guard tests (pc-pty-chat-273).
//
// (A) A dispatch that cannot create a contract REFUSES (cause: contract-required)
//     rather than spawning contract-less. The route must return 422, not 200.
//
// (B) When isolation: worktree is declared, the spawn worktreeDir must be a
//     provisioned worktree path, NOT project.folderPath. An agent can never
//     commit to the main repo from a worktree-isolation dispatch.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";

const tmpDir = mkdtempSync(join(tmpdir(), "pc-dispatch-invariant-"));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, createProject, runMigrations, newId } = await import("@pc/db");
const { registerAgentRunRoutes } = await import("../src/features/agent-runs/routes.ts");
import type { AgentRunRouteDeps } from "../src/features/agent-runs/routes.ts";
import type { DispatchAgentResult } from "../src/services/agent-run-factory.ts";
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
        expectedOutput: { kind: "repo", isolation: "in_place" },
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

test("dispatch-invariant (B): isolation:in_place keeps project.folderPath", async () => {
  const projectFolderPath = join(tmpDir, "inv-c");
  const project = createProject({
    slug: "inv-c-" + Date.now(),
    name: "Invariant C",
    stages,
    folderPath: projectFolderPath,
  });

  const capturedWorktreeDir = { value: "" };
  const app = mkApp({
    dispatchResult: {
      ok: true,
      agentRunId: newId() as ULID,
      ccSessionId: "cc-inv-c",
      podName: "code-writer",
      initialState: "queued",
      startedAt: Date.now(),
      done: new Promise<never>(() => {}),
    },
    capturedWorktreeDir,
    worktreeServiceFor: (_id) => ({
      ensureWorktree: async () => ({ path: "/should-not-be-used" }),
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
        expectedOutput: { kind: "repo", isolation: "in_place" },
      }),
    },
  );

  assert.equal(res.status, 200);
  assert.equal(
    capturedWorktreeDir.value,
    projectFolderPath,
    "in_place isolation must use project.folderPath",
  );
});
