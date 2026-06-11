// Integration-branch resolver — the ONE writer of
// `project.settings.integrationBranch`.
//
// Every consumer of "which branch does finished work land on?" (WorktreeService
// sweep/teardown, the workflow merge node, verification's diff predicate) reads
// the persisted setting; this resolver is the only thing that fills it in when
// absent. Resolution order:
//   1. explicit setting — verified resolvable in the repo, else THROW loudly
//      (a configured-but-missing branch is a misconfiguration, never a
//      silent-fallback situation),
//   2. one-time auto-detect (`detectIntegrationBranch`: local `dev` →
//      origin/HEAD → current branch), persisted back into project settings so
//      the fact becomes explicit, visible, and editable in the UI,
//   3. nothing detectable → THROW loudly.
//
// Persist is a plain DB settings write (no live event): detection is a
// background fact write; the UI shows it on the next project fetch.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

import type { Project } from '@pc/domain';
import { INTEGRATION_BRANCH_RE } from '@pc/domain';
import { updateProjectMeta } from '@pc/db';
import { detectIntegrationBranch as defaultDetect } from '@pc/runtime';

const _exec = promisify(execFile);

/** True when `name` resolves as a local branch or as `origin/<name>`. */
async function defaultRefResolves(workspaceDir: string, name: string): Promise<boolean> {
  const cwd = resolve(workspaceDir);
  for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`]) {
    try {
      await _exec('git', ['rev-parse', '--verify', '--quiet', ref], { cwd });
      return true;
    } catch {
      /* try the next form */
    }
  }
  return false;
}

export interface IntegrationBranchResolverDeps {
  /** Live project accessor (survives ProjectRuntime.refresh). */
  getProject: () => Project;
  /** Absolute path to the project's git repo. */
  workspaceDir: string;
  /** Persist the detected branch into project settings. Returns the updated
   *  row (null = project gone). Default: @pc/db updateProjectMeta. */
  persist?: (projectId: string, branch: string) => Project | null;
  /** Push the updated row back into the runtime cache after a persist. */
  onPersisted?: (project: Project) => void;
  /** Override the git auto-detection (tests). */
  detect?: (workspaceDir: string) => Promise<string | null>;
  /** Override the ref-existence probe (tests). */
  refResolves?: (workspaceDir: string, name: string) => Promise<boolean>;
}

export function makeIntegrationBranchResolver(
  deps: IntegrationBranchResolverDeps,
): () => Promise<string> {
  const persist =
    deps.persist ??
    ((projectId: string, branch: string) =>
      updateProjectMeta(projectId as Project['id'], { settings: { integrationBranch: branch } }));
  const detect = deps.detect ?? defaultDetect;
  const refResolves = deps.refResolves ?? defaultRefResolves;

  return async function resolveIntegrationBranch(): Promise<string> {
    const project = deps.getProject();
    const configured = project.settings.integrationBranch;

    if (configured) {
      if (!INTEGRATION_BRANCH_RE.test(configured)) {
        throw new Error(
          `integration branch ${JSON.stringify(configured)} for project "${project.slug}" is not a valid ref name — fix it in Project Settings`,
        );
      }
      if (!(await refResolves(deps.workspaceDir, configured))) {
        throw new Error(
          `integration branch "${configured}" for project "${project.slug}" does not exist in ${deps.workspaceDir} — fix it in Project Settings`,
        );
      }
      return configured;
    }

    const detected = await detect(deps.workspaceDir);
    if (!detected) {
      throw new Error(
        `cannot detect an integration branch for project "${project.slug}" (${deps.workspaceDir}) — set one in Project Settings`,
      );
    }
    // Idempotent under concurrent first-resolutions: both detect the same
    // value; the second write is a no-op overwrite of the same fact.
    const updated = persist(project.id, detected);
    if (updated) deps.onPersisted?.(updated);
    return detected;
  };
}
