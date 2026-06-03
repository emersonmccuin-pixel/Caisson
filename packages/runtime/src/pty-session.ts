// Wraps a node-pty spawn of claude.exe.
// Patterns copied from PC-Validation/shared/scripts/drive-t11.js + drive-t15.js
// (proven on Windows ConPTY against CC v2.1.140).

import pty from 'node-pty';
import { EventEmitter } from 'node:events';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { JsonlTailer, type JsonlEvent, type JsonlEventMeta } from './jsonl-tailer.ts';
import { claudeProjectsRoot } from './path-resolver.ts';
import { requireClaudeBinary } from './claude-resolver.ts';
import { TimedBracketedPasteQueue } from './send-protocol.ts';
import { collapseAnsiToWhitespace } from './ansi.ts';

/** claude.exe v2+ detects IDE-embedded mode from env vars set by the host
 *  (VS Code, JetBrains, or a parent claude.exe). When PC spawns a child
 *  claude.exe from a parent process that has any of these set — most commonly
 *  a developer running `pnpm dev` from inside a Claude-Code-driven terminal,
 *  or any VS Code integrated terminal — the child inherits them, tries to
 *  attach to the parent's IPC channel (which doesn't exist for it), prints
 *  "Visual Studio Code disconnected", and discards the first user input.
 *  PC is the host; spawned claude.exes are tools, not peers. Scrub all
 *  IDE-integration markers from the env before pty.spawn. */
const IDE_INTEGRATION_ENV_KEYS = [
  // VS Code terminal integration
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'VSCODE_PID',
  'VSCODE_CWD',
  'VSCODE_IPC_HOOK',
  'VSCODE_IPC_HOOK_CLI',
  'VSCODE_IPC_HOOK_EXTHOST',
  'VSCODE_INJECTION',
  'VSCODE_NLS_CONFIG',
  'VSCODE_NONCE',
  'VSCODE_GIT_ASKPASS_MAIN',
  'VSCODE_GIT_ASKPASS_NODE',
  'VSCODE_GIT_ASKPASS_EXTRA_ARGS',
  'VSCODE_GIT_IPC_HANDLE',
  'GIT_ASKPASS',
  // Parent claude.exe handoff — these signal "I'm a child of another CC".
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_NO_FLICKER',
] as const;

function scrubIdeIntegrationEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (IDE_INTEGRATION_ENV_KEYS.includes(k as (typeof IDE_INTEGRATION_ENV_KEYS)[number])) continue;
    out[k] = v;
  }
  return out;
}

/** CC encodes the absolute cwd as the dir name under `~/.claude/projects/`.
 *  Replace any non-[A-Za-z0-9._-] character with '-'. Empirically verified
 *  against `C:\\Users\\example\\AppData\\Local\\Temp\\cc-stream-test` →
 *  `C--Users-example-AppData-Local-Temp-cc-stream-test` and
 *  `E:\\Projects\\Caisson\\workspace` → `E--Projects-Caisson-workspace`. */
export function encodeCwdForClaude(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9._-]/g, '-');
}

export function terminalBufferLooksReady(rawBuffer: string): boolean {
  const normalized = collapseAnsiToWhitespace(rawBuffer);
  const compact = normalized.replace(/\s+/g, '');
  return (
    /Welcome\s*back/i.test(normalized) ||
    /Tips\s*for\s*getting\s*started/i.test(normalized) ||
    /What's\s*new/i.test(normalized) ||
    /Try\s*"/i.test(normalized) ||
    /\/remote-control\s+is\s+active/i.test(normalized) ||
    /Remote\s*Control\s*active/i.test(normalized) ||
    compact.toLowerCase().includes('/remote-controlisactive') ||
    compact.toLowerCase().includes('remotecontrolactive')
  );
}

