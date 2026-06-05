// Section 10 Phase 0 — preflight.
//
// A structured report of whether PC's runtime dependencies are present and
// usable on THIS machine. Surfaced at GET /api/preflight. The Phase-2
// onboarding wizard reads it to decide what to install/drive; today's app can
// show it in a diagnostics view. Every failure is a typed state, never a raw
// spawn error.
//
// PC is a launcher for Claude Code, so the hard dependencies are:
//   - claude  (the binary PC spawns for every chat/agent/workflow turn)
//   - git     (project creation + agent-worktree isolation)
// Soft dependencies (only workflow code-nodes need them):
//   - node / bash / python

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveClaudeBinary, type ClaudeBinarySource } from '@pc/runtime';

const execFileAsync = promisify(execFile);

/** Minimum Claude Code version PC supports. v2 introduced the banner + flag
 *  behaviors PC's spawn machinery depends on (cursor-right banner rendering,
 *  folder-trust prompt, `--agent` replace semantics, dev-channel flag).
 *  Anything below 2.0.0 breaks those assumptions. */
export const MIN_CLAUDE_VERSION = '2.0.0';

/** FD-22 — the ONE exact Claude Code version PC is tested against. Bump
 *  deliberately, only after verifying a new version against PC's quirk surface
 *  (banner rendering, queue protocol, transcript format, the FD-2 spike
 *  harness — all have broken under us before). The installer installs exactly
 *  this; a mismatch is a loud warning, never a hard wall (dev machines may run
 *  ahead on purpose). Keep in lockstep with stage-claude.mjs + the onboarding
 *  wizard (they drifted 160/160/163 before 0.2.0 — now all 2.1.165). */
export const PINNED_CLAUDE_VERSION = '2.1.165';

const PROBE_TIMEOUT_MS = 10_000;

export interface ClaudePreflight {
  /** ok = found + version ≥ gate. unverified = found but `--version` couldn't
   *  be read/parsed. */
  status: 'ok' | 'not-found' | 'version-too-old' | 'unverified';
  path: string | null;
  source: ClaudeBinarySource | 'not-found';
  version: string | null;
  minVersion: string;
  /** FD-22 — the exact version PC is tested against. */
  pinnedVersion: string;
  /** true = installed version IS the pin; false = mismatch (warn, don't wall);
   *  null = version unreadable. */
  pinnedMatch: boolean | null;
}

export interface AuthPreflight {
  /** Phase 2 probes auth via Claude Code's OWN `claude auth status` command —
   *  a local token-state read (no network, no model call, no billing) that
   *  exits 0 when signed in. `unknown` = claude present but status unreadable
   *  (e.g. an older CC without the subcommand). */
  status: 'authed' | 'login-required' | 'unknown';
  note: string;
}

export interface DependencyProbe {
  name: string;
  present: boolean;
  version: string | null;
  /** hard = PC can't function without it; soft = only some features need it. */
  severity: 'hard' | 'soft';
  note?: string;
}

export interface PreflightReport {
  claude: ClaudePreflight;
  auth: AuthPreflight;
  /** git is a HARD dep — project create + agent worktrees shell out to it. */
  git: DependencyProbe;
  /** node / bash / python — SOFT deps (workflow code-nodes only). */
  soft: DependencyProbe[];
  /** All hard deps satisfied and claude version acceptable. */
  ok: boolean;
}

/** Extract the first dotted numeric version token from a `--version` blob.
 *  "2.1.150 (Claude Code)" → "2.1.150"; "git version 2.51.0.windows.2" →
 *  "2.51.0.windows.2" trimmed to its numeric prefix → "2.51.0". */
function parseVersion(out: string): string | null {
  const m = out.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

/** Numeric semver-ish compare on the first three dotted segments.
 *  Returns -1 / 0 / 1 for a < / == / > b. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10));
  const pb = b.split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Run `<bin> --version` (or a custom args list). Returns the raw stdout+stderr
 *  on success, or null if the binary isn't runnable. CC/git/node print to
 *  stdout; we fold in stderr defensively. */
async function runVersion(bin: string, args: string[] = ['--version']): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const out = `${stdout ?? ''}${stderr ?? ''}`.trim();
    return out || null;
  } catch {
    return null;
  }
}

