// Slice C — checklist-completion auto-move trigger tests (pc-pty-chat-422).
//
// Four invariants verified here:
//  1. Tick last open box → WI moves to the isDone stage (auto-advance fires).
//  2. Tick non-last box → no move (auto-advance does NOT fire).
//  3. No-isDone-stage project → status flips to 'complete', no crash, log emitted.
//  4. Idempotency: checklist-complete + contract-PASS in the same window → exactly
//     one effective move, no double history churn.
//  5. Soft gate: manual move-to-Done with open boxes succeeds + returns a warning.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import type { Project, ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-checklist-automove-'));
process.env.PC_DATA_DIR = tmpDir;

const {
  closeDb,
  createProject,
  createWorkItem,
  getProjectById,
  getWorkItem,
  moveWorkItemStage,
  runMigrations,
  setDoneChecklist,
  tickDoneChecklistItem,
} = await import('@pc/db');

const { triggerChecklistAutoMoveIfComplete } = await import(
  '../src/services/checklist-auto-move.ts'
);
const { autoAdvanceToDoneStage } = await import(
  '../src/services/auto-advance-done.ts'
);
const { registerWorkItemRoutes } = await import(
  '../src/features/work-items/routes.ts'
);

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const stagesWithDone = [
  { id: 'todo', name: 'Todo', order: 0 },
  { id: 'done', name: 'Done', order: 1, isDone: true as const },
];

const stagesNoDone = [{ id: 'todo', name: 'Todo', order: 0 }];

let seq = 0;
function seedProject(withDoneStage: boolean): Project {
  seq += 1;
  return createProject({
    slug: `cam-${seq}-${Date.now().toString(36)}`,
    name: `CAM ${seq}`,
    stages: withDoneStage ? stagesWithDone : stagesNoDone,
    folderPath: join(tmpDir, `cam-${seq}`),
  });
}

// ── Test 1: tick last open box → auto-move fires ──────────────────────────────

test('tick last open box → WI moves to isDone stage', () => {
  const project = seedProject(true);
  const wi = createWorkItem({ projectId: project.id as ULID, stageId: 'todo', title: 'T1' });

  setDoneChecklist(wi.id, [
    { id: 'a', label: 'Alpha', done: true, kind: 'manual' as const },
    { id: 'b', label: 'Beta', done: false, kind: 'manual' as const },
  ]);

  // Tick the last open item, then fire the trigger.
  tickDoneChecklistItem(wi.id, 'b', true);
  triggerChecklistAutoMoveIfComplete(wi.id, project);

  const result = getWorkItem(wi.id)!;
  assert.equal(result.stageId, 'done', 'WI must be in the isDone stage after last tick');
  assert.equal(result.status, 'complete', 'status must be complete');
  const moveEntries = result.history.filter((h) => h.kind === 'move');
  assert.equal(moveEntries.length, 1, 'exactly one move history entry');
});

// ── Test 2: tick non-last box → no auto-move ─────────────────────────────────

test('tick non-last box → WI does NOT move to Done stage', () => {
  const project = seedProject(true);
  const wi = createWorkItem({ projectId: project.id as ULID, stageId: 'todo', title: 'T2' });

  setDoneChecklist(wi.id, [
    { id: 'a', label: 'Alpha', done: false, kind: 'manual' as const },
    { id: 'b', label: 'Beta', done: false, kind: 'manual' as const },
  ]);

  // Tick only one of the two open items.
  tickDoneChecklistItem(wi.id, 'a', true);
  triggerChecklistAutoMoveIfComplete(wi.id, project);

  const result = getWorkItem(wi.id)!;
  assert.equal(result.stageId, 'todo', 'WI must stay in todo — not all items ticked');
  assert.equal(
    result.history.filter((h) => h.kind === 'move').length,
    0,
    'no move entry — trigger must not fire',
  );
});

// ── Test 3: no isDone stage → status flip, no crash ──────────────────────────