export interface PtySessionOptions {
  workspaceDir: string;
  /** Per-spawn override of the claude binary path. Omit to let
   *  `requireClaudeBinary` resolve (config → CLAUDE_EXE → PATH → ~/.local/bin). */
  claudeExe?: string;
  stopMarkerPath: string;
  eventsPath: string;
  transcriptPath: string;
  cols?: number;
  rows?: number;
  /** Claude session UUID — caller mints it (or fetches from prior row).
   *  When set, we either mint (resume=false) or resume (resume=true) the
   *  named session so chat history in the UI matches Claude's actual context. */
  claudeSessionId?: string;
  /** When true, pass `--resume <uuid>`. When false, pass `--session-id <uuid>`
   *  (mint). Ignored if `claudeSessionId` is unset. */
  resume?: boolean;
  /** Extra env vars merged into the claude.exe spawn env. Used to thread
   *  PC_SESSION_ID through so hooks can route their writes into the
   *  per-session data dir. */
  extraEnv?: Record<string, string>;
  /** Post-scrub env overrides. Used by interactive xterm surfaces to
   *  advertise terminal capabilities without reintroducing host IDE markers. */
  envOverrides?: Record<string, string>;
  /** Durable PC session id used in the normalized replay ledger. Defaults to
   *  the parent directory of `eventsPath` for transient sessions. */
  pcSessionId?: string;
  /** Root of CC's per-project session dirs. Defaults to
   *  `<homedir>/.claude/projects`. Override only for tests. */
  claudeProjectsDir?: string;
  /** Pre-resolved CC JSONL path. When set, the JSONL tailer attaches to this
   *  file immediately and skips the discovery scan. Used for `--resume` so we
   *  re-attach to the same file the prior session was writing into. */
  jsonlPath?: string;
  /** Cursor (line count) to resume the tailer from. Only used when
   *  `jsonlPath` is set. Defaults to 0. */
  jsonlStartLine?: number;
  /** JSONL paths claimed by PRIOR sessions for this project. Discovery skips
   *  any file in this set. Prevents the new tailer from latching onto an
   *  old session's JSONL when the user clicks `+ New session` while the old
   *  CC was still writing — without this guard the entire old conversation
   *  re-streams as live jsonl-* events and re-pops up in the chat panel. */
  excludeJsonlPaths?: readonly string[];
  /** Absolute path to a markdown file appended to CC's built-in system prompt
   *  via `--append-system-prompt-file`. PC uses this to mount the per-project
   *  orchestrator PM identity (Section 3 D11). When unset (or the file is
   *  missing), the flag is omitted and the orchestrator runs with CC's default
   *  system prompt only. */
  appendSystemPromptPath?: string;
  /** Agent name to load via `--agent <name>`. claude.exe reads the matching
   *  `.claude/agents/<name>.md` from the cwd. Section 4d (independent subagent
   *  execution) uses this to spawn helper sessions; interactive mode REPLACES
   *  CC's default system prompt with the agent body (source-verified
   *  utils/systemPrompt.ts:115–122). Orchestrator path does NOT set this. */
  agentName?: string;
  /** `--model` override. Defaults to `'opus'` (orchestrator-locked per
   *  chat.md). Subagents pass the agent file's declared model. */
  model?: string;
  /** Override the `--mcp-config` path. Defaults to `'.mcp.json'` (relative to
   *  cwd — the project-scaffolded pc-rig config). Section 17a.5
   *  passes a materialised pod's temp `mcp.json` here so pod-declared MCP
   *  servers merge in alongside the baseline. */
  mcpConfigPath?: string;
  /** Absolute path to PC's session-local Claude settings file. */
  settingsPath?: string;
  /** Passed to `--setting-sources`. PC uses `''` to disable user/project/local
   *  setting discovery while still loading explicit `--settings`. */
  settingSources?: string;
  /** Session-local Claude plugin dirs. Used to mount PC agent definitions
   *  without writing `<workspace>/.claude/agents`. */
  pluginDirs?: readonly string[];
  /** Enables Claude's remote-control bridge/banner. PC sets this only for the
   *  main orchestrator chat; transient modals and subagents leave it off. */
  remoteControl?: boolean;
}

export type SessionState = 'spawning' | 'ready' | 'thinking' | 'exited';

export interface JsonlReplaySource {
  kind: 'claude-jsonl';
  cursor: number | null;
}

export interface JsonlReplayMeta {
  id: string;
  sessionId: string;
  seq: number;
  kind: JsonlEvent['kind'];
  source: JsonlReplaySource;
}

function nextReplaySeqFromFile(filePath: string): number {
  try {
    const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    let validCount = 0;
    let maxSeq = 0;
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      const row = parsed as { type?: unknown; event?: unknown; seq?: unknown };
      if (row.type !== 'jsonl' || !row.event || typeof row.event !== 'object') continue;
      validCount++;
      if (typeof row.seq === 'number' && Number.isSafeInteger(row.seq) && row.seq > maxSeq) {
        maxSeq = row.seq;
      }
    }
    return Math.max(validCount, maxSeq) + 1;
  } catch {
    return 1;
  }
}

