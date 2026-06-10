// LowLevelSpawn — the foundation spawn primitive for the agent system rebuild.
//
// Every claude.exe spawn in PC goes through this one piece. Wraps node-pty
// with the subagent ready gate, bracketed-paste + echo-ack send, env
// scrub, deterministic JSONL path resolution, and a single observability
// contract.
//
// Scope: just the spawn. The lifecycle state machine (AgentRun — ONE primitive,
// policy flags per north-star §4) lives one layer above this. Delivery /
// tailer / persistence services sit in the server.
//
// Construction discipline: no synchronous emit during construction. The
// constructor returns the object; callers attach listeners; explicit start()
// begins the lifecycle. (Section 15 lesson — JSONL tailer's synchronous
// historical-line emit in the constructor body raced caller listener attach
// for the entire resume case.)

import pty from 'node-pty';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, createWriteStream, mkdirSync, readFileSync, type WriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { JsonlTailer, type JsonlEvent, type JsonlEventMeta } from './jsonl-tailer.ts';
import { scrubIdeEnv } from './env-scrub.ts';
import { stripAnsiPreserveSpacing, collapseAnsiToWhitespace } from './ansi.ts';
import { jsonlPathFor } from './path-resolver.ts';
import { ReadyGate, type ReadyTimestamps } from './ready-gate.ts';
import { sendBracketedPaste, type SendResult } from './send-protocol.ts';
import { requireClaudeBinary } from './claude-resolver.ts';

// 60s. Init-complete variance is 1013–2391ms in a clean sandbox; under banner
// load + concurrent dispatches Windows resume can stretch to 30–35s. The
// Section 18 V-4 lesson is that `session.kill()` isn't synchronous on Windows,
// so a too-tight timeout reports `resume-failed` after the resume has actually
// succeeded. 60s is wide enough that the kill-and-fail path never races a
// late success.
const DEFAULT_READY_TIMEOUT_MS = 60_000;

// PTY spawn/kill/exit timeline. Append-only; lands beside the server crash
// artifacts (PC_DIAG_DIR is set by apps/server/src/diagnostics.ts). Lets us
// correlate a future native crash (0xC0000374 heap corruption) with node-pty
// spawn/kill churn. No-ops when PC_DIAG_DIR is unset (e.g. unit tests).
function ptyLog(event: string, detail: Record<string, unknown>): void {
  const diagDir = process.env.PC_DIAG_DIR;
  if (!diagDir) return;
  try {
    appendFileSync(
      join(diagDir, 'pty-lifecycle.log'),
      `[${new Date().toISOString()}] ${event} ${JSON.stringify(detail)}\n`,
    );
  } catch {
    /* best-effort */
  }
}

export interface PodDescriptor {
  /** Pod name passed to `--agent <name>`. Must match a materialized
   *  `.claude/agents/<name>.md` in the worktree. */
  name: string;
  /** Logical PC pod name for records/UI when `name` is a CLI/plugin alias. */
  logicalName?: string;
}

