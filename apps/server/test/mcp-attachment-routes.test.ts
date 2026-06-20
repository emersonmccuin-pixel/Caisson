// pc-pty-chat-359 P3 � Smoke tests for the agent MCP attachment routes.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";
import type { ULID } from "@pc/domain";

const tmpDir = mkdtempSync(join(tmpdir(), "pc-mcp-attach-"));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, runMigrations, setMcpServerDiscovery } = await import("@pc/db");
const { createMcpServerRegistry } = await import("@pc/db");
const { createAgent } = await import("@pc/db");
const { registerPodRoutes } = await import("../src/routes/pod-routes.ts");
const { registerMcpServerRoutes } = await import("../src/features/mcp-servers/routes.ts");

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeApp() {
  const app = new Hono();
  registerMcpServerRoutes(app, {});
  registerPodRoutes(app, {});
  return app;
}

function makeAgent() {
  return createAgent(
    { name: "test-agent-" + Date.now() + "-" + Math.random(), scope: "global", prompt: "" },
    { actor: "user", reason: "test" },
  );
}

function makeRegistryServer() {
  return createMcpServerRegistry({
    scope: "global",
    name: "test-reg-" + Date.now() + "-" + Math.random(),
    transport: { command: "node", args: ["server.js"] },
  });
}

test("GET mcp-attachments � empty list on fresh agent", async () => {
  const app = makeApp();
  const agent = makeAgent();
  const res = await app.request("/api/agents/pods/" + agent.id + "/mcp-attachments");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; attachments: unknown[] };
  assert.equal(body.ok, true);
  assert.deepEqual(body.attachments, []);
});

test("PUT mcp-attachments � attaches server with all tools", async () => {
  const app = makeApp();
  const agent = makeAgent();
  const server = makeRegistryServer();
  const res = await app.request(
    "/api/agents/pods/" + agent.id + "/mcp-attachments/" + server.id,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabledTools: "*" }),
    },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    attachment: { agentId: string; mcpServerId: string; enabledTools: unknown };
  };
  assert.equal(body.ok, true);
  assert.equal(body.attachment.agentId, agent.id);
  assert.equal(body.attachment.mcpServerId, server.id);
  assert.equal(body.attachment.enabledTools, "*");
  const listRes = await app.request("/api/agents/pods/" + agent.id + "/mcp-attachments");
  const listBody = (await listRes.json()) as { ok: boolean; attachments: { mcpServerId: string }[] };
  assert.equal(listBody.attachments.length, 1);
  assert.equal(listBody.attachments[0].mcpServerId, server.id);
});

test("PUT mcp-attachments � attaches with specific tool list", async () => {
  const app = makeApp();
  const agent = makeAgent();
  const server = makeRegistryServer();
  const tools = ["mcp__test-reg__tool_a", "mcp__test-reg__tool_b"];
  const res = await app.request(
    "/api/agents/pods/" + agent.id + "/mcp-attachments/" + server.id,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabledTools: tools }),
    },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; attachment: { enabledTools: unknown } };
  assert.equal(body.ok, true);
  assert.deepEqual(body.attachment.enabledTools, tools);
});

test("PUT mcp-attachments � upsert updates tool selection", async () => {
  const app = makeApp();
  const agent = makeAgent();
  const server = makeRegistryServer();
  await app.request(
    "/api/agents/pods/" + agent.id + "/mcp-attachments/" + server.id,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabledTools: "*" }),
    },
  );
  const tools = ["mcp__x__only_this"];
  const res2 = await app.request(
    "/api/agents/pods/" + agent.id + "/mcp-attachments/" + server.id,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabledTools: tools }),
    },
  );
  assert.equal(res2.status, 200);
  const body2 = (await res2.json()) as { ok: boolean; attachment: { enabledTools: unknown } };
  assert.deepEqual(body2.attachment.enabledTools, tools);
  const listRes = await app.request("/api/agents/pods/" + agent.id + "/mcp-attachments");
  const listBody = (await listRes.json()) as { ok: boolean; attachments: unknown[] };
  assert.equal(listBody.attachments.length, 1);
});

