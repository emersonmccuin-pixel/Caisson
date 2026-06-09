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
//   6. Scaffold (README rendered into the folder) + commit — non-attach modes
//      only. attach-to-git writes and commits NOTHING in the user's repo:
//      workflows are DB-resident (19.13+), so adoption is purely a DB-side
//      registration. (The old `.project-companion/` seed-and-commit path died
//      with the workflow YAML seeds — bbb55166.)
//   7. Insert the DB row with the pre-minted id.
//   8. Register the runtime in the ProjectRegistry.
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
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type { Stage } from '@pc/domain';
import { persistCreatedProjectWithLiveEvent, type ProjectCreateFlowResult } from '@pc/app-services';
import { getProjectBySlug, newId } from '@pc/db';

import type { ProjectRegistry } from './project-registry.ts';
import type { ProjectScaffold, ProjectScaffoldTarget } from './project-scaffold.ts';

const exec = promisify(execFile);

/** Return `git -c` args supplying a fallback commit identity when the machine
 *  has none configured (fresh installs: no global user.name/user.email → git
 *  aborts the commit with "Please tell me who you are"). Returns [] when a real
 *  identity is resolvable, so the user's own name/email is always preferred.
 *  The `-c` form scopes the fallback to a single invocation; nothing is written
 *  to the user's global git config. */
async function gitIdentityArgs(cwd: string): Promise<string[]> {
  const resolved = async (key: string): Promise<boolean> => {
    try {
      const { stdout } = await exec('git', ['config', key], { cwd });
      return stdout.trim().length > 0;
    } catch {
      return false; // unset → git config exits non-zero
    }
  };
  if ((await resolved('user.name')) && (await resolved('user.email'))) return [];
  return ['-c', 'user.name=Caisson', '-c', 'user.email=caisson@localhost'];
}

export type CreateProjectMode = 'init-empty' | 'init-in-place' | 'attach-to-git';

export interface CreateProjectFlowInput {
  name: string;
  folderPath: string;
  mode: CreateProjectMode;
  gitRemote?: string | null;
}

// Section 27 — default stages carry the three flag slots. User can rename /
// delete / unflag any of them post-create.
const DEFAULT_STAGES: Stage[] = [
  { id: 'todo', name: 'To Do', order: 0, isNew: true },
  { id: 'in-progress', name: 'In Progress', order: 1 },
  { id: 'done', name: 'Done', order: 2, isDone: true },
  { id: 'cancelled', name: 'Cancelled', order: 3, isCancelled: true },
];

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

    // Git refuses to commit with no identity configured. On a fresh machine
    // neither user.name nor user.email is set, so the commits below fail with
    // "Please tell me who you are" — the red error a first-time user hit on
    // create. Inject a fallback identity for THESE commits only (via -c, never
    // written to the user's global config) when none is resolvable.
    const idArgs = await gitIdentityArgs(folderPath);

    const hadExistingFiles = filesBefore.length > 0;
    if (input.mode === 'init-in-place' && hadExistingFiles) {
      await exec('git', ['add', '.'], { cwd: folderPath });
      await exec('git', [...idArgs, 'commit', '-m', 'Initial import'], { cwd: folderPath });
    }

    if (input.mode !== 'attach-to-git') {
      const target: ProjectScaffoldTarget = {
        folderPath,
        projectId: id,
        projectSlug: slug,
        projectName: name,
      };
      this.scaffold.writeAll(target);
      await exec('git', ['add', '.'], { cwd: folderPath });
      const scaffoldMsg = hadExistingFiles ? 'Add Caisson scaffold' : 'Initial commit';
      await exec('git', [...idArgs, 'commit', '-m', scaffoldMsg], { cwd: folderPath });
    }

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
