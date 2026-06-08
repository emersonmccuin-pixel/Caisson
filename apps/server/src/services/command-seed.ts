// Command space seed. Command is the reserved, global planning/steering
// space (see project_command_space design). Structurally it IS a project —
// it reuses all project machinery — so we seed it as a normal project row
// with a locked slug. What makes it special (global cross-project read,
// planner-role chat, focus stars) is layered on in later steps; step 1 is
// just "Command exists and is pinned above the project list".
//
// Idempotent: a no-op once the row exists. Runs at boot BEFORE
// projectRegistry.loadAll() so the runtime is loaded like any other project.

import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Stage } from '@pc/domain';
import { COMMAND_PROJECT_NAME, COMMAND_PROJECT_SLUG } from '@pc/contracts';
import { createProject, getProjectBySlug } from '@pc/db';

// Command's stages double as the general-TODO board. Kept minimal: a doing/done
// pair plus a cancelled lane so the planning ritual's "what got done" reads off
// stage status for free (isDone / isCancelled).
const COMMAND_STAGES: Stage[] = [
  { id: 'todo', name: 'To do', order: 0, isNew: true },
  { id: 'doing', name: 'Doing', order: 1 },
  { id: 'done', name: 'Done', order: 2, isDone: true },
  { id: 'cancelled', name: 'Cancelled', order: 3, isCancelled: true },
];

// Pin below every user project's reachable position. Negative so a future
// stray write that orders by `position` still floats Command to the top.
const COMMAND_POSITION = -1_000_000;

export interface CommandSeedResult {
  action: 'inserted' | 'exists';
  projectId: string;
}

/** Ensure the reserved Command project row exists. Gives it a real (empty)
 *  folder under the data dir so any folder/git touch downstream is harmless
 *  rather than resolving to an unexpected cwd. */
export function ensureCommandProject(dataDir: string): CommandSeedResult {
  const existing = getProjectBySlug(COMMAND_PROJECT_SLUG);
  if (existing) return { action: 'exists', projectId: existing.id };

  const folderPath = resolve(dataDir, 'command-workspace');
  if (!existsSync(folderPath)) mkdirSync(folderPath, { recursive: true });

  const project = createProject({
    slug: COMMAND_PROJECT_SLUG,
    name: COMMAND_PROJECT_NAME,
    stages: COMMAND_STAGES,
    folderPath,
    position: COMMAND_POSITION,
  });
  return { action: 'inserted', projectId: project.id };
}
