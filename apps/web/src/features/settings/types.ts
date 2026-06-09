import type { ULID } from '@/features/projects/types';
import {
  FONT_KEYS,
  MONO_FONT_KEYS,
  type FontGroup,
  type FontKey,
  type FontSettings,
} from '@pc/domain';

// Re-export so the rest of the web app can import from one place.
export type { FontGroup, FontKey, FontSettings };
export { FONT_KEYS, MONO_FONT_KEYS };

export interface ActivityPanelSettings {
  open: boolean;
  showAllProjects: boolean;
}

export interface AgentDispatchSettings {
  ackTimeoutMs: number;
  maxConcurrent: number;
}

export interface JsonlSettings {
  retentionDays: number | 'never';
}

export type OrchestratorSurfacePreference = 'chat' | 'terminal';

export interface GlobalSettings {
  dataDir: string;
  telemetryOptIn: boolean;
  claudeExe: string | null;
  claudeConfigDir: string | null;
  defaultOrchestratorSurface: OrchestratorSurfacePreference;
  projectsFolder: string;
  activityPanel: ActivityPanelSettings;
  bugLogTargetProjectId: ULID | null;
  fontScale: number;
  agentDispatch: AgentDispatchSettings;
  jsonl: JsonlSettings;
  hideCancelledStage: boolean;
  remoteControlEnabled: boolean;
  showCommandSpace: boolean;
  onboardingCompletedAt: string | null;
  fonts: FontSettings;
}

export const FONT_SCALE_MIN = 0.85;
export const FONT_SCALE_MAX = 1.5;
export const FONT_SCALE_STEP = 0.05;

export interface ClaudePreflight {
  status: 'ok' | 'not-found' | 'version-too-old' | 'unverified';
  path: string | null;
  source: string;
  version: string | null;
  minVersion: string;
  /** FD-22 — the exact version Caisson is tested against. */
  pinnedVersion: string;
  /** true = installed version IS the pin; false = mismatch; null = unreadable. */
  pinnedMatch: boolean | null;
}

export interface DependencyProbe {
  name: string;
  present: boolean;
  version: string | null;
  severity: 'hard' | 'soft';
  note?: string;
}

export interface AuthProbe {
  status: 'unknown' | 'authed' | 'login-required';
  note: string;
}

export interface PreflightReport {
  claude: ClaudePreflight;
  auth: AuthProbe;
  git: DependencyProbe;
  soft: DependencyProbe[];
  ok: boolean;
}

export type LoginMode = 'callback' | 'code-paste' | 'unknown';

export interface OnboardingLoginState {
  running: boolean;
  url: string | null;
  mode: LoginMode;
  planFailure: boolean;
  planFailureNote: string | null;
  exited: boolean;
  exitCode: number | null;
  tail: string;
}

export interface OnboardingAuthState {
  login: OnboardingLoginState;
  authed: boolean;
  auth: AuthProbe;
}
