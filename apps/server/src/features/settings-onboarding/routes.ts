import { homedir } from 'node:os';

import type { Hono } from 'hono';
import type { GlobalSettings } from '@pc/domain';
import {
  normalizeOrchestratorSurfacePreference,
  normalizeFontSettings,
  resolveClaudeConfigDirEnv,
  withSettingsDefaults,
} from '@pc/domain';
import {
  claudeConfigDir,
  setConfiguredClaudeExe,
} from '@pc/runtime';
import {
  getGlobalSettings,
  setGlobalSettings,
} from '@pc/db';
import { getDataDir } from '@pc/utils';

import {
  probeAuth as defaultProbeAuth,
  runPreflight as defaultRunPreflight,
} from '../../services/preflight.ts';
import { seedClaudeFirstRunSync } from '../../services/claude-firstrun-seed.ts';
import {
  configureGitIdentity as defaultConfigureGitIdentity,
  installClaude as defaultInstallClaude,
  installGit as defaultInstallGit,
} from '../../services/onboarding-install.ts';
import {
  cancelLogin as defaultCancelLogin,
  getLoginState as defaultGetLoginState,
  startLogin as defaultStartLogin,
  submitCode as defaultSubmitCode,
} from '../../services/onboarding-auth.ts';

export const SHELL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;

export interface SettingsOnboardingRouteDeps {
  runPreflight?: typeof defaultRunPreflight;
  probeAuth?: typeof defaultProbeAuth;
  installClaude?: typeof defaultInstallClaude;
  installGit?: typeof defaultInstallGit;
  configureGitIdentity?: typeof defaultConfigureGitIdentity;
  startLogin?: typeof defaultStartLogin;
  getLoginState?: typeof defaultGetLoginState;
  cancelLogin?: typeof defaultCancelLogin;
  submitCode?: typeof defaultSubmitCode;
  /** FD-15 — called after a PATCH persists, with the merged settings. The
   *  server uses this to push live config (e.g. agent concurrency cap) to the
   *  agent host. Fire-and-forget; must not block the response. */
  onSettingsApplied?: (settings: GlobalSettings) => void;
}

export function readSettings(): GlobalSettings {
  const stored = getGlobalSettings();
  const merged = withSettingsDefaults(stored ?? {}, getDataDir(), homedir());
  return { ...merged, dataDir: getDataDir() };
}