export function buildPtySessionArgs(opts: PtySessionOptions): string[] {
  const args: string[] = [
    '--dangerously-skip-permissions',
    // Orchestrator is locked to opus per chat.md locked decision.
    // Subagents pick their own model via YAML (`opts.model`).
    '--model',
    opts.model ?? 'opus',
    // Scope MCP to ONLY the supplied config (default: workspace/.mcp.json,
    // pc-rig + webhook). Without --strict-mcp-config the orchestrator merges
    // global user-level MCPs (e.g. WCP, archon) and tries to use them —
    // confusing and leaks unrelated capabilities into the rig. Section 17a.5
    // overrides this with a materialised pod's temp mcp.json.
    '--mcp-config',
    opts.mcpConfigPath ?? '.mcp.json',
    '--strict-mcp-config',
  ];
  if (opts.remoteControl) {
    // Orchestrator readiness accepts the remote-control banner as the stable
    // resume/new-session signal. Ask Claude to print it only for that chat.
    args.push('--remote-control');
  }
  if (opts.settingsPath) {
    args.push('--settings', opts.settingsPath);
  }
  if (opts.settingSources !== undefined) {
    args.push('--setting-sources', opts.settingSources);
  }
  for (const pluginDir of opts.pluginDirs ?? []) {
    args.push('--plugin-dir', pluginDir);
  }
  // Section 4d: subagent dispatches load the agent body via `--agent <name>`.
  // Interactive mode REPLACES CC's default system prompt with the agent body
  // (source-verified). Orchestrator path leaves this unset and uses
  // `--append-system-prompt-file` instead (which appends).
  if (opts.agentName) {
    args.push('--agent', opts.agentName);
  }
  // Section 3 D11: layer PC's PM identity on top of CC's built-in system
  // prompt. Skip silently if the file is missing — fresh projects always
  // have it scaffolded; pre-3c projects pick it up via the boot-time backfill
  // in ProjectRuntime.refreshHooksIfStale.
  if (opts.appendSystemPromptPath && existsSync(opts.appendSystemPromptPath)) {
    args.push('--append-system-prompt-file', opts.appendSystemPromptPath);
  }
  // Section 15: deterministic session ownership. Always pass --session-id
  // (mint) or --resume (continue) when caller supplies a UUID — caller is
  // ProjectRuntime.resolveSessionForSpawn, which guarantees the resume vs
  // mint decision is correct (resume only if a JSONL for that UUID exists
  // on disk; otherwise mint at the stored UUID).
  if (opts.claudeSessionId) {
    if (opts.resume) {
      args.push('--resume', opts.claudeSessionId);
    } else {
      args.push('--session-id', opts.claudeSessionId);
    }
  }
  // ☠ FD-3: the `--dangerously-load-development-channels` flag and its
  // boot-prompt auto-confirm are gone — the mailbox is the one notify door.
  return args;
}

/**
 * One PTY session = one claude.exe child.
 * Emits:
 *   'chunk'                (raw bytes, ANSI-stripped) — stream to UI
 *   'raw'                  (raw bytes, untouched)     — for transcript / debug
 *   'state'                (SessionState)             — UI status indicator
 *   'exit'                 (code, signal)
 *   'turn-end'             — legacy hook-derived turn marker (vestigial; will go in 0f)
 *   'event'                — legacy hook-derived structured event from events.jsonl
 *   'jsonl-event'          (JsonlEvent)               — canonical event from CC's session JSONL
 *   'jsonl-path-resolved'  (path: string)             — emitted once after discovery succeeds
 *   'jsonl-cursor-tick'    (path: string, cursor: number) — debounced cursor tick for persistence
 */