export interface LowLevelSpawnInput {
  /** Resolved pod descriptor. Caller is responsible for materializing the
   *  pod into the worktree before calling spawn (per §3.2 pre-invariant 3). */
  podDefinition: PodDescriptor;
  /** Absolute path to the bound worktree. Becomes the spawn cwd. */
  worktreePath: string;
  /** Process env. We scrub IDE-integration markers defensively even if the
   *  caller already scrubbed. */
  env: Record<string, string | undefined>;
  /** Optional post-scrub env overrides. Used by the live terminal surface to
   *  advertise xterm color support without reintroducing IDE integration env. */
  envOverrides?: Record<string, string | undefined>;
  /** UUID. Caller mints up-front; we pass via --session-id (fresh) or
   *  --resume (resume). CC writes JSONL at the deterministic path. */
  ccProviderSessionId: string;
  mode: 'fresh' | 'resume';
  /** Pre-resolved CC JSONL path. Orchestrator resumes pass the persisted path
   *  so CLAUDE_CONFIG_DIR changes in the host process cannot retarget replay. */
  jsonlPath?: string;
  /** Initial source JSONL line cursor. When omitted, resume mode skips the
   *  existing file tail and fresh mode starts at 0. */
  jsonlStartLine?: number;
  /** First user turn body — pasted via bracketed paste + echo-ack after the
   *  ready gate opens. Fresh only; never used on resume (resume continues
   *  the in-progress conversation). */
  initialInput?: string;
  /** Override path to the rewritten `.mcp.json`. Defaults to `.mcp.json`
   *  relative to the worktree. The MCP bundle handoff (Section 20.A) means
   *  this file's `command` field must point at the bundled
   *  `packages/mcp/dist/server.mjs`, not `npx -y tsx`. */
  mcpConfigPath?: string;
  /** Absolute path to PC's session-local Claude settings file. */
  settingsPath?: string;
  /** Passed to `--setting-sources`. PC uses `''` to disable user/project/local
   *  setting discovery while still loading explicit `--settings`. */
  settingSources?: string;
  /** Session-local Claude plugin dirs. Used to mount PC agent definitions
   *  without writing `<worktree>/.claude/agents`. */
  pluginDirs?: readonly string[];
  /** Per-spawn override of the claude binary path. Omit to let
   *  `requireClaudeBinary` resolve (config → CLAUDE_EXE → PATH → ~/.local/bin). */
  claudeExe?: string;
  /** Optional model override. Orchestrator passes opus; workers may omit and
   *  inherit Claude's/default pod behavior. */
  model?: string;
  /** Enables Claude's remote-control phone bridge/banner. */
  remoteControl?: boolean;
  /** Require a stable Claude composer-ready UI marker in addition to
   *  bracketed-paste/handshake signals. Used by the main orchestrator chat
   *  without depending on the remote-control phone bridge. */
  requireReadySignal?: boolean;
  /** Optional handshake timeout. Default 60s. */
  handshakeTimeoutMs?: number;
  /** Main resume spawns can load historical Claude sessions that do not honor
   *  the current dev-channel MCP config. In that case remote-control composer
   *  readiness is enough to accept typed sends. Default true. */
  requireMcpHandshake?: boolean;
  /** Optional ready timeout. Default 60s. */
  readyTimeoutMs?: number;
  /** Optional forensic transcript file. Raw bytes append. The wrapper
   *  decides where (agent-runs/<id>/transcript.log for dispatched,
   *  sessions/<id>/transcript.log for interactive). */
  transcriptPath?: string;
  /** PTY dimensions. Defaults match production (120x30). */
  cols?: number;
  rows?: number;
  /** Skip the internal JSONL tailer. Set by the out-of-process agent host,
   *  where the API server tails the canonical JSONL from disk itself — so the
   *  host's own tailer would be a redundant second fs watch on the same file.
   *  (Default false — in-process callers keep the tailer.) */
  suppressJsonlTailer?: boolean;
}

export type SpawnState = 'spawning' | 'ready' | 'running' | 'exited';

export interface SpawnEvents {
  /** Raw stdout chunks (ANSI-stripped with cursor-forward preserved as
   *  spaces — see ansi.ts). xterm-side render, debug logs. */
  chunk: (text: string) => void;
  /** Untouched raw bytes for the forensic transcript. */
  raw: (bytes: string) => void;
  /** State transitions only. NOT lifecycle state (wrapper's responsibility). */
  state: (s: SpawnState) => void;
  /** Parsed JSONL event from CC's on-disk session file plus source cursor. */
  'jsonl-event': (ev: JsonlEvent, meta?: JsonlEventMeta) => void;
  /** Fires once when the configured ready-gate signals are in. */
  ready: (ts: ReadyTimestamps) => void;
  /** PTY exit. */
  exit: (code: number | null, signal: number | null) => void;
}

/**
 * One PTY spawn = one claude.exe child = one LowLevelSpawn instance.
 *
 * Lifecycle:
 *   1. `new LowLevelSpawn(input)` — constructor stores config; does NOT spawn.
 *   2. Caller attaches listeners (`on('ready', ...)`, `on('jsonl-event', ...)`).
 *   3. `start()` — kicks off the actual pty.spawn + tailer attach. Required
 *      to begin the lifecycle. Returns void; listen on events.
 *   4. `awaitReady()` — Promise that resolves when the gate opens or rejects
 *      on timeout / exit.
 *   5. `send(body)` — bracketed-paste + echo-ack. Only callable after ready.
 *   6. `kill()` — graceful Ctrl-C then SIGKILL after a grace window.
 */