async function checkClaude(): Promise<ClaudePreflight> {
  const res = resolveClaudeBinary();
  if (!res.path) {
    return {
      status: 'not-found',
      path: null,
      source: 'not-found',
      version: null,
      minVersion: MIN_CLAUDE_VERSION,
      pinnedVersion: PINNED_CLAUDE_VERSION,
      pinnedMatch: null,
    };
  }
  const raw = await runVersion(res.path);
  const version = raw ? parseVersion(raw) : null;
  let status: ClaudePreflight['status'];
  if (!version) {
    // Resolver found a path but `--version` failed or was unparseable — the
    // file exists but may be broken / not actually Claude.
    status = 'unverified';
  } else if (compareVersions(version, MIN_CLAUDE_VERSION) < 0) {
    status = 'version-too-old';
  } else {
    status = 'ok';
  }
  return {
    status,
    path: res.path,
    source: res.source,
    version,
    minVersion: MIN_CLAUDE_VERSION,
    pinnedVersion: PINNED_CLAUDE_VERSION,
    pinnedMatch: version ? compareVersions(version, PINNED_CLAUDE_VERSION) === 0 : null,
  };
}

/** Probe sign-in via `claude auth status`. CC prints JSON ({ loggedIn, ... })
 *  and exits 0 when signed in / 1 when not — the JSON is on stdout either way.
 *  This is a LOCAL read of CC's own token state: no API call, no `-p`, no
 *  billing. The same command a user runs to check their login. */
async function checkAuth(claudePath: string | null): Promise<AuthPreflight> {
  if (!claudePath) {
    return { status: 'login-required', note: 'Claude Code is not installed yet.' };
  }
  let raw = '';
  try {
    const { stdout } = await execFileAsync(claudePath, ['auth', 'status', '--json'], {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    raw = stdout ?? '';
  } catch (e) {
    // Exit 1 (not signed in) lands here; the JSON is still on stdout.
    raw = (e as { stdout?: string }).stdout ?? '';
  }
  try {
    const parsed = JSON.parse(raw) as { loggedIn?: boolean };
    return parsed.loggedIn
      ? { status: 'authed', note: 'Signed in to Claude.' }
      : { status: 'login-required', note: 'Not signed in yet.' };
  } catch {
    return { status: 'unknown', note: 'Could not read sign-in status.' };
  }
}

/** Standalone auth probe for the onboarding login poll (resolves the binary +
 *  checks). Avoids re-running the full preflight on every 2s poll. */
export async function probeAuth(): Promise<AuthPreflight> {
  return checkAuth(resolveClaudeBinary().path);
}

async function probeBinary(
  name: string,
  severity: 'hard' | 'soft',
  candidates: string[] = [name],
  note?: string,
): Promise<DependencyProbe> {
  for (const bin of candidates) {
    const raw = await runVersion(bin);
    if (raw !== null) {
      return { name, present: true, version: parseVersion(raw), severity, note };
    }
  }
  return { name, present: false, version: null, severity, note };
}

function gitCandidates(): string[] {
  if (process.platform !== 'darwin') return ['git'];
  return ['git', '/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'];
}

function nodeCandidates(): string[] {
  if (process.platform !== 'darwin') return ['node'];
  return ['node', '/opt/homebrew/bin/node', '/usr/local/bin/node'];
}

function bashCandidates(): string[] {
  if (process.platform !== 'darwin') return ['bash'];
  return ['bash', '/bin/bash', '/opt/homebrew/bin/bash', '/usr/local/bin/bash'];
}

function pythonCandidates(): string[] {
  if (process.platform !== 'darwin') return ['python', 'python3'];
  return ['python', 'python3', '/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'];
}

export async function runPreflight(): Promise<PreflightReport> {
  const claude = await checkClaude();
  const [auth, git, node, bash, python] = await Promise.all([
    checkAuth(claude.path),
    probeBinary('git', 'hard', gitCandidates(), 'Required for project creation + agent worktrees.'),
    probeBinary('node', 'soft', nodeCandidates(), 'Workflow code-nodes only.'),
    probeBinary('bash', 'soft', bashCandidates(), 'Workflow code-nodes only.'),
    probeBinary('python', 'soft', pythonCandidates(), 'Workflow code-nodes only.'),
  ]);

  const ok = claude.status === 'ok' && git.present;

  return { claude, auth, git, soft: [node, bash, python], ok };
}
