// pc-pty-chat-411 -- Phase 3 server-routes: membership model tests.
//
// Tests: add-to-project (happy path, 400, 409, idempotent), remove-from-project,
// clone-to-project removed (404), promote-to-global -> shareable, GET pod includes memberProjectIds.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";
import type { ULID } from "@pc/domain";

const tmpDir = mkdtempSync(join(tmpdir(), "pc-pod-routes-"));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, createAgent, createProject, getAgentById, runMigrations } =
  await import("@pc/db");
const { registerPodRoutes } = await import("../src/routes/pod-routes.ts");

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeApp() {
  const app = new Hono();
  registerPodRoutes(app, {});
  return app;
}

let seq = 0;
function uniq(prefix = "agent") {
  return prefix + "-" + (++seq) + "-" + Date.now();
}

function makeProject() {
  const slug = uniq("proj");
  return createProject({
    slug,
    name: slug,
    stages: [{ id: "todo", name: "Todo", order: 0 }],
    folderPath: join(tmpDir, slug),
  });
}

// -- add-to-project -----------------------------------------------------------

test("add-to-project: shareable agent appears in GET /pods?projectId with memberProjectIds", async () => {
  const app = makeApp();
  const homeProject = makeProject();
  const otherProject = makeProject();

  const agent = createAgent(
    { name: uniq(), scope: "project", projectId: homeProject.id, shareable: true, prompt: "" },
    { actor: "user", reason: "test" },
  );

  const addRes = await app.request("/api/agents/pods/" + agent.id + "/add-to-project", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: otherProject.id }),
  });
  assert.equal(addRes.status, 200);
  assert.equal(((await addRes.json()) as { ok: boolean }).ok, true);

  const listRes = await app.request("/api/agents/pods?projectId=" + otherProject.id);
  assert.equal(listRes.status, 200);
  const listJson = (await listRes.json()) as {
    pods: Array<{ id: string; memberProjectIds: string[] }>;
  };
  const found = listJson.pods.find((p) => p.id === agent.id);
  assert.ok(found, "agent must appear in target project list after add");
  assert.ok(
    found.memberProjectIds.includes(homeProject.id as string),
    "memberProjectIds includes home project",
  );
  assert.ok(
    found.memberProjectIds.includes(otherProject.id as string),
    "memberProjectIds includes target project",
  );
});

test("add-to-project: non-shareable non-stock agent -> 400", async () => {
  const app = makeApp();
  const homeProject = makeProject();
  const otherProject = makeProject();

  const agent = createAgent(
    { name: uniq(), scope: "project", projectId: homeProject.id, shareable: false, prompt: "" },
    { actor: "user", reason: "test" },
  );

  const res = await app.request("/api/agents/pods/" + agent.id + "/add-to-project", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: otherProject.id }),
  });
  assert.equal(res.status, 400);
  const json = (await res.json()) as { ok: boolean; error: string };
  assert.equal(json.ok, false);
  assert.ok(json.error.length > 0);
});

test("add-to-project: name-collision -> 409", async () => {
  const app = makeApp();
  const homeProject = makeProject();
  const otherProject = makeProject();
  const sharedName = uniq("col");

  const shareableAgent = createAgent(
    { name: sharedName, scope: "project", projectId: homeProject.id, shareable: true, prompt: "" },
    { actor: "user", reason: "test" },
  );
  createAgent(
    { name: sharedName, scope: "project", projectId: otherProject.id, shareable: false, prompt: "" },
    { actor: "user", reason: "test" },
  );

  const res = await app.request("/api/agents/pods/" + shareableAgent.id + "/add-to-project", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: otherProject.id }),
  });
  assert.equal(res.status, 409);
  const json = (await res.json()) as { ok: boolean; kind: string };
  assert.equal(json.ok, false);
  assert.equal(json.kind, "name-collision");
});

test("add-to-project: idempotent re-add does not 409", async () => {
  const app = makeApp();
  const homeProject = makeProject();
  const otherProject = makeProject();

  const agent = createAgent(
    { name: uniq(), scope: "project", projectId: homeProject.id, shareable: true, prompt: "" },
    { actor: "user", reason: "test" },
  );

  const first = await app.request("/api/agents/pods/" + agent.id + "/add-to-project", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: otherProject.id }),
  });
  assert.equal(first.status, 200);

  const second = await app.request("/api/agents/pods/" + agent.id + "/add-to-project", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: otherProject.id }),
  });
  assert.equal(second.status, 200);
});