export class LowLevelSpawn extends EventEmitter {
  private child: pty.IPty | null = null;
  private state: SpawnState = 'spawning';
  private rawBuffer = '';
  private trustConfirmSent = false;
  private resumeSummaryConfirmSent = false;
  private onboardingThemeSent = false;
  private onboardingSecuritySent = false;
  private bypassPermissionsConfirmSent = false;
  private readonly input: LowLevelSpawnInput;
  private readonly gate: ReadyGate;
  private tailer: JsonlTailer | null = null;
  private jsonlPollTimer: NodeJS.Timeout | null = null;
  private transcriptStream: WriteStream | null = null;
  /** Resolved at start(). Stored so callers can introspect post-spawn. */
  private resolvedJsonlPath: string | null = null;
  private readyPromise: Promise<ReadyTimestamps>;
  private readyResolve: ((ts: ReadyTimestamps) => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private started = false;
  /** Epoch-ms of the last PTY output chunk. Powers `awaitOutputQuiet`. */
  private lastChunkAt = 0;

  constructor(input: LowLevelSpawnInput) {
    super();
    this.input = input;
    // Subagents must not use Claude remote-control; they are disposable worker
    // sessions. Their ready gate uses the banner-independent signals only.
    this.gate = new ReadyGate({
      requireHandshake: input.requireMcpHandshake ?? true,
      requireInitComplete: input.requireReadySignal ?? input.remoteControl ?? false,
    });
    this.gate.on('ready', (ts) => this.handleGateOpen(ts));
    this.gate.on('aborted', (reason: string) => this.handleGateAbort(reason));

    this.readyPromise = new Promise<ReadyTimestamps>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // Prevent unhandled rejection if the run is killed before awaitReady() is
    // ever called (e.g. agent-host restart kills an in-flight session whose
    // caller hasn't reached the await yet). The caller's try/catch handles the
    // real error path; this just suppresses the process-crashing side-effect.
    this.readyPromise.catch(() => {});
  }

  /** Begin the lifecycle. Spawns the pty child. Must be called exactly once. */
  start(): void {
    if (this.started) throw new Error('LowLevelSpawn: start() called twice');
    this.started = true;

    const claudeExe = requireClaudeBinary(this.input.claudeExe);
    const mcpConfigPath = this.input.mcpConfigPath ?? '.mcp.json';

    this.resolvedJsonlPath =
      this.input.jsonlPath ??
      jsonlPathFor(this.input.worktreePath, this.input.ccProviderSessionId);

    if (this.input.transcriptPath) {
      mkdirSync(dirname(this.input.transcriptPath), { recursive: true });
      this.transcriptStream = createWriteStream(this.input.transcriptPath, {
        flags: 'a',
      });
    }

    const args = buildLowLevelSpawnArgs(this.input, mcpConfigPath);

    const env = scrubIdeEnv(this.input.env, this.input.envOverrides);

    this.child = pty.spawn(claudeExe, args, {
      cwd: this.input.worktreePath,
      env,
      cols: this.input.cols ?? 120,
      rows: this.input.rows ?? 30,
    });
    ptyLog('spawn', {
      pid: this.child.pid,
      mode: this.input.mode,
      pod: this.input.podDefinition.name,
    });

    this.child.onData((data) => this.onChunk(data));
    this.child.onExit(({ exitCode, signal }) =>
      this.onExit(exitCode ?? null, signal ?? null),
    );

    this.readyTimer = setTimeout(() => {
      this.gate.abort('ready-timeout');
    }, this.input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);

    // Defer tailer attach so callers' listeners are wired before historical
    // events fire (Section 15 lesson — replicated for safety even though the
    // JSONL file rarely exists this early on a fresh dispatch). Skipped when the
    // caller (the out-of-process host) tails the canonical JSONL elsewhere.
    if (!this.input.suppressJsonlTailer) {
      setImmediate(() => this.attachJsonlTailer());
    }
  }

  /** Called by the HTTP route at /api/internal/mcp-handshake when the
   *  spawned agent's pc-rig MCP child completes its initialization. */
  notifyMcpHandshake(): void {
    this.gate.notifyHandshake();
  }

  /** Resolves with the three ready timestamps once the gate opens, or
   *  rejects with a timeout / exit error. Idempotent — same promise on
   *  every call. */
  awaitReady(): Promise<ReadyTimestamps> {
    return this.readyPromise;
  }

  /** Bracketed-paste + echo-ack send. Only callable after the gate has
   *  opened (caller should `await awaitReady()` first). Returns a status
   *  describing whether the echo landed before the timeout. */
  async send(body: string, echoTimeoutMs?: number): Promise<SendResult> {
    if (!this.child) throw new Error('LowLevelSpawn: send before start');
    if (this.state === 'exited') return 'exited';
    if (!this.gate.isOpen()) {
      throw new Error(
        'LowLevelSpawn: send before ready gate opened — await awaitReady() first',
      );
    }
    const result = await sendBracketedPaste(
      {
        write: (bytes) => this.child!.write(bytes),
        getRawBuffer: () => this.rawBuffer,
        isExited: () => this.state === 'exited',
      },
      body,
      echoTimeoutMs,
    );
    if (result === 'ok') this.setState('running');
    return result;
  }

  /** M7 live-fire fix ([[resume-needs-quiet-window]]) — resolve once the PTY
   *  output stream has been quiet for `quietMs`. CC discards composer input
   *  typed while it is still repainting (lab-isolated 2026-05-22: interactive
   *  `--resume` needs ≥1500ms stdout quiet before input registers); callers
   *  gate a resume send on this. Resolves `true` on quiet, `false` when
   *  `maxWaitMs` elapses first (caller decides whether to send anyway) or the
   *  PTY exits. */
  async awaitOutputQuiet(quietMs: number, maxWaitMs: number): Promise<boolean> {
    const startedAt = Date.now();
    // Treat "no output yet" as quiet-from-spawn.
    if (this.lastChunkAt === 0) this.lastChunkAt = startedAt;
    for (;;) {
      if (this.state === 'exited') return false;
      const sinceChunk = Date.now() - this.lastChunkAt;
      if (sinceChunk >= quietMs) return true;
      if (Date.now() - startedAt >= maxWaitMs) return false;
      await new Promise<void>((r) => setTimeout(r, Math.min(100, quietMs - sinceChunk)));
    }
  }

  /** Raw terminal input for xterm-style interactive use. This deliberately
   *  avoids the chat send protocol: no bracketed paste wrapper, no echo ack,
   *  no ready/busy state transition, and no prompt history accounting. */
  writeRaw(bytes: string): boolean {
    if (!this.child || this.state === 'exited') return false;
    try {
      this.child.write(bytes);
      return true;
    } catch {
      return false;
    }
  }

  /** Graceful interrupt — Escape is CC's stop-streaming key in interactive
   *  mode (Ctrl-C only triggers "Press Ctrl-C again to exit"). */
  interrupt(): void {
    if (!this.child || this.state === 'exited') return;
    this.child.write('\x1b');
  }

  resize(cols: number, rows: number): void {
    if (!this.child || this.state === 'exited') return;
    try {
      this.child.resize(cols, rows);
    } catch {
      /* already dead */
    }
  }

  /** Kill the child. Sends Ctrl-C first, then SIGKILL after a grace window
   *  so CC's SessionEnd hook has time to fire its final JSONL write. */
  kill(graceMs = 500): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    if (this.jsonlPollTimer) {
      clearTimeout(this.jsonlPollTimer);
      this.jsonlPollTimer = null;
    }
    if (this.tailer) {
      this.tailer.stop();
      this.tailer = null;
    }
    if (this.transcriptStream) {
      this.transcriptStream.end();
      this.transcriptStream = null;
    }
    if (!this.child || this.state === 'exited') {
      this.gate.abort('killed');
      this.setState('exited');
      return;
    }
    ptyLog('kill', { pid: this.child.pid, pod: this.input.podDefinition.name });
    try {
      this.child.write('\x03');
      setTimeout(() => {
        try {
          this.child?.kill();
        } catch {
          /* already dead */
        }
      }, graceMs);
    } catch {
      /* already dead */
    }
  }

