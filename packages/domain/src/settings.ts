// GlobalSettings — app-level singleton (one row, id='global').

import type { ULID } from './ulid.ts';

// ── Per-surface font theming ─────────────────────────────────────────────────

/** All recognised font keys. Mono keys are eligible for every surface group;
 *  sans/serif/'system' keys are NOT eligible for the `code` group. */
export type FontKey =
  | 'inter'
  | 'ibm-plex-sans'
  | 'atkinson-hyperlegible'
  | 'source-serif-4'
  | 'system'
  | 'jetbrains-mono'
  | 'fira-code'
  | 'ibm-plex-mono'
  | 'system-mono';

export const FONT_KEYS: readonly FontKey[] = [
  'inter',
  'ibm-plex-sans',
  'atkinson-hyperlegible',
  'source-serif-4',
  'system',
  'jetbrains-mono',
  'fira-code',
  'ibm-plex-mono',
  'system-mono',
] as const;

/** Mono font keys — the only ones eligible for the `code` surface group. */
export const MONO_FONT_KEYS: readonly FontKey[] = [
  'jetbrains-mono',
  'fira-code',
  'ibm-plex-mono',
  'system-mono',
] as const;

/** The four user-configurable surface groups. */
export type FontGroup = 'chat' | 'workItems' | 'ui' | 'code';

export interface FontSettings {
  chat: FontKey;
  workItems: FontKey;
  ui: FontKey;
  code: FontKey;
}

export const FONT_GROUP_DEFAULTS: FontSettings = {
  chat: 'inter',
  workItems: 'inter',
  ui: 'jetbrains-mono',
  code: 'jetbrains-mono',
};

/** Coerce an unknown / ineligible font key back to the group default.
 *  - Unknown key → group default.
 *  - Sans/serif/system key in the `code` group → group default (mono only). */
export function normalizeFontKey(key: unknown, group: FontGroup): FontKey {
  const fallback = FONT_GROUP_DEFAULTS[group];
  if (typeof key !== 'string') return fallback;
  if (!(FONT_KEYS as readonly string[]).includes(key)) return fallback;
  const fk = key as FontKey;
  if (group === 'code' && !(MONO_FONT_KEYS as readonly string[]).includes(fk)) return fallback;
  return fk;
}

/** Normalise a raw object into a valid FontSettings, back-filling any
 *  missing / invalid keys with per-group defaults. */
export function normalizeFontSettings(raw: unknown): FontSettings {
  if (typeof raw !== 'object' || raw === null) return { ...FONT_GROUP_DEFAULTS };
  const obj = raw as Record<string, unknown>;
  return {
    chat: normalizeFontKey(obj['chat'], 'chat'),
    workItems: normalizeFontKey(obj['workItems'], 'workItems'),
    ui: normalizeFontKey(obj['ui'], 'ui'),
    code: normalizeFontKey(obj['code'], 'code'),
  };
}

export interface ActivityPanelSettings {
  /** User's last persisted open/closed state for the right-rail activity panel. */
  open: boolean;
  /**
   * If true, ActivityPanel subscribes to every project's WS feed (Q12), not
   * just the active one. Defaults false — single-project scope is the
   * cheaper default.
   */
  showAllProjects: boolean;
}

/** Section 18.6 + 18.7 — dispatch-side controls for `pc_invoke_agent`. */
export interface AgentDispatchSettings {
  /**
   * Async-dispatch ack window. `pc_invoke_agent` blocks only until
   * the spawned agent emits its first non-system JSONL event OR this timer
   * fires. Default 60s — Section 20.A.4 bumped from 30s after 4-back-to-back
   * cold spawns under the legacy `npx -y tsx ...` MCP command blew past 30s.
   * 20.A.1 + 20.A.2 fix the underlying cold-spawn cost; this 60s window stays
   * as a safety net for genuinely slow spawns.
   */
  ackTimeoutMs: number;
  /**
   * Section 18.7 — maximum number of agent runs PC will hold in
   * non-terminal states (spawning / running / paused) at any one time,
   * across ALL projects. Dispatches at or over the cap queue FIFO and
   * spawn when a running run terminates. Global (not per-project) because
   * the subscription burn-rate cap is global; per-project sub-caps may
   * land post-v1. Default 5.
   */
  maxConcurrent: number;
}