export class PtySession extends EventEmitter {
  private child: pty.IPty;
  private state: SessionState = 'spawning';
  private rawBuffer = '';
  private bannerSeen = false;
  private trustConfirmSent = false;
  private stopMarkerPath: string;
  private eventsPath: string;
  /** Section 23 — PC-owned normalized event log written by the JSONL tailer.
   *  Lives at `<sessionDataPath>/jsonl-events.jsonl`. Each line is the
   *  canonical envelope shape `{type:'jsonl', event: JsonlEvent}` matching
   *  what the live WS stream broadcasts. Replay (active session WS subscribe
   *  + Sessions tab past-replay) sources from this file. Survives CC's 30-day
   *  retention sweep (Section 18.8); CC's own session JSONL is treated as
   *  ephemeral source-of-truth-on-disk. */
  private jsonlEventsPath: string;
  private replaySessionId: string;
  private nextReplaySeq = 1;
  private lastMarkerCount = 0;
  private lastEventCount = 0;
  private workspaceDir: string;
  private claudeProjectsDir: string;
  private spawnedAt = 0;
  private excludeJsonlPaths: Set<string>;
  private tailer: JsonlTailer | null = null;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private cursorPersistTimer: NodeJS.Timeout | null = null;
  private sendQueue: TimedBracketedPasteQueue;