  getState(): SpawnState {
    return this.state;
  }

  getJsonlPath(): string | null {
    return this.resolvedJsonlPath;
  }

  /** PTY child pid, or null before start() / after a failed spawn. Used by the
   *  out-of-process host's roster + reattach bookkeeping. */
  getPid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Test-only / wrapper-only — exposes the raw buffer for diagnostics.
   *  Production code should rely on `chunk` / `jsonl-event` instead. */
  getRawBuffer(): string {
    return this.rawBuffer;
  }

  // -- internals ------------------------------------------------------

  private onChunk(data: string): void {
    this.lastChunkAt = Date.now();
    this.rawBuffer += data;
    if (this.transcriptStream) {
      try {
        this.transcriptStream.write(data);
      } catch {
        /* transcript best-effort */
      }
    }
    this.emit('raw', data);
    this.emit('chunk', stripAnsiPreserveSpacing(data));

    // Auto-confirm CC's "Quick safety check / Is this a project you trust?"
    // prompt that fires on first spawn into an untrusted worktree. Same
    // regex set as production pty-session.ts:288. Idempotent.
    if (!this.trustConfirmSent) {
      const cleanAll = collapseAnsiToWhitespace(this.rawBuffer);
      if (
        /Quick\s*safety\s*check/i.test(cleanAll) ||
        /Is\s*this\s*a\s*project\s*you\s*created/i.test(cleanAll) ||
        /Yes,\s*I\s*trust\s*this\s*folder/i.test(cleanAll)
      ) {
        this.trustConfirmSent = true;
        try {
          this.child?.write('\r');
        } catch {
          /* exited mid-press */
        }
      }
    }

    // ☠ FD-3: the dev-channels confirmation auto-press is gone — PC no
    // longer passes the dev-channels flag, so the prompt never appears.

    // Auto-confirm CC's resume-cost dialog ("This session is …d …h old … —
    // Resuming the full session will consume a substantial portion of your
    // usage limits. We recommend resuming from a summary."). Option 1 (Resume
    // from summary) is pre-selected, so a bare Enter takes the recommended,
    // cheaper path. Without this, the dialog is terminal-only and the chat
    // window stalls behind it on every resume of a large/old session — and
    // the ready gate eventually fail-closes it as a false "no output" hang.
    // Match a whitespace-stripped buffer: CC can split letters within a word
    // with cursor-right escapes (same quirk the ready gate guards against).
    if (!this.resumeSummaryConfirmSent && looksLikeResumeSummaryDialog(this.rawBuffer)) {
      this.resumeSummaryConfirmSent = true;
      try {
        this.child?.write('\r');
      } catch {
        /* exited mid-press */
      }
    }

    // Auto-confirm CC's onboarding theme-picker dialog. Fires when
    // `hasCompletedOnboarding` was absent/false in the config CC actually read
    // (defense-in-depth: seedClaudeFirstRun should have cleared this, but the
    // legacy ~/.claude/.config.json path on macOS can be missed). Theme picker
    // is the first onboarding step; a bare Enter selects the pre-highlighted
    // option (CC defaults to "Dark mode"). Idempotent.
    // CC source: src/components/Onboarding.tsx + src/components/ThemePicker.tsx
    if (!this.onboardingThemeSent && looksLikeOnboardingThemePicker(this.rawBuffer)) {
      this.onboardingThemeSent = true;
      try {
        this.child?.write('\r');
      } catch {
        /* exited mid-press */
      }
    }

    // Auto-confirm CC's onboarding security-notes step ("Press Enter to
    // continue…"). Appears after the theme picker. A bare Enter advances past
    // it. CC source: src/components/Onboarding.tsx (securityStep) +
    // src/components/PressEnterToContinue.tsx
    if (!this.onboardingSecuritySent && looksLikeOnboardingSecurityStep(this.rawBuffer)) {
      this.onboardingSecuritySent = true;
      try {
        this.child?.write('\r');
      } catch {
        /* exited mid-press */
      }
    }

    // Auto-accept CC's bypass-permissions WARNING dialog (CC ≥2.1.170; spawns
    // with --dangerously-skip-permissions hit it when the accepted flag is
    // absent). "No, exit" is PRE-selected, so a bare Enter kills the session —
    // press DOWN to "Yes, I accept" first. Defense-in-depth: the session
    // settings template seeds skipDangerousModePermissionPrompt, so this
    // should never fire for a PC-rendered settings file; it covers spawns
    // whose --settings input omits the flag. (PR #4, Courtney Fohrman.)
    // CC source: src/components/BypassPermissionsModeDialog.tsx +
    // interactiveHelpers.tsx showSetupScreens (verified 2026-06-10).
    if (
      !this.bypassPermissionsConfirmSent &&
      looksLikeBypassPermissionsDialog(this.rawBuffer)
    ) {
      this.bypassPermissionsConfirmSent = true;
      try {
        this.child?.write('\x1b[B\r');
      } catch {
        /* exited mid-press */
      }
    }

    this.gate.feedChunk(data);
  }