test("add-to-project: missing projectId -> 400", async () => {
  const app = makeApp();
  const agent = createAgent(
    { name: uniq(), scope: "global", shareable: true, prompt: "" },
    { actor: "user", reason: "test" },
  );
  const res = await app.request("/api/agents/pods/" + agent.id + "/add-to-project", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

// -- remove-from-project ------------------------------------------------------

test("remove-from-project: agent no longer appears in project list", async () => {
  const app = makeApp();
  const homeProject = makeProject();
  const otherProject = makeProject();

  const agent = createAgent(
    { name: uniq(), scope: "project", projectId: homeProject.id, shareable: true, prompt: "" },
    { actor: "user", reason: "test" },
  );

  await app.request("/api/agents/pods/" + agent.id + "/add-to-project", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: otherProject.id }),
  });

  const beforeList = await app.request("/api/agents/pods?projectId=" + otherProject.id);
  const beforeJson = (await beforeList.json()) as { pods: { id: string }[] };
  assert.ok(beforeJson.pods.some((p) => p.id === agent.id), "agent visible before remove");

  const removeRes = await app.request(
    "/api/agents/pods/" + agent.id + "/projects/" + otherProject.id,
    { method: "DELETE" },
  );
  assert.equal(removeRes.status, 200);
  const removeJson = (await removeRes.json()) as { ok: boolean; wasLastProject: boolean };
  assert.equal(removeJson.ok, true);
  assert.equal(removeJson.wasLastProject, false, "still attached to homeProject");

  const afterList = await app.request("/api/agents/pods?projectId=" + otherProject.id);
  const afterJson = (await afterList.json()) as { pods: { id: string }[] };
  assert.ok(!afterJson.pods.some((p) => p.id === agent.id), "agent hidden after remove");
});

test("remove-from-project: wasLastProject=true when no other memberships remain", async () => {
  const app = makeApp();
  const homeProject = makeProject();

  const agent = createAgent(
    { name: uniq(), scope: "project", projectId: homeProject.id, shareable: true, prompt: "" },
    { actor: "user", reason: "test" },
  );

  const res = await app.request(
    "/api/agents/pods/" + agent.id + "/projects/" + homeProject.id,
    { method: "DELETE" },
  );
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ok: boolean; wasLastProject: boolean };
  assert.equal(json.ok, true);
  assert.equal(json.wasLastProject, true);
});

// -- clone-to-project removed -------------------------------------------------

test("clone-to-project route is removed -> 404", async () => {
  const app = makeApp();
  const project = makeProject();
  const agent = createAgent(
    { name: uniq(), scope: "global", prompt: "" },
    { actor: "user", reason: "test" },
  );
  const res = await app.request("/api/agents/pods/" + agent.id + "/clone-to-project", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: project.id }),
  });
  assert.equal(res.status, 404);
});

// -- promote-to-global -> setAgentShareable -----------------------------------

test("promote-to-global: flips shareable flag to true", async () => {
  const app = makeApp();
  const project = makeProject();
  const agent = createAgent(
    { name: uniq(), scope: "project", projectId: project.id, shareable: false, prompt: "" },
    { actor: "user", reason: "test" },
  );
  const liveRow = getAgentById(agent.id as ULID);
  assert.equal(liveRow?.shareable, false, "starts non-shareable");

  const res = await app.request("/api/agents/pods/" + agent.id + "/promote-to-global", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ok: boolean; pod: { shareable: boolean } };
  assert.equal(json.ok, true);
  assert.equal(json.pod.shareable, true);
  assert.equal(getAgentById(agent.id as ULID)?.shareable, true, "DB row updated");
});

test("promote-to-global: idempotent on already-shareable agent", async () => {
  const app = makeApp();
  const project = makeProject();
  const agent = createAgent(
    { name: uniq(), scope: "project", projectId: project.id, shareable: true, prompt: "" },
    { actor: "user", reason: "test" },
  );

  const res = await app.request("/api/agents/pods/" + agent.id + "/promote-to-global", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ok: boolean; pod: { shareable: boolean } };
  assert.equal(json.ok, true);
  assert.equal(json.pod.shareable, true);
});

// -- GET /pods/:id includes memberProjectIds ----------------------------------

test("GET /pods/:id includes memberProjectIds", async () => {
  const app = makeApp();
  const homeProject = makeProject();
  const otherProject = makeProject();

  const agent = createAgent(
    { name: uniq(), scope: "project", projectId: homeProject.id, shareable: true, prompt: "" },
    { actor: "user", reason: "test" },
  );

  await app.request("/api/agents/pods/" + agent.id + "/add-to-project", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: otherProject.id }),
  });

  const res = await app.request("/api/agents/pods/" + agent.id);
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ok: boolean; memberProjectIds: string[] };
  assert.ok(Array.isArray(json.memberProjectIds), "memberProjectIds is an array");
  assert.ok(json.memberProjectIds.includes(homeProject.id as string));
  assert.ok(json.memberProjectIds.includes(otherProject.id as string));
});