export const AGENT_ACK_TIMEOUT_MS_MIN = 1_000;
export const AGENT_ACK_TIMEOUT_MS_MAX = 5 * 60 * 1000;
export const AGENT_MAX_CONCURRENT_MIN = 1;
export const AGENT_MAX_CONCURRENT_MAX = 50;

/** Section 18.8 — retention for CC's per-session JSONL files (the source of
 *  truth for PC's chat replay + agent run history). Stored as either a
 *  positive integer (days) or the literal string `'never'` to opt out of
 *  sweeping entirely. */
export interface JsonlSettings {
  retentionDays: number | 'never';
}

export const JSONL_RETENTION_DAYS_MIN = 1;
export const JSONL_RETENTION_DAYS_MAX = 3650;

export type OrchestratorSurfacePreference = 'chat' | 'terminal';

export interface GlobalSettings {
  /** Active data dir at last write. */
  dataDir: string;
  /** Telemetry opt-in. Default false. */
  telemetryOptIn: boolean;
  /**
   * Section 10 Phase 0 — explicit override for the claude binary path. Null =
   * resolve automatically (CLAUDE_EXE env → PATH → ~/.local/bin). Highest-
   * priority source in the resolver after a per-spawn arg. Set by the
   * onboarding wizard once it locates/installs Claude Code.
   */
  claudeExe: string | null;
  /**
   * Section 33 — override for which Claude account/profile PC talks to, by
   * pointing `CLAUDE_CONFIG_DIR` at a chosen config dir. `null` = inherit the
   * shell env that launched the server (the historical, invisible default).
   * Non-null = the server forces `process.env.CLAUDE_CONFIG_DIR` to this on
   * boot and on every settings PATCH, so each CC spawn AND every JSONL path
   * (chat replay, retention sweep, Usage aggregation) resolves against the
   * chosen profile. Applies to NEW chat sessions only — existing sessions stay
   * bound to whatever dir they spawned under.
   */
  claudeConfigDir: string | null;
  /**
   * Section 10 Phase 2 — ISO timestamp of when the first-run onboarding wizard
   * was completed (or skipped). `null` = never completed → the wizard gate
   * shows on app boot. Once set, the gate stays out of the way. The dev
   * `?onboarding=force` switch bypasses this for testing.
   */
  onboardingCompletedAt: string | null;
  /** Default live orchestrator surface when no per-session local override exists. */
  defaultOrchestratorSurface: OrchestratorSurfacePreference;
  /**
   * Default parent dir for new projects. Used by the create-project folder
   * picker as the initial path. Hot-reloadable — no restart required.
   */
  projectsFolder: string;
  /** Activity-panel UI preferences. */
  activityPanel: ActivityPanelSettings;
  /**
   * Target project id for the `pc_log_bug` MCP tool. When set, Log Bug calls
   * from any project's orchestrator file a bug card here with type='bug'.
   * Null = Log Bug returns a configuration error.
   */
  bugLogTargetProjectId: ULID | null;
  /**
   * Multiplier for the html root font size — every rem-based UI size scales
   * with this. Slider in App Settings clamps the value to [0.85, 1.5].
   * Default 1.0 = no change.
   */
  fontScale: number;
  /** Section 18.6 — dispatch-side controls for `pc_invoke_agent`. */
  agentDispatch: AgentDispatchSettings;
  /** Section 18.8 — JSONL retention sweep settings. */
  jsonl: JsonlSettings;
  /** Section 27 — when true, kanban + table views hide the project's
   *  `is_cancelled` stage by default. Per-project `cancelledVisibility`
   *  override on the project record wins (forced visible / forced hidden /
   *  use-global). Cards in the cancelled stage are still reachable via
   *  "Show archived" and direct links. */
  hideCancelledStage: boolean;
  /** Remote-control default for NEW orchestrator sessions. When true, orchestrator
   *  sessions launch remote-ready (the `remoteControlAtStartup` key is written into
   *  the session's settings.json) so they can be driven from the Claude phone/web
   *  app. Per-project `remoteControl` override wins (on / off / use-global).
   *  Dispatched agent/worker sessions are never remote-controlled. Default true. */
  remoteControlEnabled: boolean;
  /** When true, the Command space — a cross-project planning project pinned at
   *  the top of the project rail — is shown. Off by default: Command is an
   *  advanced, opt-in surface for people juggling many projects, so a fresh
   *  install keeps the rail focused on real projects until the user turns it
   *  on in App Settings. Toggling this only shows/hides the rail entry; the
   *  Command project and its data are untouched. */
  showCommandSpace: boolean;
  /** Per-surface font selections. Each key maps to a FontKey registered in the
   *  web app's font registry. Defaults: chat/workItems → Inter; ui/code →
   *  JetBrains Mono. */
  fonts: FontSettings;
}

