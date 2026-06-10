import { getJson, postJson, postJsonMethod } from '@/api/http';
import type {
  GlobalSettings,
  OnboardingAuthState,
  OnboardingLoginState,
  PreflightReport,
} from './types';

export * from './types';

export const settingsApi = {
  getSettings: () =>
    getJson<{ ok: true; settings: GlobalSettings }>('/api/settings').then((r) => r.settings),

  getPreflight: () =>
    getJson<{ ok: true; preflight: PreflightReport }>('/api/preflight').then((r) => r.preflight),

  installClaude: () =>
    postJson<{ ok: true; preflight: PreflightReport; log: string }>(
      '/api/onboarding/install/claude',
      {},
    ),

  installGit: () =>
    postJson<{ ok: true; preflight: PreflightReport; log: string }>(
      '/api/onboarding/install/git',
      {},
    ),

  configureGitIdentity: (name: string, email: string) =>
    postJson<{ ok: true; preflight: PreflightReport; log: string }>(
      '/api/onboarding/git-identity',
      { name, email },
    ),

  startOnboardingLogin: (method: 'browser' | 'code' = 'browser') =>
    postJson<{ ok: true; login: OnboardingLoginState }>('/api/onboarding/auth/login', { method }),

  getOnboardingAuthState: () =>
    getJson<{ ok: true } & OnboardingAuthState>(
      '/api/onboarding/auth/state',
    ),

  cancelOnboardingLogin: () =>
    postJson<{ ok: true }>('/api/onboarding/auth/cancel', {}),

  submitOnboardingCode: (code: string) =>
    postJson<{ ok: true; login: OnboardingLoginState }>('/api/onboarding/auth/code', { code }),

  getMcpStatus: (projectId?: string) =>
    getJson<{ alive: boolean; toolCount: number; tools: string[] }>(
      projectId
        ? `/api/mcp-status?projectId=${encodeURIComponent(projectId)}`
        : '/api/mcp-status',
    ),

  patchSettings: (patch: Partial<GlobalSettings>) =>
    postJsonMethod<{ ok: true; settings: GlobalSettings; restartRequired: boolean }>(
      '/api/settings',
      patch,
      'PATCH',
    ),

  getClaudeProfile: () =>
    getJson<{
      ok: true;
      override: string | null;
      effective: string;
      source: 'override' | 'shell' | 'default';
    }>('/api/settings/claude-profile'),
};
