// Section 10 Phase 2 — onboarding install actions.
//
// Drives the OFFICIAL installers for PC's hard dependencies, hands-off, on an
// explicit user click in the first-run wizard. Never auto-runs. Each action
// re-runs preflight afterward so the wizard can advance.
//
//   - Claude Code: the official `irm https://claude.ai/install.ps1 | iex`
//     (Windows) / `curl -fsSL https://claude.ai/install.sh | bash` one-liners.
//     Installs to ~/.local/bin — which the resolver's homedir candidate finds.
//   - git: winget-first (`Git.Git`) on Windows, falling back to the official
//     Git-for-Windows installer; Homebrew-first on macOS, falling back to
//     Apple's Command Line Tools installer prompt.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { clearClaudeProbeCache } from '@pc/runtime';

import {
  PINNED_CLAUDE_VERSION,
  resolveGitBinary,
  runPreflight,
  type PreflightReport,
} from './preflight.ts';

const execFileAsync = promisify(execFile);

/** Installers can take a few minutes (download + compile/extract). */
const INSTALL_TIMEOUT_MS = 6 * 60 * 1000;
const BREW_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

export interface InstallResult {
  preflight: PreflightReport;
  log: string;
}

/** Run a command, folding stdout+stderr into one log blob. On failure, throw
 *  with the captured output (installers put the useful message there). */
async function run(cmd: string, args: string[], timeoutMs = INSTALL_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return `${stdout ?? ''}${stderr ?? ''}`.trim();
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    throw new Error(out || err.message || `${cmd} failed`);
  }
}

export async function installClaude(platform: NodeJS.Platform = process.platform): Promise<InstallResult> {
  // FD-22 — install exactly the pinned, tested version, never "latest". The
  // official scripts take a version target (they run `claude install <target>`
  // under the hood).
  let log: string;
  if (platform === 'win32') {
    log = await run('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `& ([scriptblock]::Create((irm https://claude.ai/install.ps1))) ${PINNED_CLAUDE_VERSION}`,
    ]);
  } else {
    log = await run('/bin/bash', [
      '-c',
      `/usr/bin/curl -fsSL https://claude.ai/install.sh | /bin/bash -s ${PINNED_CLAUDE_VERSION}`,
    ]);
  }
  // The installer may have added claude to PATH; drop the memoized probe so the
  // post-install preflight re-resolves (the homedir candidate already re-checks
  // ~/.local/bin every call, but a PATH install needs the cache cleared).
  clearClaudeProbeCache();
  const preflight = await runPreflight();
  return { preflight, log: log || 'Installer finished.' };
}

export async function installGit(platform: NodeJS.Platform = process.platform): Promise<InstallResult> {
  let log: string;
  if (platform === 'win32') {
    try {
      log = await run('winget', [
        'install',
        '--id',
        'Git.Git',
        '-e',
        '--silent',
        '--accept-source-agreements',
        '--accept-package-agreements',
      ]);
    } catch (e) {
      log = `winget unavailable or failed (${(e as Error).message}).\nFalling back to the official Git-for-Windows installer.\n`;
      log += await installGitViaOfficialInstaller();
    }
  } else if (platform === 'darwin') {
    log = await installGitOnMac();
  } else {
    throw new Error(
      'Automatic git install is supported on Windows and macOS only for now. Install git via your package manager.',
    );
  }
  const preflight = await runPreflight();
  return { preflight, log: log || 'git install finished.' };
}

/** Write the user's global git commit identity (`git config --global`) on an
 *  explicit wizard action, so a non-technical user never has to open a
 *  terminal. Re-runs preflight afterward so the wizard can advance. */
export async function configureGitIdentity(name: string, email: string): Promise<InstallResult> {
  const cleanName = name.trim();
  const cleanEmail = email.trim();
  if (!cleanName) throw new Error('name is required');
  // Light-touch sanity check — git itself accepts nearly anything; this only
  // catches obvious slips (no @, embedded whitespace).
  if (!/^\S+@\S+$/.test(cleanEmail)) {
    throw new Error('email must look like you@example.com');
  }
  const git = await resolveGitBinary();
  if (!git) throw new Error('git is not installed yet — install it first.');
  await run(git, ['config', '--global', 'user.name', cleanName], 30_000);
  await run(git, ['config', '--global', 'user.email', cleanEmail], 30_000);
  const preflight = await runPreflight();
  return { preflight, log: `Saved git identity: ${cleanName} <${cleanEmail}>` };
}

async function installGitOnMac(): Promise<string> {
  const existing = await firstWorkingCommand([
    ['git', ['--version']],
    ['/usr/bin/git', ['--version']],
    ['/opt/homebrew/bin/git', ['--version']],
    ['/usr/local/bin/git', ['--version']],
  ]);
  if (existing) return `${existing} is already available.`;

  const brew = await findBrew();
  if (brew) {
    const out = await run(brew, ['install', 'git'], BREW_INSTALL_TIMEOUT_MS);
    return `Installed git with Homebrew (${brew}).\n${out}`;
  }

  try {
    const out = await run('/usr/bin/xcode-select', ['--install'], 60_000);
    return [
      "Opened Apple's Command Line Tools installer for git.",
      'Finish the system installer, then use Re-check in Caisson.',
      out,
    ].filter(Boolean).join('\n');
  } catch (e) {
    const message = (e as Error).message;
    if (/already installed|install requested|in progress/i.test(message)) {
      return [
        "Apple's Command Line Tools installer is already installed or in progress.",
        'Finish the system installer, then use Re-check in Caisson.',
        message,
      ].join('\n');
    }
    throw new Error(
      `Homebrew was not found and Apple's Command Line Tools installer could not be opened: ${message}`,
    );
  }
}

async function findBrew(): Promise<string | null> {
  for (const candidate of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    if (!existsSync(candidate)) continue;
    try {
      await run(candidate, ['--version'], 10_000);
      return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  try {
    await run('brew', ['--version'], 10_000);
    return 'brew';
  } catch {
    return null;
  }
}

async function firstWorkingCommand(commands: Array<[string, string[]]>): Promise<string | null> {
  for (const [cmd, args] of commands) {
    try {
      const out = await run(cmd, args, 10_000);
      return out || cmd;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/** Fallback when winget is absent: fetch the latest 64-bit Git-for-Windows
 *  installer from GitHub releases and run it silently. */
async function installGitViaOfficialInstaller(): Promise<string> {
  const headers = { 'User-Agent': 'caisson-onboarding', Accept: 'application/vnd.github+json' };
  const rel = await fetch('https://api.github.com/repos/git-for-windows/git/releases/latest', {
    headers,
  });
  if (!rel.ok) throw new Error(`GitHub release lookup failed: ${rel.status}`);
  const data = (await rel.json()) as {
    assets?: { name: string; browser_download_url: string }[];
  };
  const asset = data.assets?.find((a) => /Git-.*-64-bit\.exe$/.test(a.name));
  if (!asset) throw new Error('No 64-bit Git-for-Windows installer found in the latest release.');

  const dl = await fetch(asset.browser_download_url, {
    headers: { 'User-Agent': 'caisson-onboarding' },
  });
  if (!dl.ok) throw new Error(`Installer download failed: ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  const tmp = join(tmpdir(), asset.name);
  await writeFile(tmp, buf);

  const out = await run(tmp, ['/VERYSILENT', '/NORESTART', '/SP-', '/SUPPRESSMSGBOXES']);
  return `Downloaded ${asset.name}; ran silent install.\n${out}`;
}