export function applyClaudeConfigDirOverride(override: string | null): void {
  const next = resolveClaudeConfigDirEnv(override, SHELL_CLAUDE_CONFIG_DIR);
  if (next === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = next;
}

export function applyClaudeRuntimeSettings(
  settings: Pick<GlobalSettings, 'claudeExe' | 'claudeConfigDir'>,
): void {
  setConfiguredClaudeExe(settings.claudeExe);
  applyClaudeConfigDirOverride(settings.claudeConfigDir);
  // Re-seed CC's onboarding-gate keys for whatever config dir is NOW
  // effective. Runs at boot AND on every settings change — a claudeConfigDir
  // override pointed at a fresh profile must never resurrect the interactive
  // theme-picker (it stalls every spawned chat). Sync + idempotent + cheap.
  try {
    const seeded = seedClaudeFirstRunSync();
    if (seeded.written) {
      console.log(`[pc] claude-firstrun-seed(sync): wrote ${seeded.configPath}`);
    }
  } catch (err) {
    console.warn(`[pc] claude-firstrun-seed(sync) failed: ${(err as Error).message}`);
  }
}

function mergeSettingsPatch(body: Partial<GlobalSettings>, current: GlobalSettings): GlobalSettings {
  return withSettingsDefaults(
    {
      dataDir: getDataDir(),
      telemetryOptIn:
        typeof body.telemetryOptIn === 'boolean' ? body.telemetryOptIn : current.telemetryOptIn,
      claudeExe:
        body.claudeExe === undefined
          ? current.claudeExe
          : typeof body.claudeExe === 'string' && body.claudeExe.trim()
            ? body.claudeExe.trim()
            : null,
      claudeConfigDir:
        body.claudeConfigDir === undefined
          ? current.claudeConfigDir
          : typeof body.claudeConfigDir === 'string' && body.claudeConfigDir.trim()
            ? body.claudeConfigDir.trim()
            : null,
      onboardingCompletedAt:
        body.onboardingCompletedAt === undefined
          ? current.onboardingCompletedAt
          : typeof body.onboardingCompletedAt === 'string' && body.onboardingCompletedAt.trim()
            ? body.onboardingCompletedAt.trim()
            : null,
      defaultOrchestratorSurface: normalizeOrchestratorSurfacePreference(
        (body as { defaultOrchestratorSurface?: unknown }).defaultOrchestratorSurface,
        current.defaultOrchestratorSurface,
      ),
      projectsFolder:
        typeof body.projectsFolder === 'string' && body.projectsFolder.trim()
          ? body.projectsFolder.trim()
          : current.projectsFolder,
      activityPanel: {
        open: body.activityPanel?.open ?? current.activityPanel.open,
        showAllProjects:
          body.activityPanel?.showAllProjects ?? current.activityPanel.showAllProjects,
      },
      bugLogTargetProjectId:
        body.bugLogTargetProjectId === undefined
          ? current.bugLogTargetProjectId
          : body.bugLogTargetProjectId,
      fontScale:
        typeof body.fontScale === 'number' ? body.fontScale : current.fontScale,
      agentDispatch: {
        ackTimeoutMs:
          typeof body.agentDispatch?.ackTimeoutMs === 'number'
            ? body.agentDispatch.ackTimeoutMs
            : current.agentDispatch.ackTimeoutMs,
        maxConcurrent:
          typeof body.agentDispatch?.maxConcurrent === 'number'
            ? body.agentDispatch.maxConcurrent
            : current.agentDispatch.maxConcurrent,
      },
      jsonl: {
        retentionDays:
          body.jsonl?.retentionDays === 'never' ||
          typeof body.jsonl?.retentionDays === 'number'
            ? body.jsonl.retentionDays
            : current.jsonl.retentionDays,
      },
      hideCancelledStage:
        typeof body.hideCancelledStage === 'boolean'
          ? body.hideCancelledStage
          : current.hideCancelledStage,
      remoteControlEnabled:
        typeof body.remoteControlEnabled === 'boolean'
          ? body.remoteControlEnabled
          : current.remoteControlEnabled,
      showCommandSpace:
        typeof body.showCommandSpace === 'boolean'
          ? body.showCommandSpace
          : current.showCommandSpace,
      commandIntroDismissed:
        typeof body.commandIntroDismissed === 'boolean'
          ? body.commandIntroDismissed
          : current.commandIntroDismissed,
      fonts: normalizeFontSettings(
        body.fonts !== undefined && typeof body.fonts === 'object' && body.fonts !== null
          ? body.fonts
          : current.fonts,
      ),
    },
    getDataDir(),
    homedir(),
  );
}

export function registerSettingsOnboardingRoutes(
  app: Hono,
  deps: SettingsOnboardingRouteDeps = {},
): void {
  const services = {
    runPreflight: deps.runPreflight ?? defaultRunPreflight,
    probeAuth: deps.probeAuth ?? defaultProbeAuth,
    installClaude: deps.installClaude ?? defaultInstallClaude,
    installGit: deps.installGit ?? defaultInstallGit,
    configureGitIdentity: deps.configureGitIdentity ?? defaultConfigureGitIdentity,
    startLogin: deps.startLogin ?? defaultStartLogin,
    getLoginState: deps.getLoginState ?? defaultGetLoginState,
    cancelLogin: deps.cancelLogin ?? defaultCancelLogin,
    submitCode: deps.submitCode ?? defaultSubmitCode,
  };

  app.get('/api/settings', (c) => {
    return c.json({ ok: true, settings: readSettings() });
  });

  app.patch('/api/settings', async (c) => {
    const body = await c.req
      .json<Partial<GlobalSettings>>()
      .catch((): Partial<GlobalSettings> => ({}));
    const current = readSettings();
    const merged = mergeSettingsPatch(body, current);
    setGlobalSettings(merged);
    applyClaudeRuntimeSettings(merged);
    deps.onSettingsApplied?.(merged);
    const restartRequired = merged.dataDir !== current.dataDir;
    return c.json({ ok: true, settings: merged, restartRequired });
  });

  app.get('/api/settings/claude-profile', (c) => {
    const override = readSettings().claudeConfigDir;
    return c.json({
      ok: true,
      override,
      effective: claudeConfigDir(),
      source: override ? 'override' : SHELL_CLAUDE_CONFIG_DIR ? 'shell' : 'default',
    });
  });

  app.get('/api/preflight', async (c) => {
    const preflight = await services.runPreflight();
    return c.json({ ok: true, preflight });
  });

  app.post('/api/onboarding/install/claude', async (c) => {
    try {
      const r = await services.installClaude();
      return c.json({ ok: true, ...r });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  app.post('/api/onboarding/install/git', async (c) => {
    try {
      const r = await services.installGit();
      return c.json({ ok: true, ...r });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  // Write the global git commit identity on the wizard's behalf (two text
  // fields instead of two terminal commands for a non-technical user).
  app.post('/api/onboarding/git-identity', async (c) => {
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = typeof raw['name'] === 'string' ? raw['name'] : '';
    const email = typeof raw['email'] === 'string' ? raw['email'] : '';
    try {
      const r = await services.configureGitIdentity(name, email);
      return c.json({ ok: true, ...r });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 400);
    }
  });

  app.post('/api/onboarding/auth/login', async (c) => {
    try {
      const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const method = raw['method'] === 'code' ? 'code' : 'browser';
      return c.json({ ok: true, login: services.startLogin(method) });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  app.get('/api/onboarding/auth/state', async (c) => {
    const auth = await services.probeAuth();
    return c.json({
      ok: true,
      login: services.getLoginState(),
      authed: auth.status === 'authed',
      auth,
    });
  });

  app.post('/api/onboarding/auth/cancel', (c) => {
    services.cancelLogin();
    return c.json({ ok: true });
  });

  // Submit the authorization code from the UI to the login child's stdin.
  // Used when `claude auth login` enters code-paste mode (browser callback not
  // available): the user copies the code from claude.ai, types it here, and we
  // pipe it to the login process so it can complete.
  app.post('/api/onboarding/auth/code', async (c) => {
    const raw = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const code = typeof raw['code'] === 'string' ? raw['code'].trim() : '';
    if (!code) {
      return c.json({ ok: false, error: 'code is required' }, 400);
    }
    services.submitCode(code);
    return c.json({ ok: true, login: services.getLoginState() });
  });
}