  private onExit(code: number | null, signal: number | null): void {
    ptyLog('exit', { code, signal, pod: this.input.podDefinition.name });
    this.setState('exited');
    this.gate.abort('exited-before-ready');
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    if (this.tailer) {
      // Tailer may still have buffered lines worth emitting; let it drain
      // before we stop it.
      this.tailer.stop();
      this.tailer = null;
    }
    if (this.transcriptStream) {
      this.transcriptStream.end();
      this.transcriptStream = null;
    }
    this.emit('exit', code, signal);
  }

  private handleGateOpen(ts: ReadyTimestamps): void {
    if (this.state === 'exited') return;
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    this.setState('ready');
    this.emit('ready', ts);
    this.readyResolve?.(ts);
    this.readyResolve = null;
    this.readyReject = null;
  }

  private handleGateAbort(reason: string): void {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    if (this.readyReject) {
      this.readyReject(new Error(`LowLevelSpawn: ready gate aborted (${reason})`));
      this.readyResolve = null;
      this.readyReject = null;
    }
  }

  private setState(next: SpawnState): void {
    if (this.state === next) return;
    this.state = next;
    this.emit('state', next);
  }

  /** Poll the deterministic JSONL path for first-existence then attach the
   *  tailer. CC mints the file lazily — fresh dispatches typically see it
   *  appear ~1-2s after the first user turn.
   *
   *  Resume mode: skip past existing lines so the tailer only emits events
   *  from CC's new appends. Without this guard, the prior conversation's
   *  assistant turn-ends replay as fresh `kind: 'jsonl-turn-end'` events and
   *  race the wrapper's `running` listener into completing the run before
   *  the resumed agent's actual answer arrives. (Same root cause +
   *  same fix as Section 21's v1-side `e5b9b53`.) */
  private attachJsonlTailer(): void {
    if (this.state === 'exited') return;
    const path = this.resolvedJsonlPath;
    if (!path) return;

    const tryAttach = () => {
      if (this.tailer || this.state === 'exited') return;
      if (existsSync(path)) {
        let startLine = 0;
        if (this.input.jsonlStartLine !== undefined) {
          startLine = this.input.jsonlStartLine;
        } else if (this.input.mode === 'resume') {
          try {
            const existing = readFileSync(path, 'utf-8');
            startLine = existing.split('\n').filter(Boolean).length;
          } catch {
            // Best-effort. Falling back to 0 inherits the replay bug on this
            // run but doesn't hard-fail; surfaces as a premature complete()
            // that the user can re-dispatch around.
            startLine = 0;
          }
        }
        this.tailer = new JsonlTailer({ filePath: path, startLine });
        this.tailer.on('event', (ev: JsonlEvent, meta?: JsonlEventMeta) =>
          this.emit('jsonl-event', ev, meta),
        );
        this.tailer.start();
        return;
      }
      this.jsonlPollTimer = setTimeout(tryAttach, 250);
    };
    tryAttach();
  }
}