  constructor(opts: PtySessionOptions) {
    super();
    const claudeExe = requireClaudeBinary(opts.claudeExe);
    this.stopMarkerPath = resolve(opts.stopMarkerPath);
    this.eventsPath = resolve(opts.eventsPath);
    this.jsonlEventsPath = resolve(dirname(this.eventsPath), 'jsonl-events.jsonl');
    this.replaySessionId = opts.pcSessionId ?? basename(dirname(this.eventsPath));
    this.nextReplaySeq = nextReplaySeqFromFile(this.jsonlEventsPath);
    this.workspaceDir = opts.workspaceDir;
    // Honor CLAUDE_CONFIG_DIR (Section 15 lesson + Section 23 follow-up):
    // claude.exe writes its session JSONL under
    //   <CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<uuid>.jsonl
    // when that env var is set. Hardcoding `homedir() + '.claude'` here is
    // the latent bug that pre-23 chat hid because hooks fed the chat panel
    // regardless of where CC wrote its session log. Post-23 (JSONL is the
    // canonical chat source) the mismatch silently empties the chat.
    this.claudeProjectsDir = opts.claudeProjectsDir ?? claudeProjectsRoot();
    this.excludeJsonlPaths = new Set(
      (opts.excludeJsonlPaths ?? []).map((p) => resolve(p)),
    );
    this.sendQueue = new TimedBracketedPasteQueue({
      write: (bytes) => this.child.write(bytes),
      isExited: () => this.state === 'exited',
      onSubmitted: () => this.setState('thinking'),
    });

    mkdirSync(dirname(opts.transcriptPath), { recursive: true });
    writeFileSync(opts.transcriptPath, '');
    // Reset marker + events files so we count from zero per server start.
    mkdirSync(dirname(this.stopMarkerPath), { recursive: true });
    if (existsSync(this.stopMarkerPath)) rmSync(this.stopMarkerPath);
    writeFileSync(this.stopMarkerPath, '');
    mkdirSync(dirname(this.eventsPath), { recursive: true });
    // Don't wipe events.jsonl on respawn — chat history should survive
    // tsx watch restarts. Seed the line counter at the existing count so we
    // only emit NEW lines.
    if (!existsSync(this.eventsPath)) writeFileSync(this.eventsPath, '');
    try {
      this.lastEventCount = readFileSync(this.eventsPath, 'utf-8')
        .split('\n')
        .filter(Boolean).length;
    } catch {
      this.lastEventCount = 0;
    }
    // Section 23.5 — tasks.json went away with the hook-side accumulator;
    // todos derive client-side from JSONL tool-call envelopes.

    const args = buildPtySessionArgs(opts);
    const env = scrubIdeIntegrationEnv({
      ...process.env,
      FORCE_COLOR: '0',
      ...(opts.extraEnv ?? {}),
    });
    this.child = pty.spawn(claudeExe, args, {
      cwd: opts.workspaceDir,
      env: {
        ...env,
        ...(opts.envOverrides ?? {}),
      },
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 30,
    });

    this.child.onData((data) => {
      this.rawBuffer += data;
      try {
        writeFileSync(opts.transcriptPath, this.rawBuffer);
      } catch {
        /* transcript best-effort */
      }
      this.emit('raw', data);
      const stripped = stripAnsi(data);
      this.emit('chunk', stripped);

      // claude.exe v2.1.140+ folder-trust prompt: fires at boot for any cwd
      // not previously trusted. Renders as "Quick safety check: Is this a
      // project you created or one you trust?" with "❯ 1. Yes, I trust this
      // folder" preselected. Blocks the banner. Press Enter once to accept
      // the default. Fires for orchestrator AND subagent paths — fresh
      // project folders + subagent worktrees are both untrusted at first
      // spawn. Same `\s*` matcher rule as the dev-channels prompt to absorb
      // the cursor-right-escape rendering.
      if (!this.trustConfirmSent) {
        const cleanAll = stripAnsi(this.rawBuffer);
        if (
          /Quick\s*safety\s*check/i.test(cleanAll) ||
          /Is\s*this\s*a\s*project\s*you\s*created/i.test(cleanAll) ||
          /Yes,\s*I\s*trust\s*this\s*folder/i.test(cleanAll)
        ) {
          this.trustConfirmSent = true;
          this.child.write('\r');
        }
      }

      // ☠ FD-3: the dev-channels confirmation auto-press is gone — PC no
      // longer passes the dev-channels flag, so the prompt never appears.

      // First time we see a Claude-ready terminal signal, mark ready.
      if (!this.bannerSeen) {
        if (terminalBufferLooksReady(this.rawBuffer)) {
          this.bannerSeen = true;
          this.setState('ready');
        }
      }
    });

    this.child.onExit(({ exitCode, signal }) => {
      this.sendQueue.clear();
      this.setState('exited');
      this.emit('exit', exitCode, signal);
    });

    // Watch the Stop-marker file. Each new line = one turn ended.
    watchFile(this.stopMarkerPath, { interval: 250 }, () => {
      try {
        const lines = readFileSync(this.stopMarkerPath, 'utf-8')
          .split('\n')
          .filter(Boolean);
        if (lines.length > this.lastMarkerCount) {
          this.lastMarkerCount = lines.length;
          if (this.state === 'thinking') this.setState('ready');
          this.emit('turn-end');
        }
      } catch {
        /* file may not exist yet on first tick */
      }
    });

    // Watch the events file. Each new line is a structured chat event
    // (user prompt / assistant reply / tool start / tool end).
    watchFile(this.eventsPath, { interval: 200 }, () => {
      try {
        const lines = readFileSync(this.eventsPath, 'utf-8')
          .split('\n')
          .filter(Boolean);
        if (lines.length > this.lastEventCount) {
          for (let i = this.lastEventCount; i < lines.length; i++) {
            let obj;
            try { obj = JSON.parse(lines[i]); } catch { continue; }
            this.emit('event', obj);
          }
          this.lastEventCount = lines.length;
        }
      } catch {
        /* file may not exist yet */
      }
    });

    // JSONL tailer — CC's per-session transcript is the canonical source for
    // turn lifecycle + tool calls (see the chat reliability design).
    //
    // Path resolution:
    //  - Caller passed jsonlPath (orchestrator path; --session-id at spawn
    //    means we KNOW where CC will write): attach immediately if the file
    //    exists, else poll that exact path for first-existence then attach.
    //    No directory scan, no mtime race, no bleed-through risk.
    //  - No jsonlPath (subagent path; CC mints its own UUID): fall back to
    //    the legacy directory-scan discovery loop.
    this.spawnedAt = Date.now();
    // ALWAYS defer JSONL attach to next-tick. The tailer emits historical
    // events synchronously on attach, but the constructor's caller hasn't
    // wired the 'jsonl-event' listener yet. Without this deferral, resume
    // replays the entire prior conversation into a dead emitter and the
    // chat panel stays blank even though claude.exe loaded the context.
    setImmediate(() => {
      if (this.state === 'exited') return;
      if (opts.jsonlPath) {
        if (existsSync(opts.jsonlPath)) {
          this.attachTailer(opts.jsonlPath, opts.jsonlStartLine ?? 0);
        } else {
          this.waitForNamedJsonl(opts.jsonlPath, opts.jsonlStartLine ?? 0);
        }
      } else {
        this.startJsonlDiscovery();
      }
    });
  }

  /** Poll a known JSONL path every 250ms until it exists, then attach. Used
   *  when --session-id is passed at spawn — we know the exact filename CC
   *  will write but it doesn't appear until CC's first turn. Replaces the
   *  mtime-race directory scan for the orchestrator path. */
  private waitForNamedJsonl(filePath: string, startLine: number): void {
    const tryAttach = () => {
      if (this.tailer || this.state === 'exited') return;
      if (existsSync(filePath)) {
        this.attachTailer(filePath, startLine);
        this.emit('jsonl-path-resolved', filePath);
        return;
      }
      this.discoveryTimer = setTimeout(tryAttach, 250);
    };
    this.discoveryTimer = setTimeout(tryAttach, 250);
  }