export const FONT_SCALE_MIN = 0.85;
export const FONT_SCALE_MAX = 1.5;

/** Section 33 — given the stored `claudeConfigDir` override and the value
 *  `CLAUDE_CONFIG_DIR` held when the server launched, return what
 *  `process.env.CLAUDE_CONFIG_DIR` should be set to. `undefined` means the var
 *  should be unset entirely. A non-null override wins; otherwise fall back to
 *  the captured shell value (which may itself be `undefined`). Pure so the
 *  "clearing the override restores the shell default, not the last override"
 *  rule is unit-testable away from `process.env`. */
export function resolveClaudeConfigDirEnv(
  override: string | null,
  shellValue: string | undefined,
): string | undefined {
  return override ? override : shellValue;
}

/** Defaults for a fresh settings_global row. The DB seeder calls this with
 *  the launch-time data dir and home dir so domain stays I/O-free. */
export function defaultGlobalSettings(dataDir: string, homeDir: string): GlobalSettings {
  return {
    dataDir,
    telemetryOptIn: false,
    claudeExe: null,
    claudeConfigDir: null,
    onboardingCompletedAt: null,
    defaultOrchestratorSurface: 'chat',
    projectsFolder: joinPath(homeDir, 'Projects'),
    activityPanel: {
      open: true,
      showAllProjects: false,
    },
    bugLogTargetProjectId: null,
    fontScale: 1,
    agentDispatch: {
      ackTimeoutMs: 60_000,
      maxConcurrent: 5,
    },
    jsonl: {
      retentionDays: 30,
    },
    hideCancelledStage: false,
    remoteControlEnabled: true,
    showCommandSpace: false,
    fonts: { ...FONT_GROUP_DEFAULTS },
  };
}

export function clampFontScale(n: number): number {
  if (!Number.isFinite(n)) return 1;
  if (n < FONT_SCALE_MIN) return FONT_SCALE_MIN;
  if (n > FONT_SCALE_MAX) return FONT_SCALE_MAX;
  return Math.round(n * 100) / 100;
}

/** Clamp `ackTimeoutMs` to [1s, 5min]. Default 60s on non-finite / out-of-band. */
export function clampAckTimeoutMs(n: number): number {
  if (!Number.isFinite(n)) return 60_000;
  if (n < AGENT_ACK_TIMEOUT_MS_MIN) return AGENT_ACK_TIMEOUT_MS_MIN;
  if (n > AGENT_ACK_TIMEOUT_MS_MAX) return AGENT_ACK_TIMEOUT_MS_MAX;
  return Math.floor(n);
}

/** Clamp `maxConcurrent` to [1, 50]. Default 5 on non-finite / out-of-band. */
export function clampMaxConcurrent(n: number): number {
  if (!Number.isFinite(n)) return 5;
  if (n < AGENT_MAX_CONCURRENT_MIN) return AGENT_MAX_CONCURRENT_MIN;
  if (n > AGENT_MAX_CONCURRENT_MAX) return AGENT_MAX_CONCURRENT_MAX;
  return Math.floor(n);
}

