import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Project } from '@pc/domain';
import type { ProjectRegistry } from '../src/services/project-registry.ts';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-project-create-'));
process.env.PC_DATA_DIR = tmpDir;
process.env.GIT_AUTHOR_NAME = 'Caisson Test';
process.env.GIT_AUTHOR_EMAIL = 'caisson-test@example.invalid';
process.env.GIT_COMMITTER_NAME = 'Caisson Test';
process.env.GIT_COMMITTER_EMAIL = 'caisson-test@example.invalid';

const { closeDb, listLiveEventsAfter, runMigrations } = await import('@pc/db');
const { ProjectCreate } = await import('../src/services/project-create.ts');
const { ProjectScaffold } = await import('../src/services/project-scaffold.ts');

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('attach-to-git writes a tracked Caisson scaffold file before committing', async () => {
  const repoDir = join(tmpDir, 'existing-repo');
  mkdirSync(repoDir, { recursive: true });
  git(['init', '-b', 'main'], repoDir);
  writeFileSync(join(repoDir, 'README.md'), '# Existing repo\n', 'utf-8');
  git(['add', 'README.md'], repoDir);
  git(['commit', '-m', 'Initial project'], repoDir);
  mkdirSync(join(repoDir, '.project-companion', 'workflows'), { recursive: true });

  const templatesDir = join(tmpDir, 'templates');
  mkdirSync(join(templatesDir, '.project-companion', 'workflows'), { recursive: true });
  // FD-21: setup-wizard-prompt.md left the scaffold; workflow seeds are the
  // remaining project-companion scaffold artifact.
  writeFileSync(
    join(templatesDir, '.project-companion', 'workflows', 'seed.yaml'),
    'id: seed\n',
    'utf-8',
  );
  writeFileSync(join(templatesDir, 'README.template.md'), '# {{PROJECT_NAME}}\n', 'utf-8');

  const registered: Project[] = [];
  const scaffold = new ProjectScaffold({
    trunkPath: tmpDir,
    templatesDir,
    dataDir: tmpDir,
    serverPort: 4040,
  });
  const registry = {
    register(project: Project) {
      registered.push(project);
    },
  } as ProjectRegistry;

  const created = await new ProjectCreate(scaffold, registry).create({
    name: 'Adopted Repo',
    folderPath: repoDir,
    mode: 'attach-to-git',
  });

  assert.equal(registered[0]?.id, created.project.id);
  assert.equal(
    readFileSync(join(repoDir, '.project-companion', 'workflows', 'seed.yaml'), 'utf-8'),
    'id: seed\n',
  );
  assert.equal(created.legacyEvent.reason, 'created');
  assert.equal(created.liveEvent.type, 'project.changed');
  assert.equal(
    listLiveEventsAfter({ after: '0', type: 'project.changed' }).events.some(
      (event) => event.id === created.liveEvent.id,
    ),
    true,
  );
  assert.equal(gitOutput(['log', '-1', '--pretty=%s'], repoDir).trim(), 'Add Caisson scaffold');
  assert.deepEqual(
    gitOutput(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], repoDir)
      .trim()
      .split(/\r?\n/),
    ['.project-companion/workflows/seed.yaml'],
  );
});

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function gitOutput(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}