  /** Poll `~/.claude/projects/<encoded-cwd>/` every 250ms for a .jsonl file
   *  whose mtime is at/after our spawn time. First match wins. */
  private startJsonlDiscovery(): void {
    const projectDir = join(
      this.claudeProjectsDir,
      encodeCwdForClaude(this.workspaceDir),
    );
    // Allow a small grace window for clock skew between Date.now() and
    // filesystem mtime — we'd rather latch onto a freshly-created file than
    // poll forever.
    const cutoff = this.spawnedAt - 1000;
    const tryFind = () => {
      if (this.tailer || this.state === 'exited') return;
      try {
        if (!existsSync(projectDir)) {
          this.discoveryTimer = setTimeout(tryFind, 250);
          return;
        }
        let best: { path: string; mtime: number } | null = null;
        for (const name of readdirSync(projectDir)) {
          if (!name.endsWith('.jsonl')) continue;
          const p = join(projectDir, name);
          // Skip JSONL files claimed by prior sessions. Without this guard a
          // fresh PtySession created via `+ New session` can latch onto the
          // dying OLD CC's JSONL (still being written within the kill grace
          // window) and re-emit the entire old conversation as jsonl-* events.
          if (this.excludeJsonlPaths.has(resolve(p))) continue;
          try {
            const st = statSync(p);
            const mt = st.mtimeMs;
            if (mt >= cutoff && (!best || mt > best.mtime)) {
              best = { path: p, mtime: mt };
            }
          } catch {
            /* file vanished mid-scan */
          }
        }
        if (best) {
          this.attachTailer(best.path, 0);
          this.emit('jsonl-path-resolved', best.path);
          return;
        }
      } catch {
        /* dir disappeared / perms — keep polling */
      }
      this.discoveryTimer = setTimeout(tryFind, 250);
    };
    this.discoveryTimer = setTimeout(tryFind, 250);
  }

  private attachTailer(filePath: string, startLine: number): void {
    this.tailer = new JsonlTailer({ filePath, startLine });
    this.tailer.on('event', (ev: JsonlEvent, meta?: JsonlEventMeta) => {
      // Section 23: persist before broadcasting so a crash mid-handler can't
      // drop the event from the durable log. The WS broadcast is best-effort;
      // the disk log is the contract.
      const replay = this.persistJsonlEvent(ev, meta);
      this.emit('jsonl-event', ev, replay);
      if (ev.kind === 'jsonl-turn-end' && this.state === 'thinking') {
        this.setState('ready');
      }
      this.scheduleCursorPersist(filePath);
    });
    this.tailer.on('error', (err: Error) => {
      this.emit('jsonl-error', err);
    });
    this.tailer.start();
  }

  /** Section 23 — append a normalized event to the PC-owned jsonl-events.jsonl.
   *  Shape matches the WS `{type:'jsonl', event}` envelope so the replay path
   *  can broadcast each line verbatim without normalization. Append-only,
   *  line-terminated; a crash mid-line leaves a partial line that JSON.parse
   *  rejects during replay → skip + advance. Standard JSONL hygiene. */
  private persistJsonlEvent(ev: JsonlEvent, meta?: JsonlEventMeta): JsonlReplayMeta {
    const seq = this.nextReplaySeq++;
    const replay: JsonlReplayMeta = {
      id: `${this.replaySessionId}:${seq}`,
      sessionId: this.replaySessionId,
      seq,
      kind: ev.kind,
      source: {
        kind: 'claude-jsonl',
        cursor: meta?.sourceCursor ?? null,
      },
    };
    try {
      const line = JSON.stringify({
        ...replay,
        type: 'jsonl',
        event: ev,
      }) + '\n';
      appendFileSync(this.jsonlEventsPath, line);
    } catch (err) {
      // Best-effort. A failed disk write shouldn't cascade into a dropped live
      // event; surface the error for visibility and continue.
      this.emit('jsonl-persist-error', err);
    }
    return replay;
  }

