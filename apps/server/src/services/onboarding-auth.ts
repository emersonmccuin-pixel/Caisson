// Section 10 Phase 2 — onboarding sign-in drive.
//
// Runs Claude Code's OWN `claude auth login` command on the user's behalf. CC
// runs its own OAuth flow, opens the system browser, and writes its own
// credential file (~/.claude/.credentials.json). Caisson never sees, mints, or
// stores a token — this is byte-for-byte the same sign-in a user does from a
// terminal, just spawned by the wizard instead of typed. No API, no `-p`.
//
// Primary path: browser-callback OAuth (CC opens the browser; wizard polls
// `claude auth status` until success). No code paste needed.
//
// Fallback path: when CC prints an OAuth URL but the browser callback doesn't
// complete (code-paste mode), the wizard surfaces the URL as a button AND
// accepts the authorization code in the UI, which is piped to the login child's
// stdin via submitCode(). The manual path must never be a dead end.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import { requireClaudeBinary } from '@pc/runtime';

export type LoginMode = 'callback' | 'code-paste' | 'unknown';

export interface LoginState {
  /** A login process is currently running. */
  running: boolean;
  /** The OAuth URL CC printed (fallback if the browser didn't auto-open). */
  url: string | null;
  /** Detected interaction mode. */
  mode: LoginMode;
  /** True when CC output indicates the account lacks a Pro/Max/Team plan. */
  planFailure: boolean;
  /** Short plain-English explanation when planFailure is true. */
  planFailureNote: string | null;
  /** The login process exited. */
  exited: boolean;
  /** Exit code (0 = "Login successful"). */
  exitCode: number | null;
  /** Last slice of captured output for diagnostics. */
  tail: string;
}

let proc: ChildProcess | null = null;
let captured = '';
let url: string | null = null;
let mode: LoginMode = 'unknown';
let planFailure = false;
let planFailureNote: string | null = null;
let exitCode: number | null = null;

// CC prints "If the browser didn't open, visit: <url>"; also catch a bare
// oauth/authorize URL defensively.
const VISIT_RE = /visit:\s*(https?:\/\/\S+)/i;
const OAUTH_RE = /(https?:\/\/\S*(?:oauth|authorize)\S*)/i;

// Code-paste mode: CC asks the user to paste an authorization code to stdin.
const CODE_PASTE_RE =
  /(?:paste|enter|type|provide)\s+(?:your\s+)?(?:authorization\s+)?code|authorization\s+code\s*:/i;

// Plan-failure patterns: subscription required.
const PLAN_FAILURE_RE =
  /(?:not\s+subscribed|no\s+active\s+subscription|does\s+not\s+have\s+access|requires?\s+(?:a\s+)?(?:paid|pro|max|team)|Claude\s+(?:Pro|Max|Team)\s+(?:plan|subscription)|subscription\s+required)/i;

function ingest(chunk: string): void {
  captured += chunk;
  if (captured.length > 16_000) captured = captured.slice(-16_000);

  if (!url) {
    const m = VISIT_RE.exec(captured) ?? OAUTH_RE.exec(captured);
    if (m) {
      url = m[1]!.trim();
      // A localhost-callback URL means CC is handling the OAuth locally;
      // the user just finishes in the browser. Any other URL = code-paste.
      const isLocalCallback = /localhost|127\.0\.0\.1/.test(url);
      if (mode === 'unknown') {
        mode = isLocalCallback ? 'callback' : 'code-paste';
      }
    }
  }

  // If CC explicitly prompts for a code, override mode regardless.
  if (mode !== 'code-paste' && CODE_PASTE_RE.test(chunk)) {
    mode = 'code-paste';
  }

  // Detect plan-level auth failure.
  if (!planFailure && PLAN_FAILURE_RE.test(captured)) {
    planFailure = true;
    planFailureNote =
      'Caisson needs a Claude Pro, Max, or Team plan (or API access). ' +
      'Set one up at claude.ai, then try signing in again.';
  }
}

/** Which sign-in flow to drive. */
export type LoginMethod = 'browser' | 'code';

/** Start (or no-op if already running) a Claude sign-in.
 *  - 'browser' (default): `claude auth login --claudeai` — CC's OAuth with a
 *    localhost browser-callback round-trip.
 *  - 'code': `claude setup-token` — the headless paste-a-code flow. CC prints
 *    an authorize URL and reads the resulting code/token from stdin, with NO
 *    localhost callback. This is the escape for environments where the
 *    browser→localhost redirect fails (pc-pty-chat-338). */
export function startLogin(method: LoginMethod = 'browser'): LoginState {
  if (proc) return getLoginState();
  captured = '';
  url = null;
  // Seed the code flow's mode so the UI shows the paste box immediately,
  // independent of how setup-token formats its URL output.
  mode = method === 'code' ? 'code-paste' : 'unknown';
  planFailure = false;
  planFailureNote = null;
  exitCode = null;
  const bin = requireClaudeBinary();
  // browser: `--claudeai` = Claude subscription (the default; explicit).
  // code: `setup-token` reads the pasted code/token from stdin. Both keep
  // stdio piped so submitCode() can deliver the code.
  const args = method === 'code' ? ['setup-token'] : ['auth', 'login', '--claudeai'];
  const child = spawn(bin, args, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc = child;
  child.stdout?.on('data', (b: Buffer) => ingest(b.toString()));
  child.stderr?.on('data', (b: Buffer) => ingest(b.toString()));
  child.on('exit', (code) => {
    exitCode = code;
    proc = null;
  });
  child.on('error', () => {
    exitCode = -1;
    proc = null;
  });
  return getLoginState();
}

export function getLoginState(): LoginState {
  return {
    running: proc !== null,
    url,
    mode,
    planFailure,
    planFailureNote,
    exited: proc === null && exitCode !== null,
    exitCode,
    tail: captured.slice(-500),
  };
}

/**
 * Write the authorization code to the login child's stdin.
 * Used when CC enters code-paste mode: the user pastes the code from claude.ai
 * into the onboarding UI, which sends it here, which forwards it to the child.
 */
export function submitCode(code: string): void {
  if (!proc?.stdin?.writable) return;
  proc.stdin.write(`${code.trim()}\n`);
}

/** Kill an in-flight login (e.g. the user closed the wizard / cancelled). */
export function cancelLogin(): void {
  if (proc) {
    proc.kill();
    proc = null;
  }
}
