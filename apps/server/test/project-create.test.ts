import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

test('attach-to-git adopts the repo without writing or committing anything', async () => {
  const repoDir = join(tmpDir, 'existing-repo');
  mkdirSync(repoDir, { recursive: true });
  git(['init', '-b', 'main'], repoDir);
  writeFileSync(join(repoDir, 'README.md'), '# Existing repo\n', 'utf-8');
  git(['add', 'README.md'], repoDir);
  git(['commit', '-m', 'Initial project'], repoDir);

  const templatesDir = join(tmpDir, 'templates');
  mkdirSync(templatesDir, { recursive: true });
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
  assert.equal(created.legacyEvent.reason, 'created');
  assert.equal(created.liveEvent.type, 'project.changed');
  assert.equal(
    listLiveEventsAfter({ after: '0', type: 'project.changed' }).events.some(
      (event) => event.id === created.liveEvent.id,
    ),
    true,
  );
  // Adoption is DB-side only: no new commit, no scaffold files, clean tree.
  assert.equal(gitOutput(['log', '-1', '--pretty=%s'], repoDir).trim(), 'Initial project');
  assert.equal(gitOutput(['status', '--porcelain'], repoDir).trim(), '');
  assert.equal(existsSync(join(repoDir, '.project-companion')), false);
});

test('init-empty commits even when git has NO identity configured (fresh-machine fallback)', async () => {
  const repoDir = join(tmpDir, 'fresh-no-identity');
  mkdirSync(repoDir, { recursive: true });

  const templatesDir = join(tmpDir, 'templates-fresh');
  mkdirSync(templatesDir, { recursive: true });
  writeFileSync(join(templatesDir, 'README.template.md'), '# {{PROJECT_NAME}}\n', 'utf-8');

  const scaffold = new ProjectScaffold({
    trunkPath: tmpDir,
    templatesDir,
    dataDir: tmpDir,
    serverPort: 4040,
  });
  const registry = { register() {} } as unknown as ProjectRegistry;

  // Simulate a fresh machine: no usable git identity anywhere. Strip the
  // GIT_AUTHOR/COMMITTER env this file sets globally, and point git at empty
  // global/system config so the dev box's real identity can't leak in.
  const saved = {
    an: process.env.GIT_AUTHOR_NAME,
    ae: process.env.GIT_AUTHOR_EMAIL,
    cn: process.env.GIT_COMMITTER_NAME,
    ce: process.env.GIT_COMMITTER_EMAIL,
    cg: process.env.GIT_CONFIG_GLOBAL,
    cs: process.env.GIT_CONFIG_SYSTEM,
    ns: process.env.GIT_CONFIG_NOSYSTEM,
  };
  const emptyCfg = join(tmpDir, 'empty-gitconfig');
  writeFileSync(emptyCfg, '', 'utf-8');
  delete process.env.GIT_AUTHOR_NAME;
  delete process.env.GIT_AUTHOR_EMAIL;
  delete process.env.GIT_COMMITTER_NAME;
  delete process.env.GIT_COMMITTER_EMAIL;
  process.env.GIT_CONFIG_GLOBAL = emptyCfg;
  process.env.GIT_CONFIG_SYSTEM = emptyCfg;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  try {
    // Precondition: git genuinely has no identity now → a plain commit WOULD
    // fail with "Please tell me who you are" without the fallback.
    let identityResolvable = true;
    try {
      execFileSync('git', ['config', 'user.email'], { cwd: tmpDir, stdio: 'pipe' });
    } catch {
      identityResolvable = false;
    }
    assert.equal(identityResolvable, false, 'precondition: no git identity configured');

    const created = await new ProjectCreate(scaffold, registry).create({
      name: 'Fresh No Identity',
      folderPath: repoDir,
      mode: 'init-empty',
    });

    assert.ok(created.project.id, 'project created');
    // A commit landed despite no configured identity → the fallback worked.
    assert.equal(gitOutput(['log', '-1', '--pretty=%s'], repoDir).trim(), 'Initial commit');
    assert.equal(gitOutput(['log', '-1', '--pretty=%an'], repoDir).trim(), 'Caisson');
  } finally {
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore('GIT_AUTHOR_NAME', saved.an);
    restore('GIT_AUTHOR_EMAIL', saved.ae);
    restore('GIT_COMMITTER_NAME', saved.cn);
    restore('GIT_COMMITTER_EMAIL', saved.ce);
    restore('GIT_CONFIG_GLOBAL', saved.cg);
    restore('GIT_CONFIG_SYSTEM', saved.cs);
    restore('GIT_CONFIG_NOSYSTEM', saved.ns);
  }
});

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function gitOutput(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}