  /** Debounced — coalesce cursor persistence to ~1Hz to avoid hammering the
   *  DB during a flurry of tool calls. The trailing tick fires after activity
   *  stops; if the process dies mid-flurry we lose <=1s of cursor advance,
   *  which means at most 1s of duplicate broadcasts on resume. Acceptable. */
  private scheduleCursorPersist(filePath: string): void {
    if (this.cursorPersistTimer) return;
    this.cursorPersistTimer = setTimeout(() => {
      this.cursorPersistTimer = null;
      if (this.tailer) {
        this.emit('jsonl-cursor-tick', filePath, this.tailer.getCursor());
      }
    }, 1000);
  }

  /** Send a user message. Serializes paste/Enter pairs so rapid sends cannot
   *  merge in Claude's composer before the first delayed Enter fires. */
  send(text: string): 'ok' | 'exited' {
    if (this.state === 'exited') return 'exited';
    // Multi-line inputs (Section 4d's subagent dispatch envelope is always
    // multi-line) must use bracketed paste mode, or claude.exe's TUI
    // interprets each embedded `\n` as a submit and fragments the prompt
    // into N half-submits. The queue keeps the historical 500ms paste delay
    // but guarantees the next prompt is not written until the prior Enter has
    // gone through.
    const result = this.sendQueue.enqueue(text);
    if (result === 'exited') return 'exited';
    this.setState('thinking');
    return 'ok';
  }

  /** Stop the current turn. In claude.exe interactive mode, Escape (\x1b) is
   *  the stop-streaming key. Ctrl+C (\x03) only triggers the "Press Ctrl-C
   *  again to exit" prompt — it does NOT abort the in-flight response. */
  interrupt() {
    if (this.state === 'exited') return;
    this.child.write('\x1b');
  }

  /** Raw terminal input for xterm-backed debug surfaces. Bypasses the
   *  bracketed-paste chat send queue and writes exactly what xterm emits. */
  writeRaw(bytes: string): boolean {
    if (this.state === 'exited') return false;
    try {
      this.child.write(bytes);
      return true;
    } catch {
      return false;
    }
  }

  /** Section 20.C — re-send the Enter key without typing any text. Used by
   *  agent-run-manager's warmup-kick path: if the warmup text was typed but
   *  the submit got dropped (observed intermittently under concurrent spawn
   *  + strict-MCP-config handshake), a bare `\r` can wake the buffered text
   *  out of the prompt and into the model loop. Cheap; idempotent if CC has
   *  already moved on (an extra Enter on an empty prompt is a no-op). */
  kick() {
    if (this.state === 'exited') return;
    this.child.write('\r');
  }

  resize(cols: number, rows: number) {
    if (this.state === 'exited') return;
    try {
      this.child.resize(cols, rows);
    } catch {
      /* already dead */
    }
  }

  kill() {
    if (this.discoveryTimer) {
      clearTimeout(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    if (this.cursorPersistTimer) {
      clearTimeout(this.cursorPersistTimer);
      this.cursorPersistTimer = null;
    }
    this.sendQueue.clear();
    if (this.tailer) {
      this.tailer.stop();
      this.tailer = null;
    }
    // Detach the events.jsonl + stop-markers watchers BEFORE the child dies.
    // CC fires SessionEnd in the 500ms grace window between \x03 and SIGKILL;
    // that hook writes session-end into this session's events.jsonl. If the
    // watcher is still active, the line emits, broadcasts on the WS, and lands
    // in the NEXT session's chat stream as a stale "Session ended" notice.
    try { unwatchFile(this.eventsPath); } catch { /* ignore */ }
    try { unwatchFile(this.stopMarkerPath); } catch { /* ignore */ }
    // Stop emitting to anyone listening on this dead session.
    this.removeAllListeners();
    try {
      this.child.write('\x03');
      setTimeout(() => this.child.kill(), 500);
    } catch {
      /* already dead */
    }
  }

  getState(): SessionState {
    return this.state;
  }

  private setState(next: SessionState) {
    if (this.state === next) return;
    this.state = next;
    this.emit('state', next);
  }
}

/**
 * Strip ANSI / CSI sequences. Preserves visual spacing: cursor-forward
 * (CSI N C) becomes N spaces so "Loading\x1b[1Cdevelopment" stays readable.
 * Lifted verbatim from drive-t11.js.
 */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(parseInt(n || '1', 10)))
    .replace(/\x1b\[[\d;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[>=()]/g, '');
}

// Silence unused-import warning for `statSync` in some toolchains.
void statSync;