test('no-isDone-stage project → status flips to complete, no crash, log emitted', () => {
  const project = seedProject(false);
  const wi = createWorkItem({ projectId: project.id as ULID, stageId: 'todo', title: 'T3' });

  setDoneChecklist(wi.id, [
    { id: 'x', label: 'Only item', done: true, kind: 'manual' as const },
  ]);

  const logLines: string[] = [];
  const orig = console.log.bind(console);
  console.log = (...args: unknown[]) => logLines.push(args.join(' '));
  try {
    triggerChecklistAutoMoveIfComplete(wi.id, project);
  } finally {
    console.log = orig;
  }

  const result = getWorkItem(wi.id)!;
  assert.equal(result.status, 'complete', 'status must be flipped to complete');
  assert.equal(result.stageId, 'todo', 'stageId unchanged — no isDone stage exists');

  const logged = logLines.some((l) => l.includes('no isDone stage'));
  assert.ok(logged, 'must emit a log line mentioning "no isDone stage"');
});

// ── Test 4: idempotency — checklist-complete + contract-PASS → one move ───────

test('idempotency: checklist-complete then contract-PASS → exactly one move', () => {
  const project = seedProject(true);
  const wi = createWorkItem({ projectId: project.id as ULID, stageId: 'todo', title: 'T4' });

  setDoneChecklist(wi.id, [
    { id: 'q', label: 'Q', done: true, kind: 'manual' as const },
  ]);

  // First trigger: checklist path moves the WI to Done.
  triggerChecklistAutoMoveIfComplete(wi.id, project);
  const afterFirst = getWorkItem(wi.id)!;
  assert.equal(afterFirst.stageId, 'done', 'WI must be in done after first trigger');
  assert.equal(
    afterFirst.history.filter((h) => h.kind === 'move').length,
    1,
    'exactly one move after first trigger',
  );

  // Simulate contract-PASS path calling autoAdvanceToDoneStage (the existing one door).
  // It must no-op because the WI is already in the isDone stage.
  const noOp = autoAdvanceToDoneStage(wi.id, project);
  assert.equal(noOp, null, 'autoAdvanceToDoneStage must return null when already Done');

  const afterSecond = getWorkItem(wi.id)!;
  assert.equal(
    afterSecond.history.filter((h) => h.kind === 'move').length,
    1,
    'still exactly one move — no double history churn',
  );
  assert.equal(afterSecond.version, afterFirst.version, 'version must not bump on the no-op');
});

// ── Test 5: soft gate — move-to-Done with open boxes → ok + warning ──────────

test('soft gate: move-to-Done with open checklist boxes → ok:true + warning', async () => {
  const project = seedProject(true);
  const wi = createWorkItem({ projectId: project.id as ULID, stageId: 'todo', title: 'T5' });
  setDoneChecklist(wi.id, [
    { id: 'open1', label: 'Still open 1', done: false, kind: 'manual' as const },
    { id: 'open2', label: 'Still open 2', done: false, kind: 'manual' as const },
  ]);

  // Minimal route harness: moveWorkItemV2 calls the real DB move.
  const app = new Hono();
  registerWorkItemRoutes(app, {
    resolveProject: (pid: string) => {
      const p = getProjectById(pid as ULID);
      if (!p) return null;
      return {
        project: p,
        workItemService: () => ({
          list: () => ({ items: [], nextCursor: undefined }),
          get: () => null,
        }),
        attachmentService: () => ({}),
        fieldSchemaService: () => ({ getAll: () => [] }),
        moveWorkItemV2: async (args: { id: string; toStage: string; notes?: string | null }) => {
          const moved = moveWorkItemStage(args.id as ULID, args.toStage, 'complete');
          if (!moved) throw new Error(`unknown work item: ${args.id}`);
          return moved;
        },
      } as unknown as ReturnType<Parameters<typeof registerWorkItemRoutes>[1]['resolveProject']>;
    },
    broadcastTo: () => {},
    refreshProject: () => {},
  });

  const url = `http://t/api/projects/${project.id}/work-items/move`;
  const req = new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: wi.id, toFlag: 'done' }),
  });

  const res = await app.fetch(req);
  assert.equal(res.status, 200, 'move must succeed (soft gate — not a block)');
  const body = await res.json() as { ok: boolean; workItem: unknown; warning?: string };
  assert.equal(body.ok, true, 'ok must be true');
  assert.ok(body.warning, 'must include a warning field');
  assert.ok(
    (body.warning as string).includes('2'),
    `warning must mention the open count (got: "${body.warning as string}")`,
  );

  // WI actually moved — soft gate never blocks.
  const moved = getWorkItem(wi.id)!;
  assert.equal(moved.stageId, 'done', 'move must have executed despite open boxes');
});