/** Normalize a stored JSONL retention value. Accepts the literal `'never'`
 *  to opt out (returned as-is) or a positive integer (days, clamped to
 *  [1, 3650]). Anything else (NaN, negative, non-number-non-'never')
 *  falls back to 30. */
export function normalizeJsonlRetention(v: unknown): number | 'never' {
  if (v === 'never') return 'never';
  if (typeof v !== 'number' || !Number.isFinite(v)) return 30;
  if (v < JSONL_RETENTION_DAYS_MIN) return JSONL_RETENTION_DAYS_MIN;
  if (v > JSONL_RETENTION_DAYS_MAX) return JSONL_RETENTION_DAYS_MAX;
  return Math.floor(v);
}

export function normalizeOrchestratorSurfacePreference(
  value: unknown,
  fallback: OrchestratorSurfacePreference = 'chat',
): OrchestratorSurfacePreference {
  return value === 'terminal' || value === 'chat' ? value : fallback;
}

/**
 * Backfill any fields a stored envelope is missing — old `settings_global`
 * rows predate the Q10 envelope. Mutates a shallow copy so the row at rest
 * stays untouched until the next PATCH.
 */
export function withSettingsDefaults(
  stored: Partial<GlobalSettings>,
  dataDir: string,
  homeDir: string,
): GlobalSettings {
  const defaults = defaultGlobalSettings(dataDir, homeDir);
  return {
    dataDir: stored.dataDir ?? defaults.dataDir,
    telemetryOptIn: stored.telemetryOptIn ?? defaults.telemetryOptIn,
    claudeExe: stored.claudeExe ?? defaults.claudeExe,
    claudeConfigDir: stored.claudeConfigDir ?? defaults.claudeConfigDir,
    onboardingCompletedAt: stored.onboardingCompletedAt ?? defaults.onboardingCompletedAt,
    defaultOrchestratorSurface: normalizeOrchestratorSurfacePreference(
      (stored as { defaultOrchestratorSurface?: unknown }).defaultOrchestratorSurface,
      defaults.defaultOrchestratorSurface,
    ),
    projectsFolder: stored.projectsFolder ?? defaults.projectsFolder,
    activityPanel: {
      open: stored.activityPanel?.open ?? defaults.activityPanel.open,
      showAllProjects:
        stored.activityPanel?.showAllProjects ?? defaults.activityPanel.showAllProjects,
    },
    bugLogTargetProjectId: stored.bugLogTargetProjectId ?? defaults.bugLogTargetProjectId,
    fontScale: clampFontScale(stored.fontScale ?? defaults.fontScale),
    agentDispatch: {
      ackTimeoutMs: clampAckTimeoutMs(
        stored.agentDispatch?.ackTimeoutMs ?? defaults.agentDispatch.ackTimeoutMs,
      ),
      maxConcurrent: clampMaxConcurrent(
        stored.agentDispatch?.maxConcurrent ?? defaults.agentDispatch.maxConcurrent,
      ),
    },
    hideCancelledStage: stored.hideCancelledStage ?? defaults.hideCancelledStage,
    remoteControlEnabled: stored.remoteControlEnabled ?? defaults.remoteControlEnabled,
    showCommandSpace: stored.showCommandSpace ?? defaults.showCommandSpace,
    fonts: normalizeFontSettings((stored as { fonts?: unknown }).fonts ?? defaults.fonts),
    jsonl: {
      retentionDays: normalizeJsonlRetention(
        stored.jsonl?.retentionDays ?? defaults.jsonl.retentionDays,
      ),
    },
  };
}

function joinPath(a: string, b: string): string {
  if (!a) return b;
  const trimmed = a.replace(/[\\/]+$/, '');
  const sep = trimmed.includes('\\') ? '\\' : '/';
  return `${trimmed}${sep}${b}`;
}