/** True when the raw PTY buffer is showing CC's resume-cost dialog ("Resuming
 *  the full session will consume … We recommend resuming from a summary.").
 *  Option 1 (Resume from summary) is pre-selected, so the caller answers with
 *  a bare Enter. Pure so the string-match survives CC's letter-splitting
 *  terminal quirk under test rather than only in production. */
export function looksLikeResumeSummaryDialog(rawBuffer: string): boolean {
  const compact = collapseAnsiToWhitespace(rawBuffer)
    .replace(/\s+/g, '')
    .toLowerCase();
  return (
    compact.includes('resumefromsummary') ||
    compact.includes('resumingthefullsession')
  );
}

/** True when the raw PTY buffer is showing CC's onboarding theme-picker step.
 *  The Onboarding component renders "Let's get started." + "Choose the text
 *  style that looks best with your terminal" before the theme Select list.
 *  A bare Enter selects the pre-highlighted option (CC defaults to "Dark mode").
 *  Pure function so the match is testable in isolation.
 *  CC source: src/components/Onboarding.tsx + src/components/ThemePicker.tsx
 *  (verified 2026-06-09). */
export function looksLikeOnboardingThemePicker(rawBuffer: string): boolean {
  const compact = collapseAnsiToWhitespace(rawBuffer)
    .replace(/\s+/g, '')
    .toLowerCase();
  // "Let's get started." has an apostrophe that survives whitespace-stripping;
  // match must include it. "choosethetextstyle" has none.
  return (
    compact.includes("let'sgetstarted") ||
    compact.includes('choosethetextstyle')
  );
}

