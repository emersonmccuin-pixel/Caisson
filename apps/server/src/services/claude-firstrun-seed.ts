// Boot-time seed for Claude Code's first-run config flags.
//
// On a fresh machine, CC shows an interactive theme-picker + "press enter"
// dialog (gated by `hasCompletedOnboarding` in its global config JSON) before
// it will accept any prompt. Caisson spawns claude headlessly, so that dialog
// stalls every chat/agent turn indefinitely.
//
// This module MERGES the three keys CC checks into whatever `.claude.json` the
// spawned claude process will actually read — determined by
// `(process.env.CLAUDE_CONFIG_DIR || homedir()) + '/.claude.json'`, which is
// EXACTLY what CC source computes:
//   `sn.join(process.env.CLAUDE_CONFIG_DIR || Hp.homedir(), ".claude.json")`
// (verified in CC 2.1.168 extension.js). When CLAUDE_CONFIG_DIR is unset the
// file lives at `~/.claude.json` (home root, NOT inside `~/.claude/`).
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

/** Resolve the `.claude.json` path CC will read, matching CC's own logic:
 *  `(CLAUDE_CONFIG_DIR || homedir()) + '/.claude.json'`
 *  Called at seed time so it picks up whatever `process.env.CLAUDE_CONFIG_DIR`
 *  is after `applyClaudeRuntimeSettings` has run. */
export function resolveClaudeJsonPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || homedir();
  return join(dir, '.claude.json');
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

/** Seed `hasCompletedOnboarding`, `theme`, and `lastOnboardingVersion` into
 *  the CC global config file without clobbering any existing keys.
 *
 *  `claudeExe` is optional — defaults to 'claude', which respects PATH +
 *  the app-bundled override set by `setBundledClaudeExe`. Pass
 *  `resolveClaudeBinary().path ?? 'claude'` for production use. */
export async function seedClaudeFirstRun(
  claudeExe = 'claude',
): Promise<FirstRunSeedResult> {
  const configPath = resolveClaudeJsonPath();
  const claudeVersion = await readClaudeVersion(claudeExe);

  const config = readConfigSafe(configPath);

  const alreadyDone =
    config['hasCompletedOnboarding'] === true &&
    typeof config['theme'] === 'string' &&
    (claudeVersion === null ||
      config['lastOnboardingVersion'] === claudeVersion);

  if (alreadyDone) {
    return { configPath, written: false, claudeVersion };
  }

  const next: Record<string, unknown> = { ...config };
  next['hasCompletedOnboarding'] = true;
  if (typeof next['theme'] !== 'string') next['theme'] = DEFAULT_THEME;
  if (claudeVersion !== null) next['lastOnboardingVersion'] = claudeVersion;

  writeConfigAtomic(configPath, next);
  return { configPath, written: true, claudeVersion };
}
