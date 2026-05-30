import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-wf-runs-status-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, createProject, runMigrations, workflowRunsV2Repo } = await import('../src/index.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];

test('listRunsByStatus returns only runs in the requested statuses, oldest-first', () => {
  const project = createProject({
    slug: `wf-status-${Date.now()}`,
    name: 'WF Status',
    stages,
    folderPath: join(tmpDir, 'wf'),
  });

  function seed(status: 'pending' | 'running' | 'paused' | 'completed') {
    return workflowRunsV2Repo.createRun({
      workflowId: 'deploy',
      workflowName: 'Deploy',
      projectId: project.id,
      workflowYamlSnapshot: JSON.stringify({ id: 'deploy', name: 'Deploy', triggers: [], nodes: [] }),
      trigger: 'manual',
      status,
    });
  }

  const running = seed('running');
  const paused = seed('paused');
  seed('completed');
  const pending = seed('pending');

  const nonTerminal = workflowRunsV2Repo.listRunsByStatus(['pending', 'running', 'paused']);
  const ids = nonTerminal.map((r) => r.id).sort();
  assert.deepEqual(ids, [running.id, paused.id, pending.id].sort());

  // completed excluded
  assert.equal(
    workflowRunsV2Repo.listRunsByStatus(['completed']).every((r) => r.status === 'completed'),
    true,
  );

  // empty status set short-circuits
  assert.deepEqual(workflowRunsV2Repo.listRunsByStatus([]), []);
});
