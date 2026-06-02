// Project create flow. The `POST /api/projects` endpoint thin-wraps this.
//
// Order of operations (per the multi-tenancy project-creation design):
//
//   1. Validate name + folder.
//   2. Resolve a unique slug from the name.
//   3. Mint a ULID up-front so the durable scaffold and the DB row share an
//      identity.
//   4. `git init -b main` in the project folder (skipped for attach-to-git).
//   5. If `init-in-place` AND the folder had pre-existing files: commit them
//      first as `Initial import` so the user can `git diff` the next commit
//      to see exactly what PC added.
//   6. Scaffold (templates rendered into the folder). attach-to-git skips
//      README to preserve the user's existing one.
//   7. Commit the scaffold as `Initial commit` (fresh folder) or
//      `Add Caisson scaffold` (in-place w/ pre-existing files or
//      attach-to-git — only the PC paths get staged, not the user's other
//      uncommitted changes).
//   8. Insert the DB row with the pre-minted id.
//   9. Register the runtime in the ProjectRegistry.
//
// Per Section 3 D2 (revised 17e.2, 2026-05-21): the 5 stock specialist pods
// live in the DB `agents` table at global scope, seeded at boot from
// `stock-pod-seed.ts`. `listResolvedAgents` reads them straight from the
// DB; nothing is copied into the project's `.claude/agents/` at create time.
// The per-project folder is created empty and (post-17d's Pod UI) stays
// empty in v1, since project-scope pods are deferred to 17c.
//
// Failure modes left uncovered for the first cut: partial scaffolds when git
// commit fails midway. The folder is left as-is; user can `rm -rf .git` and
// retry. Atomic-rollback is a followup once the create flow has tests.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type { Stage } from '@pc/domain';
import { persistCreatedProjectWithLiveEvent, type ProjectCreateFlowResult } from '@pc/app-services';
import { getProjectBySlug, newId } from '@pc/db';

import type { ProjectRegistry } from './project-registry.ts';
import type { ProjectScaffold, ProjectScaffoldTarget } from './project-scaffold.ts';

const exec = promisify(execFile);

export type CreateProjectMode = 'init-empty' | 'init-in-place' | 'attach-to-git';

export interface CreateProjectFlowInput {
  name: string;
  folderPath: string;
  mode: CreateProjectMode;
  gitRemote?: string | null;
  /** attach-to-git only: delete a pre-existing `.project-companion/` and re-adopt. */
  replaceExisting?: boolean;
}

// Section 27 — default stages carry the three flag slots. User can rename /
// delete / unflag any of them post-create.
const DEFAULT_STAGES: Stage[] = [
  { id: 'draft', name: 'Draft', order: 0, isNew: true },
  { id: 'review', name: 'Review', order: 1 },
  { id: 'done', name: 'Done', order: 2, isDone: true },
  { id: 'cancelled', name: 'Cancelled', order: 3, isCancelled: true },
];

/** Paths the scaffold writes; used to stage only PC's own files in
 *  attach-to-git so the user's other uncommitted changes are left alone.
 *  README.md is intentionally absent — attach-to-git skips it to preserve
 *  the existing repo's README. */
const SCAFFOLD_PATHS_FOR_COMMIT = ['.project-companion'];

export class ProjectCreate {
  constructor(
    private readonly scaffold: ProjectScaffold,
    private readonly registry: ProjectRegistry,
  ) {}

  async create(input: CreateProjectFlowInput): Promise<ProjectCreateFlowResult> {
    const name = (input.name ?? '').trim();
    if (!name) throw new Error('name required');
    if (
      input.mode !== 'init-empty' &&
      input.mode !== 'init-in-place' &&
      input.mode !== 'attach-to-git'
    ) {
      throw new Error(`invalid mode: ${input.mode}`);
    }
    const folderPath = resolve(input.folderPath);

    mkdirSync(folderPath, { recursive: true });

    const folderIsGitRepo = existsSync(resolve(folderPath, '.git'));
    if (input.mode === 'attach-to-git' && !folderIsGitRepo) {
      throw new Error(
        `folder is not a git repo: ${folderPath} — use mode 'init-empty' or 'init-in-place'`,
      );
    }
    if (input.mode !== 'attach-to-git' && folderIsGitRepo) {
      throw new Error(
        `folder is already a git repo: ${folderPath} — use mode 'attach-to-git' to adopt it`,
      );
    }

    if (input.mode === 'attach-to-git') {
      const pcDir = resolve(folderPath, '.project-companion');
      if (existsSync(pcDir) && directoryContainsFiles(pcDir)) {
        if (input.replaceExisting) {
          // Re-adopt: wipe the prior scaffold so the fresh one (+ new project
          // id) can be written. The git history is untouched; this only removes
          // the working-tree folder, committed below as part of the scaffold.
          rmSync(pcDir, { recursive: true, force: true });
        } else {
          throw new Error(
            `${folderPath}/.project-companion already exists — remove it first to re-adopt this repo`,
          );
        }
      }
    }

    const filesBefore = readdirSync(folderPath).filter((f) => f !== '.git');
    if (input.mode === 'init-empty' && filesBefore.length > 0) {
      throw new Error(
        `folder is not empty: ${folderPath} — use mode 'init-in-place' to commit existing files first`,
      );
    }

    const slug = this.uniqueSlug(name);
    const id = newId();

    if (input.mode !== 'attach-to-git') {
      await exec('git', ['init', '-b', 'main'], { cwd: folderPath });
    }

    const hadExistingFiles = filesBefore.length > 0;
    if (input.mode === 'init-in-place' && hadExistingFiles) {
      await exec('git', ['add', '.'], { cwd: folderPath });
      await exec('git', ['commit', '-m', 'Initial import'], { cwd: folderPath });
    }

    const target: ProjectScaffoldTarget = {
      folderPath,
      projectId: id,
      projectSlug: slug,
      projectName: name,
    };
    if (input.mode === 'attach-to-git') {
      this.scaffold.writeWithoutReadme(target);
    } else {
      this.scaffold.writeAll(target);
    }

    if (input.mode === 'attach-to-git') {
      // Stage ONLY PC's paths so the user's other uncommitted changes don't
      // get swept into our commit.
      await exec('git', ['add', '--', ...SCAFFOLD_PATHS_FOR_COMMIT], { cwd: folderPath });
    } else {
      await exec('git', ['add', '.'], { cwd: folderPath });
    }
    const scaffoldMsg =
      input.mode === 'attach-to-git' || hadExistingFiles
        ? 'Add Caisson scaffold'
        : 'Initial commit';
    await exec('git', ['commit', '-m', scaffoldMsg], { cwd: folderPath });

    const result = persistCreatedProjectWithLiveEvent({
      id,
      slug,
      name,
      stages: DEFAULT_STAGES,
      folderPath,
      gitRemote: input.gitRemote ?? null,
    });
    this.registry.register(result.project);
    return result;
  }

  /** `name` → kebab-case slug. Uniqued against the DB by appending `-2`, `-3`, … */
  private uniqueSlug(name: string): string {
    const base = slugify(name) || 'project';
    let candidate = base;
    let n = 1;
    while (getProjectBySlug(candidate)) {
      n += 1;
      candidate = `${base}-${n}`;
    }
    return candidate;
  }

}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function directoryContainsFiles(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && directoryContainsFiles(resolve(dir, entry.name))) return true;
  }
  return false;
}