test("DELETE mcp-attachments � detaches server", async () => {
  const app = makeApp();
  const agent = makeAgent();
  const server = makeRegistryServer();
  await app.request(
    "/api/agents/pods/" + agent.id + "/mcp-attachments/" + server.id,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabledTools: "*" }),
    },
  );
  const del = await app.request(
    "/api/agents/pods/" + agent.id + "/mcp-attachments/" + server.id,
    { method: "DELETE" },
  );
  assert.equal(del.status, 200);
  assert.equal(((await del.json()) as { ok: boolean }).ok, true);
  const listRes = await app.request("/api/agents/pods/" + agent.id + "/mcp-attachments");
  const listBody = (await listRes.json()) as { ok: boolean; attachments: unknown[] };
  assert.deepEqual(listBody.attachments, []);
});

test("DELETE mcp-attachments � idempotent when nothing attached", async () => {
  const app = makeApp();
  const agent = makeAgent();
  const server = makeRegistryServer();
  const res = await app.request(
    "/api/agents/pods/" + agent.id + "/mcp-attachments/" + server.id,
    { method: "DELETE" },
  );
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { ok: boolean }).ok, true);
});

test("PUT mcp-attachments � 404 for unknown registry server", async () => {
  const app = makeApp();
  const agent = makeAgent();
  const res = await app.request(
    "/api/agents/pods/" + agent.id + "/mcp-attachments/01NOTEXIST0000000000000000",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabledTools: "*" }),
    },
  );
  assert.equal(res.status, 404);
});

test("PUT mcp-attachments � 400 for invalid enabledTools", async () => {
  const app = makeApp();
  const agent = makeAgent();
  const server = makeRegistryServer();
  const res = await app.request(
    "/api/agents/pods/" + agent.id + "/mcp-attachments/" + server.id,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabledTools: 42 }),
    },
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.match(body.error, /enabledTools/);
});

test("GET mcp-attachments � 404 for unknown agent", async () => {
  const app = makeApp();
  const res = await app.request("/api/agents/pods/01NOTEXIST0000000000000000/mcp-attachments");
  assert.equal(res.status, 404);
});

// pc-pty-chat-450: bundle observability — GET /api/agents/pods/:id includes mcpAttachments

test("GET pod bundle — mcpAttachments empty when no servers attached", async () => {
  const app = makeApp();
  const agent = makeAgent();
  const res = await app.request("/api/agents/pods/" + agent.id);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; mcpAttachments: unknown[] };
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.mcpAttachments), "mcpAttachments is an array");
  assert.deepEqual(body.mcpAttachments, []);
});

test("GET pod bundle — mcpAttachments surfaces attachment with server details", async () => {
  const app = makeApp();
  const agent = makeAgent();
  const server = makeRegistryServer();
  const tools = ["mcp__bundle-srv__tool_a", "mcp__bundle-srv__tool_b"];
  setMcpServerDiscovery(server.id, { status: "ok", tools });

  await app.request(
    "/api/agents/pods/" + agent.id + "/mcp-attachments/" + server.id,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabledTools: "*" }),
    },
  );

  const res = await app.request("/api/agents/pods/" + agent.id);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    mcpAttachments: Array<{
      mcpServerId: string;
      name: string;
      scope: string;
      projectId: string | null;
      enabledTools: string | string[];
      discoveryStatus: string;
      discoveredToolCount: number | null;
    }>;
  };
  assert.equal(body.ok, true);
  assert.equal(body.mcpAttachments.length, 1, "one attachment in bundle");
  const att = body.mcpAttachments[0]!;
  assert.equal(att.mcpServerId, server.id);
  assert.equal(att.name, server.name);
  assert.equal(att.scope, "global");
  assert.equal(att.projectId, null);
  assert.equal(att.enabledTools, "*");
  assert.equal(att.discoveryStatus, "ok");
  assert.equal(att.discoveredToolCount, tools.length, "discoveredToolCount matches probed tools");
});

test("GET pod bundle — mcpAttachments discoveredToolCount is null when server not probed", async () => {
  const app = makeApp();
  const agent = makeAgent();
  const server = makeRegistryServer(); // not probed -> discoveryStatus='stale'

  await app.request(
    "/api/agents/pods/" + agent.id + "/mcp-attachments/" + server.id,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabledTools: "*" }),
    },
  );

  const res = await app.request("/api/agents/pods/" + agent.id);
  const body = (await res.json()) as {
    mcpAttachments: Array<{ discoveryStatus: string; discoveredToolCount: number | null }>;
  };
  assert.equal(body.mcpAttachments.length, 1);
  assert.equal(body.mcpAttachments[0]!.discoveryStatus, "stale");
  assert.equal(body.mcpAttachments[0]!.discoveredToolCount, null);
});
