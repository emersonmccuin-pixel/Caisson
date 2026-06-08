// Project + Stage domain types. A project owns an ordered list of stages
// (kanban columns); work items flow between them.

import type { ULID } from './ulid.ts';

export interface Stage {
  /** Slug-style id (e.g. 'draft', 'review', 'done'). String, not ULID — workflow
   *  YAMLs reference stages by slug for human readability. */
  id: string;
  /** Display name. Freely editable; id stays the same so workflow triggers don't break. */
  name: string;
  /** Position in the kanban (low → high, left → right). */
  order: number;
  /** Section 27 — terminal-success stage. At most one per project. Cards landing
   *  here auto-flip status to `complete`; agent verification auto-advances. */
  isDone?: boolean;
  /** Section 27 — terminal-abandon stage. At most one per project. Cards landing
   *  here auto-flip status to `cancelled`. Visible on the kanban by default; can
   *  be hidden via global setting + per-project override. */
  isCancelled?: boolean;
  /** Section 27 — intake stage. At most one per project. `pc_log_bug` +
   *  `create-work-item` step land new cards here when no explicit stage is supplied. */
  isNew?: boolean;
  /** UI Spine step 3 — monotonic write counter stamped from the project's
   *  stagesRev. Updated atomically with the stages JSON array; the frontend
   *  uses it to discard stale or duplicate WS deliveries. */
  rev?: number;
}

/** Section 27 — the post-move status for a card that just landed in this stage.
 *  `is_done` → `complete`; `is_cancelled` → `cancelled`; otherwise `pending`
 *  (today's behavior — preserves on_enter workflow re-fire semantics for
 *  non-terminal moves). Validator guarantees at most one flag per stage so the
 *  order of checks here is irrelevant. */
export function postMoveStatusForStage(
  stage: Pick<Stage, 'isDone' | 'isCancelled'>,
): 'complete' | 'cancelled' | 'pending' {
  if (stage.isDone) return 'complete';
  if (stage.isCancelled) return 'cancelled';
  return 'pending';
}

/** Section 27 — per-project setting overlay. Stored in the `projects.settings`
 *  JSON column; defaults fill in missing keys via `withProjectSettingsDefaults`. */
export interface ProjectSettings {
  /** Section 27 — per-project override on the global `hideCancelledStage`.
   *  `'use-global'` (default) inherits the resolved global value;
   *  `'force-visible'` always shows the cancelled column;
   *  `'force-hidden'` always hides it. */
  cancelledVisibility: 'use-global' | 'force-visible' | 'force-hidden';
  /** Per-project override on the global `remoteControlEnabled` default for new
   *  orchestrator sessions. `'use-global'` (default) inherits the global flag;
   *  `'on'` always launches sessions remote-ready; `'off'` never does. */
  remoteControl: 'use-global' | 'on' | 'off';
}

export function defaultProjectSettings(): ProjectSettings {
  return { cancelledVisibility: 'use-global', remoteControl: 'use-global' };
}

/** Backfill missing keys on a stored project-settings JSON blob. */
export function withProjectSettingsDefaults(
  stored: Partial<ProjectSettings> | undefined | null,
): ProjectSettings {
  const defaults = defaultProjectSettings();
  if (!stored) return defaults;
  const v = stored.cancelledVisibility;
  const rc = stored.remoteControl;
  return {
    cancelledVisibility:
      v === 'force-visible' || v === 'force-hidden' || v === 'use-global'
        ? v
        : defaults.cancelledVisibility,
    remoteControl:
      rc === 'on' || rc === 'off' || rc === 'use-global' ? rc : defaults.remoteControl,
  };
}

/** Section 27 — resolve the visibility of a project's cancelled-stage from
 *  the per-project override + the global flag. Returns true when the
 *  cancelled column should be hidden from the default kanban / table view.
 *  Cards in the cancelled stage are still reachable via direct links. */
export function resolveCancelledHidden(
  projectSettings: Partial<ProjectSettings> | undefined,
  globalHide: boolean,
): boolean {
  const resolved = withProjectSettingsDefaults(projectSettings).cancelledVisibility;
  if (resolved === 'force-visible') return false;
  if (resolved === 'force-hidden') return true;
  return globalHide;
}

/** Resolve whether a project's NEW orchestrator sessions should launch
 *  remote-ready, from the per-project override + the global default.
 *  `'on'`/`'off'` win; `'use-global'` falls back to the global flag. */
export function resolveRemoteControlEnabled(
  projectSettings: Partial<ProjectSettings> | undefined,
  globalEnabled: boolean,
): boolean {
  const resolved = withProjectSettingsDefaults(projectSettings).remoteControl;
  if (resolved === 'on') return true;
  if (resolved === 'off') return false;
  return globalEnabled;
}

export interface Project {
  id: ULID;
  /** URL-safe routing key. Derived from name + uniqued at create; locked thereafter
   *  (rename → slug migration is a deferred followup). Drives worktree paths, channel
   *  routes, and per-project filesystem layout. */
  slug: string;
  name: string;
  stages: Stage[];
  /** Absolute path to the user's project folder. Git-backed. */
  folderPath: string;
  /** Optional origin URL; null = local-only repo. Editable in project settings. */
  gitRemote: string | null;
  /** Section 27 — typed per-project overlay. Persisted in the
   *  `projects.settings` JSON column; defaults fill in missing keys. */
  settings: ProjectSettings;
  /** Section 35 — monotonic, never-reused counter for top-level callsign
   *  numbering. Highest assigned root number. Surfaced for forensic /
   *  debug use; UI doesn't read it directly. */
  callsignSeq: number;
  /** pc-pty-chat-333 — per-project scratch notes. Null when none saved yet. */
  notes: string | null;
}
