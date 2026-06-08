// T3 (pc-pty-chat-321) — regression lock: orchestrator-owned kinds never appear
// in the human inbox.
//
// DOCTRINE: agents never reach the human directly ("Inbox & review model — what
// reaches the human, and how"). Agent asks/approvals, escalated-ask notices, and
// dead-letter system-notices all go to the orchestrator (active-orchestrator /
// orchestrator-session), never to user-inbox.
//
// ── Producer audit (T3 confirms all are clean — no real leak found) ───────────
//   agent-question      → deliverAgentEnvelope (agent-delivery.ts)
//                         → orchestrator-session (real dispatcher)
//                           or active-orchestrator (synthetic dispatcher fallback)
//   agent-approval      → deliverAgentEnvelope (agent-delivery.ts)
//                         → same addressing as agent-question
//   agent-ask-escalated → sweepStalePendingAsks (pending-ask-watchdog.ts)
//                         → active-orchestrator, orchestrator-turn (post T2)
//   dead-letter notice  → mintDeadLetterNotice (mailbox-service.ts, M4b)
//                         → active-orchestrator, orchestrator-turn (post T7)
//   workflow-review (orchestrator flavor) → deliverWorkflowReview (index.ts)
//                         → active-orchestrator, orchestrator-turn
//   workflow-review (human flavor)       → user-inbox  ← the one correct human path
//   verification-review → applyHostTerminalSnapshot → agent-verification-review.ts
//                         → user-inbox  ← the other correct human path
//
// ── What this test locks ──────────────────────────────────────────────────────
//   1. Negative: each orchestrator-owned kind, enqueued to its real address
//      (active-orchestrator / orchestrator-session), must NEVER appear in the
//      human inbox routes — /api/projects/:id/mailbox (project view) or
//      /api/inbox (cross-project bell) — whether queried raw or with
//      actionableOnly=1.
//   2. Positive: a human-flavor workflow-review and a verification-review,
//      both addressed to user-inbox, MUST appear in both human inbox routes
//      and MUST survive the actionableOnly filter.
//
// If a future producer accidentally addresses an orchestrator-owned kind to
// user-inbox, it shows up in the project inbox and this test catches it.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-inbox-membership-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, createProject, runMigrations } = await import('@pc/db');
const { MailboxService } = await import('@pc/app-services');
const { registerMailboxRoutes } = await import('../src/features/mailbox/routes.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

function makeApp(): Hono {
  const app = new Hono();
  registerMailboxRoutes(app, { mailbox: new MailboxService() });
  return app;
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Enqueue one message directly via the mailbox route. Asserts 200. */
async function enqMsg(
  app: Hono,
  projectId: string,
  kind: string,
  address: Record<string, unknown>,
  channel: 'ui-inbox' | 'orchestrator-turn',
  idempotencyKey: string,
): Promise<void> {
  const res = await app.request(`/api/projects/${projectId}/mailbox/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind,
      body: `test body for ${kind}`,
      idempotencyKey,
      recipients: [{ address, channel }],
    }),
  });
  assert.equal(res.status, 200, `enqueue ${kind} → HTTP ${String(res.status)}`);
}

// ── Negative: orchestrator-owned kinds stay out of the human inbox ────────────

test('orchestrator-owned kinds addressed to active-orchestrator never appear in the human inbox', async () => {
  const app = makeApp();
  const project = createProject({
    slug: `ibm-neg-${Date.now()}`,
    name: 'Inbox Membership Neg',
    stages,
    folderPath: join(tmpDir, 'ibm-neg'),
  });

  // Each orchestrator-owned kind at its real producer address.
  // Producer: deliverAgentEnvelope → agent-question / agent-approval
  await enqMsg(
    app, project.id,
    'agent-question',
    { kind: 'active-orchestrator', projectId: project.id },
    'orchestrator-turn',
    `neg-agent-q-${Date.now()}`,
  );
  await enqMsg(
    app, project.id,
    'agent-approval',
    { kind: 'active-orchestrator', projectId: project.id },
    'orchestrator-turn',
    `neg-agent-a-${Date.now()}`,
  );
  // Producer: sweepStalePendingAsks → agent-ask-escalated (post T2)
  await enqMsg(
    app, project.id,
    'agent-ask-escalated',
    { kind: 'active-orchestrator', projectId: project.id },
    'orchestrator-turn',
    `neg-ask-esc-${Date.now()}`,
  );
  // Producer: mintDeadLetterNotice (M4b/T7) → system-notice dead-letter
  await enqMsg(
    app, project.id,
    'system-notice',
    { kind: 'active-orchestrator', projectId: project.id },
    'orchestrator-turn',
    `neg-dl-notice-${Date.now()}`,
  );
  // Producer: deliverWorkflowReview with flavor:'orchestrator'
  await enqMsg(
    app, project.id,
    'workflow-review',
    { kind: 'active-orchestrator', projectId: project.id },
    'orchestrator-turn',
    `neg-wf-orch-${Date.now()}`,
  );

  // Project inbox must be empty — server filters to addressKind='user-inbox'.
  const projInbox = await json<{ ok: boolean; items: { message: { kind: string } }[] }>(
    await app.request(`/api/projects/${project.id}/mailbox`),
  );
  assert.equal(projInbox.ok, true);
  assert.equal(
    projInbox.items.length, 0,
    `project inbox must be empty; got kinds: ${projInbox.items.map((i) => i.message.kind).join(', ')}`,
  );

  // Global cross-project inbox: filter by project to isolate our messages.
  const globalInbox = await json<{ ok: boolean; items: { message: { kind: string; projectId: string | null } }[] }>(
    await app.request('/api/inbox'),
  );
  assert.equal(globalInbox.ok, true);
  const projGlobal = globalInbox.items.filter((i) => i.message.projectId === project.id);
  assert.equal(
    projGlobal.length, 0,
    `global inbox must contain no rows for this project; got kinds: ${projGlobal.map((i) => i.message.kind).join(', ')}`,
  );

  // actionableOnly=1 (the filter the UI uses) also excludes them.
  const actionable = await json<{ ok: boolean; items: { message: { kind: string; projectId: string | null } }[] }>(
    await app.request(`/api/inbox?actionableOnly=1`),
  );
  assert.equal(actionable.ok, true);
  const projActionable = actionable.items.filter((i) => i.message.projectId === project.id);
  assert.equal(
    projActionable.length, 0,
    `actionableOnly inbox must contain no rows for this project; got: ${projActionable.map((i) => i.message.kind).join(', ')}`,
  );
});

// ── Positive: genuine review items DO appear and survive actionableOnly ───────

test('human-flavor workflow-review and verification-review addressed to user-inbox appear in the human inbox', async () => {
  const app = makeApp();
  const project = createProject({
    slug: `ibm-pos-${Date.now()}`,
    name: 'Inbox Membership Pos',
    stages,
    folderPath: join(tmpDir, 'ibm-pos'),
  });

  // Producer: deliverWorkflowReview with flavor:'human' → user-inbox, ui-inbox
  await enqMsg(
    app, project.id,
    'workflow-review',
    { kind: 'user-inbox', userId: 'local-user', projectId: project.id },
    'ui-inbox',
    `pos-wf-human-${Date.now()}`,
  );
  // Producer: applyHostTerminalSnapshot → agent-verification-review → user-inbox
  await enqMsg(
    app, project.id,
    'verification-review',
    { kind: 'user-inbox', userId: 'local-user', projectId: project.id },
    'ui-inbox',
    `pos-vr-${Date.now()}`,
  );

  // Both must appear in the project inbox.
  const projInbox = await json<{ ok: boolean; items: { message: { kind: string } }[] }>(
    await app.request(`/api/projects/${project.id}/mailbox`),
  );
  assert.equal(projInbox.ok, true);
  const kinds = projInbox.items.map((i) => i.message.kind);
  assert.ok(
    kinds.includes('workflow-review'),
    `project inbox must contain workflow-review; got: ${kinds.join(', ')}`,
  );
  assert.ok(
    kinds.includes('verification-review'),
    `project inbox must contain verification-review; got: ${kinds.join(', ')}`,
  );

  // Both must appear in the global cross-project inbox.
  const globalInbox = await json<{ ok: boolean; items: { message: { kind: string; projectId: string | null } }[] }>(
    await app.request('/api/inbox'),
  );
  assert.equal(globalInbox.ok, true);
  const projGlobal = globalInbox.items.filter((i) => i.message.projectId === project.id);
  const globalKinds = projGlobal.map((i) => i.message.kind);
  assert.ok(
    globalKinds.includes('workflow-review'),
    `global inbox must contain workflow-review for this project; got: ${globalKinds.join(', ')}`,
  );
  assert.ok(
    globalKinds.includes('verification-review'),
    `global inbox must contain verification-review for this project; got: ${globalKinds.join(', ')}`,
  );

  // actionableOnly=1 must include them (both are in ACTIONABLE_MAILBOX_KINDS).
  const actionable = await json<{ ok: boolean; items: { message: { kind: string; projectId: string | null } }[] }>(
    await app.request(`/api/inbox?actionableOnly=1`),
  );
  assert.equal(actionable.ok, true);
  const projActionable = actionable.items.filter((i) => i.message.projectId === project.id);
  const actionableKinds = projActionable.map((i) => i.message.kind);
  assert.ok(
    actionableKinds.includes('workflow-review'),
    `actionableOnly inbox must include workflow-review; got: ${actionableKinds.join(', ')}`,
  );
  assert.ok(
    actionableKinds.includes('verification-review'),
    `actionableOnly inbox must include verification-review; got: ${actionableKinds.join(', ')}`,
  );
});