/** True when the raw PTY buffer is showing CC's onboarding security-notes step
 *  ("Press Enter to continue…"). A bare Enter advances past it.
 *  Pure function so the match is testable in isolation.
 *  CC source: src/components/PressEnterToContinue.tsx (verified 2026-06-09). */
export function looksLikeOnboardingSecurityStep(rawBuffer: string): boolean {
  const compact = collapseAnsiToWhitespace(rawBuffer)
    .replace(/\s+/g, '')
    .toLowerCase();
  return compact.includes('pressentertocontinue');
}

/** True when the raw PTY buffer is showing CC's bypass-permissions WARNING
 *  dialog ("WARNING: Claude Code running in Bypass Permissions mode" with a
 *  "No, exit" / "Yes, I accept" Select). Requires BOTH the title and the
 *  accept option so ordinary chat mentioning bypass permissions can't trip it.
 *  Pure function so the match is testable in isolation.
 *  CC source: src/components/BypassPermissionsModeDialog.tsx (verified 2026-06-10). */
export function looksLikeBypassPermissionsDialog(rawBuffer: string): boolean {
  const compact = collapseAnsiToWhitespace(rawBuffer)
    .replace(/\s+/g, '')
    .toLowerCase();
  return (
    compact.includes('bypasspermissionsmode') && compact.includes('yes,iaccept')
  );
}

export function buildLowLevelSpawnArgs(
  input: LowLevelSpawnInput,
  mcpConfigPath = input.mcpConfigPath ?? '.mcp.json',
): string[] {
  const args: string[] = [
    // Without this CC prompts before every tool call, blocking end_turn.
    // Lab scenario 08 surfaced this. Production sets it for every dispatched
    // agent and the orchestrator equivalent.
    '--dangerously-skip-permissions',
    // Pod's tool allowlist + prompt fully replace CC's coding-assistant
    // default (Section 16a). Always set, never omitted.
    '--agent',
    input.podDefinition.name,
    // Scope MCP to ONLY the supplied config. Caller is responsible for
    // ensuring this file points at the bundled MCP server (Section 20.A).
    '--mcp-config',
    mcpConfigPath,
    '--strict-mcp-config',
  ];
  if (input.model) {
    args.push('--model', input.model);
  }
  if (input.remoteControl) {
    args.push('--remote-control');
  }
  if (input.settingsPath) {
    args.push('--settings', input.settingsPath);
  }
  if (input.settingSources !== undefined) {
    args.push('--setting-sources', input.settingSources);
  }
  for (const pluginDir of input.pluginDirs ?? []) {
    args.push('--plugin-dir', pluginDir);
  }

  if (input.mode === 'fresh') {
    args.push('--session-id', input.ccProviderSessionId);
  } else {
    args.push('--resume', input.ccProviderSessionId);
  }

  // ☠ FD-3: no dev-channels flag — the mailbox is the one notify door.
  return args;
}
