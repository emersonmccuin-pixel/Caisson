// Boot-time seed for Claude Code's first-run config flags.
//
// On a fresh machine, CC shows an interactive theme-picker + "press enter"
// dialog (gated by `hasCompletedOnboarding` in its global config JSON) before
// it will accept any prompt. Caisson spawns claude headlessly, so that dialog
// stalls every chat/agent turn indefinitely.
//
// This module MERGES the three keys CC checks into whatever config file the
// spawned claude process will actually read — determined by CC's own two-step
// `getGlobalClaudeFile()` resolution (src/utils/env.ts, verified 2026-06-09):
//
//   claudeConfigHomeDir = CLAUDE_CONFIG_DIR ?? ~/.claude
//   if (claudeConfigHomeDir/.config.json exists)  → legacy path (used on Macs
//     with any pre-existing CC install; CLAUDE_CONFIG_DIR skipped here)
//   else → (CLAUDE_CONFIG_DIR || homedir())/.claude.json
//
// On macOS any prior CC install leaves ~/.claude/.config.json, so that file
// is what CC reads even though it's not the obvious "new" path. Seeding
// ~/.claude.json instead means the onboarding gate is never cleared and the
// interactive theme dialog still fires. The updated resolveClaudeJsonPath()
// below mirrors this two-step check exactly.
//
// MERGE rules — existing keys are preserved (the file holds oauthAccount,
// projects, tipsHistory, etc.); we only SET the three keys when absent or
// stale, never wipe anything. Write is atomic (temp-file rename).
//
// Idempotent: calling multiple times is safe and cheap (read → no change needed
// → skip write).

import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** CC theme value that avoids the interactive picker. 'dark' is CC's own
 *  default fallback in its theme resolution chain. */
const DEFAULT_THEME = 'dark';

/** How long to wait for `claude --version` before giving up. We never block
 *  boot on this — the outer try/catch makes the whole seed non-fatal. */
const VERSION_TIMEOUT_MS = 8_000;

export interface FirstRunSeedResult {
  /** Absolute path of the config file that was targeted. */
  configPath: string;
  /** true = file was written (created or patched). false = already complete. */
  written: boolean;
  /** CC version string used for `lastOnboardingVersion`, or null if lookup failed. */
  claudeVersion: string | null;
}

/** Resolve the config file path that CC will actually read, mirroring CC's
 *  two-step `getGlobalClaudeFile()` (src/utils/env.ts, verified 2026-06-09):
 *
 *   1. claudeConfigHomeDir = CLAUDE_CONFIG_DIR ?? ~/.claude
 *   2. If claudeConfigHomeDir/.config.json exists → legacy path (pre-dates the
 *      .claude.json name; present on any Mac with a prior CC install)
 *   3. Otherwise → (CLAUDE_CONFIG_DIR || homedir())/.claude.json
 *
 *  Called at seed time so it picks up whatever `process.env.CLAUDE_CONFIG_DIR`
 *  is after `applyClaudeRuntimeSettings` has run. */
export function resolveClaudeJsonPath(): string {
  const claudeConfigHomeDir =
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const legacyPath = join(claudeConfigHomeDir, '.config.json');
  if (existsSync(legacyPath)) {
    return legacyPath;
  }
  // Production fileSuffixForOauthConfig() returns '' → filename is '.claude.json'.
  return join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json');
}

/** Ask CC itself for its version string (`claude --version`).
 *  Returns null on any failure — the seed stays safe without it. */
export async function readClaudeVersion(
  claudeExe = 'claude',
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(claudeExe, ['--version'], {
      timeout: VERSION_TIMEOUT_MS,
      windowsHide: true,
    });
    // CC prints e.g. "2.1.168 (Claude Code)" — extract the semver token.
    const match = stdout.trim().match(/^(\d+\.\d+\.\d+)/);
    return match ? match[1]! : stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Read the current `.claude.json` at `path`. Returns an empty object when the
 *  file is absent; returns `{}` (fresh start) when the file is corrupt / not
 *  JSON so we never crash on a malformed config. */
function readConfigSafe(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const text = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Write `data` to `path` atomically (write temp → rename).
 *  Creates parent directories as needed. */
function writeConfigAtomic(path: string, data: Record<string, unknown>): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.seed-tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
}

/** Synchronously ensure the two keys CC's onboarding gate actually checks —
 *  `hasCompletedOnboarding` AND `theme` (CC shows onboarding when EITHER is
 *  absent) — are present in the config file CC will read. NO awaits: a
 *  fire-and-forget caller still completes the write before the first claude
 *  spawn. Merge-only, idempotent, corrupt-safe.
 *
 *  `lastOnboardingVersion` is deliberately NOT touched here — it is not part of
 *  CC's onboarding gate, so it must never gate or delay this write. (The old
 *  async path awaited `claude --version` BEFORE writing; on a fresh macOS
 *  launch the bundled binary's first run is slow enough that the first chat
 *  beat the write and hit the theme picker.) */
export function seedClaudeFirstRunSync(): FirstRunSeedResult {
  const configPath = resolveClaudeJsonPath();
  const config = readConfigSafe(configPath);
  const existingVersion =
    typeof config['lastOnboardingVersion'] === 'string'
      ? (config['lastOnboardingVersion'] as string)
      : null;

  const gateSatisfied =
    config['hasCompletedOnboarding'] === true &&
    typeof config['theme'] === 'string';

  if (gateSatisfied) {
    return { configPath, written: false, claudeVersion: existingVersion };
  }

  const next: Record<string, unknown> = { ...config };
  next['hasCompletedOnboarding'] = true;
  if (typeof next['theme'] !== 'string') next['theme'] = DEFAULT_THEME;

  writeConfigAtomic(configPath, next);
  return { configPath, written: true, claudeVersion: existingVersion };
}

/** Seed the CC first-run config: write the onboarding-gate keys synchronously
 *  (the part that matters), then best-effort stamp `lastOnboardingVersion` from
 *  `claude --version`. The version stamp never blocks or reverts the gate keys.
 *
 *  `claudeExe` is optional — defaults to 'claude', which respects PATH + the
 *  app-bundled override set by `setBundledClaudeExe`. Pass
 *  `resolveClaudeBinary().path ?? 'claude'` for production use. */
export async function seedClaudeFirstRun(
  claudeExe = 'claude',
): Promise<FirstRunSeedResult> {
  const gate = seedClaudeFirstRunSync();
  const claudeVersion = await readClaudeVersion(claudeExe);

  if (claudeVersion !== null) {
    const config = readConfigSafe(gate.configPath);
    if (config['lastOnboardingVersion'] !== claudeVersion) {
      writeConfigAtomic(gate.configPath, {
        ...config,
        lastOnboardingVersion: claudeVersion,
      });
    }
  }

  return {
    configPath: gate.configPath,
    written: gate.written,
    claudeVersion: claudeVersion ?? gate.claudeVersion,
  };
}
