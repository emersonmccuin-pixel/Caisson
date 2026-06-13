// AgentRun — dispatched worker lifecycle wrapper.
//
// One AgentRun = one dispatched work unit (researcher, planner, writer,
// reviewer, extractor, agent-designer-when-dispatched, future specialists).
// State machine per design §4.1:
//
//   queued → spawning → running ⇌ paused → completed | failed | cancelled
//
// Owns: cap admission via AgentRunRegistry, LowLevelSpawn lifecycle, all
// timeout enforcement, terminal-state determination, and the AgentRunRecord
// that Session 7 will persist.
//
// Does NOT own: persistence (Session 7), MCP tool wiring (Session 9),
// pause-detection from JSONL (Session 7/8 — pause is externally signaled
// here via _markPaused). The wrapper exposes the state machine; the
// HTTP/MCP layers wire it to PC's surfaces.

import { EventEmitter } from 'node:events';
import type { JsonlEvent, JsonlEventMeta } from './jsonl-tailer.ts';
import {
  AgentRunRegistry,
  type AdmissionTicket,
} from './agent-run-registry.ts';
import {
  LowLevelSpawn,
  type LowLevelSpawnInput,
  type PodDescriptor,
  type SpawnState,
} from './low-level-spawn.ts';
import type { ReadyTimestamps } from './ready-gate.ts';
import type { SendResult } from './send-protocol.ts';

export type AgentRunState =
  | 'queued'
  | 'spawning'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Step-4 Slice 1 — ONE run primitive, policy flags (north-star §4).
 *  'default' = dispatched worker (today's behavior, unchanged).
 *  'persistent-interactive' = the orchestrator chat: no wall-clock ceiling
 *  (G3), cap-exempt admission (G4), interrupt/resize surface (G2/G6).
 *  (Idle/first-turn reaping is gone for EVERYONE — Step 8/FD-17.) */
export type AgentRunPolicy = 'default' | 'persistent-interactive';

/** Turn-level state for interactive surfaces (G1): 'busy' while CC is
 *  producing a turn, 'ready' when the composer is idle awaiting input.
 *  Derived from sends + JSONL signals; coarse but sufficient for the chat
 *  send-queue drain + UI affordances. */
export type AgentRunTurnState = 'ready' | 'busy';

export type AgentRunFailureCause =
  | 'spawn-stuck'
  /** ☠ HISTORICAL ONLY (Step 8/FD-17): no live writer — idle-kill is deleted.
   *  Kept so pre-P9 terminal rows still type/display. */
  | 'idle-timeout'
  | 'wall-clock-timeout'
  | 'ready-timeout'
  | 'spawn-error'
  | 'send-failed'
  | 'unexpected-exit'
  | 'cancel-while-queued'
  | 'cancelled'
  | 'mcp-handshake-never'
  | 'kill-during-spawn'
  | 'server-restart'
  | 'host-unavailable'
  | 'host-lost'
  | 'host-crashed'
  | 'host-protocol-error'
  /** Mirror of @pc/domain — the host answered but rejected the command. */
  | 'host-rejected'
  /** Mirror of @pc/domain — reached terminal without a submitted deliverable.
   *  Produced by the server's terminal gate, not the runtime; kept here so the
   *  two failure-cause unions stay in sync. */
  | 'no-deliverable';

export interface AgentRunRecord {
  agentRunId: string;
  ccProviderSessionId: string;
  podName: string;
  state: AgentRunState;
  cause?: AgentRunFailureCause;
  result?: string;
  createdAt: number;
  queuedAt?: number;
  spawningAt?: number;
  readyAt?: number;
  runningAt?: number;
  pausedAt?: number;
  terminalAt?: number;
  /** Set when this run resumes via pc_continue_agent (Session 8 wiring). */
  continues?: string;
  /** Set when an external observer signals a pause via _markPaused. */
  pendingAskId?: string;
  /** Lifecycle policy this run was started with. Default 'default'. */
  policy?: AgentRunPolicy;
  /** Turn-level ready⇌busy (G1). Meaningful from `running` onward. */
  turnState?: AgentRunTurnState;
}

/** Minimal interface LowLevelSpawn satisfies — lets tests inject a fake. */
export interface SpawnLike extends EventEmitter {
  start(): void;
  awaitReady(): Promise<ReadyTimestamps>;
  send(body: string, echoTimeoutMs?: number): Promise<SendResult>;
  /** M7 fix — resolve when PTY output has been quiet `quietMs` (true) or
   *  `maxWaitMs` elapsed (false). Optional so test fakes need not implement. */
  awaitOutputQuiet?(quietMs: number, maxWaitMs: number): Promise<boolean>;
  writeRaw?(bytes: string): boolean;
  notifyMcpHandshake(): void;
  interrupt(): void;
  resize?(cols: number, rows: number): void;
  kill(graceMs?: number): void;
  getState(): SpawnState;
  getJsonlPath(): string | null;
  /** OS pid of the spawned child, or null before start / after a failed spawn.
   *  Optional so test fakes need not implement it. */
  getPid?(): number | null;
}

export type SpawnFactory = (input: LowLevelSpawnInput) => SpawnLike;

export interface AgentRunInput {
  agentRunId: string;
  ccProviderSessionId: string;
  podDefinition: PodDescriptor;
  worktreePath: string;
  env: Record<string, string | undefined>;
  /** Lifecycle policy. 'persistent-interactive' (the orchestrator chat)
   *  disarms the wall-clock ceiling and takes the cap-exempt admission lane.
   *  Default 'default' — dispatched worker. */
  policy?: AgentRunPolicy;
  /** Pasted as first user turn on fresh spawn (echo-ack). Ignored on resume. */
  initialInput?: string;
  /** Default 'fresh'. 'resume' is used by Session 8's continuation primitive
   *  and by the pause/resume answer-delivery flow. */
  mode?: 'fresh' | 'resume';
  /** Continuation lineage. Set by pc_continue_agent (Session 8 wiring). */
  continues?: string;
  /** Source JSONL cursor handed to the spawn's tailer (line count at attach
   *  time so prior turn-ends don't replay as fresh events and prematurely
   *  complete the run). */
  jsonlStartLine?: number;
  /** Pre-resolved JSONL path — the exact file the host PTY writes (no
   *  path-resolver divergence). */
  jsonlPath?: string;
  mcpConfigPath?: string;
  settingsPath?: string;
  settingSources?: string;
  pluginDirs?: readonly string[];
  claudeExe?: string;
  transcriptPath?: string;
  // ── Step-4 Slice 2 — orchestrator spawn shaping (pass-through to
  // LowLevelSpawn; workers omit all of these) ───────────────────────────────
  /** Post-scrub env overrides (terminal color/capability env). */
  envOverrides?: Record<string, string | undefined>;
  /** `--model` override. */
  model?: string;
  /** Require CC's composer-ready UI marker in the ready gate. */
  requireReadySignal?: boolean;
  /** Gate readiness on the MCP handshake (orchestrator disables on resume). */
  requireMcpHandshake?: boolean;
  /** Launch the session remote-ready (`--remote-control`) so it can be driven
   *  from the Claude phone/web app, dialog-free. Orchestrator-only. */
  remoteControl?: boolean;
  /** Initial PTY geometry. */
  cols?: number;
  rows?: number;
  // Timeouts (all configurable; defaults per design §4.1):
  // ☠ Step 8 (P9/FD-17): `idleMs` (5min idle-kill) and `firstTurnMs` (90s
  // resume fail-fast) are DELETED — silence never executes a run. The server's
  // reconciler ladder owns quiet runs (badge → verify-alive → notify the
  // orchestrator); kills happen only on wall-clock or confirmed-dead
  // (onSpawnExit / host-lost).
  /** Catastrophic spawn-failure cap. Default 120_000 (2× handshake). */
  spawnStuckMs?: number;
  /** Hard ceiling per dispatch; persists through paused. Default 7_200_000 (2h). */
  wallClockMs?: number;
  /** Passed through to LowLevelSpawn. Default 60_000. */
  handshakeTimeoutMs?: number;
  /** Passed through to LowLevelSpawn. Default 60_000. */
  readyTimeoutMs?: number;
  /** Wait this long after kill before declaring cancelled, to catch late
   *  success (Section 18 V-4 lesson on Windows kill-isn't-synchronous).
   *  Default 5_000. */
  cancelGraceMs?: number;
  /** M7 fix — PTY must be quiet this long before a resume send (CC discards
   *  composer input typed mid-replay-repaint). Default 1_500. */
  resumeQuietMs?: number;
  /** M7 fix — cap on waiting for the quiet window (send anyway after this;
   *  the receipt check still guards the outcome). Default 10_000. */
  resumeQuietMaxWaitMs?: number;
  /** M7 fix — deadline per attempt for the answer's user row to appear in
   *  the JSONL (the positive receipt). Default 15_000. */
  resumeReceiptTimeoutMs?: number;
}

export interface AgentRunDeps {
  registry: AgentRunRegistry;
  /** Default = production factory: `(input) => new LowLevelSpawn(input)`. */
  spawnFactory?: SpawnFactory;
  /** Default = `Date.now`. Tests inject a fake. */
  now?: () => number;
}

const DEFAULTS = {
  spawnStuckMs: 120_000,
  wallClockMs: 7_200_000,
  handshakeTimeoutMs: 60_000,
  readyTimeoutMs: 60_000,
  cancelGraceMs: 5_000,
  resumeQuietMs: 1_500,
  resumeQuietMaxWaitMs: 10_000,
  resumeReceiptTimeoutMs: 15_000,
};

/** M7 fix — total sends attempted before a resume input is declared lost. */
const RESUME_SEND_MAX_ATTEMPTS = 3;

const defaultSpawnFactory: SpawnFactory = (input) => new LowLevelSpawn(input);

/**
 * Lifecycle wrapper for one dispatched agent run.
 *
 * Usage:
 *   const run = new AgentRun(input, { registry, spawnFactory });
 *   run.on('state', (next, prev) => ...);
 *   run.on('terminal', ({ status, cause, result }) => ...);
 *   run.on('jsonl-event', (ev) => ...);
 *   run.start();   // begins the lifecycle
 *   run.cancel();  // any time before terminal
 */
export class AgentRun extends EventEmitter {
  private state: AgentRunState = 'queued';
  private record: AgentRunRecord;
  private ticket: AdmissionTicket;
  private spawn: SpawnLike | null = null;
  private started = false;
  private cancelling = false;
  private lastAssistantText: string | null = null;
  /** Highest JSONL source cursor seen. Floors the resume receipt so a
   *  replayed historical user row can't satisfy it. */
  private lastJsonlCursorSeen = 0;
  /** One-shot waiter for the resume positive receipt (a fresh jsonl-user
   *  row). Resolved in onJsonlEvent. */
  private resumeReceiptWaiter: { floor: number; resolve: () => void } | null = null;
  private turnState: AgentRunTurnState = 'busy';
  private readonly policy: AgentRunPolicy;
  private readonly deps: Required<AgentRunDeps>;
  private readonly timeouts: typeof DEFAULTS;

  private timers: {
    spawnStuck?: NodeJS.Timeout;
    wallClock?: NodeJS.Timeout;
    cancelGrace?: NodeJS.Timeout;
  } = {};

  constructor(
    private readonly input: AgentRunInput,
    deps: AgentRunDeps,
  ) {
    super();
    this.deps = {
      registry: deps.registry,
      spawnFactory: deps.spawnFactory ?? defaultSpawnFactory,
      now: deps.now ?? (() => Date.now()),
    };
    this.timeouts = {
      spawnStuckMs: input.spawnStuckMs ?? DEFAULTS.spawnStuckMs,
      wallClockMs: input.wallClockMs ?? DEFAULTS.wallClockMs,
      handshakeTimeoutMs:
        input.handshakeTimeoutMs ?? DEFAULTS.handshakeTimeoutMs,
      readyTimeoutMs: input.readyTimeoutMs ?? DEFAULTS.readyTimeoutMs,
      cancelGraceMs: input.cancelGraceMs ?? DEFAULTS.cancelGraceMs,
      resumeQuietMs: input.resumeQuietMs ?? DEFAULTS.resumeQuietMs,
      resumeQuietMaxWaitMs:
        input.resumeQuietMaxWaitMs ?? DEFAULTS.resumeQuietMaxWaitMs,
      resumeReceiptTimeoutMs:
        input.resumeReceiptTimeoutMs ?? DEFAULTS.resumeReceiptTimeoutMs,
    };
    this.policy = input.policy ?? 'default';
    this.record = {
      agentRunId: input.agentRunId,
      ccProviderSessionId: input.ccProviderSessionId,
      podName: input.podDefinition.logicalName ?? input.podDefinition.name,
      state: 'queued',
      createdAt: this.deps.now(),
      queuedAt: this.deps.now(),
      continues: input.continues,
      policy: this.policy,
      turnState: this.turnState,
    };
    // Persistent-interactive runs take the cap-exempt lane (G4) — the chat
    // never consumes an agent slot or queues behind dispatched workers.
    this.ticket =
      this.policy === 'persistent-interactive'
        ? this.deps.registry.exempt()
        : this.deps.registry.admit();
  }

  /** Begin the lifecycle. Idempotent at the type level — calling twice
   *  throws. */
  start(): void {
    if (this.started) throw new Error('AgentRun.start() called twice');
    this.started = true;
    // ☠ Step 6 (P8): the `reattach` input field + reattachLifecycle() are
    // deleted — no caller ever set them. Live restart-survival is the host's
    // roster + the server's agent-host-reattach sweep, not an AgentRun mode.
    // Run the async lifecycle; any unhandled error funnels to a terminal
    // failed state so the cap-slot can't leak.
    this.runLifecycle().catch((err) => {
      this.toTerminal('failed', 'spawn-error', stringify(err));
    });
  }

  /** Trigger transition to a terminal state. State-aware:
   *   - queued        → withdraw from queue; transition to cancelled
   *   - spawning      → kill spawn; wait cancel-grace; transition
   *   - running       → kill spawn; wait cancel-grace for late-success
   *   - paused        → cancel pending ask; transition
   *   - any terminal  → no-op
   */
  cancel(): void {
    if (this.isTerminal()) return;
    if (this.cancelling) return;
    this.cancelling = true;

    if (this.state === 'queued') {
      this.ticket.abort();
      // The lifecycle's `await ticket.granted` will reject and route through
      // the cancel-while-queued terminal path.
      return;
    }

    // Once cancellation starts, lifecycle timeout timers should not race the
    // cancel-grace owner into a failed terminal state.
    this.clearSpawnStuck();
    this.clearWallClock();

    // spawning / running / paused -> kill and wait grace
    if (this.spawn) {
      try {
        this.spawn.kill();
      } catch {
        /* already dead */
      }
    }
    this.armCancelGrace();
  }

  /** External signal: the dispatched worker submitted its deliverable
   *  (`pc_submit_deliverable`) — the SOLE done-signal in the workflow-engine
   *  redesign. The server's deliverable route calls this after persisting the
   *  deliverable, driving running→completed WITHOUT depending on JSONL turn-end
   *  inference (a diverged tailer can no longer hang or fabricate a result).
   *  No-op unless running (already terminal / queued / paused). `result` is the
   *  free-text envelope; the contract carries the authoritative typed output. */
  complete(result?: string): void {
    if (this.state !== 'running') return;
    this.toTerminal('completed', undefined, result ?? this.lastAssistantText ?? '');
  }

  /** External signal: an observer (Session 8's MCP route or Session 7's
   *  tailer pause-detector) has detected a pause. Transition running→paused.
   *  No-op if state isn't 'running'. */
  _markPaused(askId: string): void {
    if (this.state !== 'running') return;
    this.record.pendingAskId = askId;
    this.record.pausedAt = this.deps.now();
    this.setState('paused');
    this.emit('paused', askId);
  }

  /** External signal: the answer arrived. Session 8 wires this to spawn a
   *  resume LowLevelSpawn with the answer as initialInput. For Session 6
   *  scope this just transitions paused→spawning and re-arms the lifecycle.
   *
   *  The wrapper takes a fresh SpawnLike from the factory (resume mode)
   *  and walks it through the same ready-gate → running flow. */
  _resumeWithAnswer(answer: string): void {
    if (this.state !== 'paused') return;
    if (this.cancelling) return;
    // M7 live-fire fix — the old "CC exits cleanly when paused" assumption is
    // FALSE: interactive claude.exe sits at the composer after the ask turn.
    // Kill the pre-pause child before the `--resume` spawn, or two processes
    // hold one session (observed live 2026-06-04: orphan survived even
    // pc_kill_agent_run, which only kills the current handle). The identity
    // guards in runSpawnPhase keep this kill's exit event from misfiring
    // onSpawnExit.
    const prePause = this.spawn;
    this.spawn = null;
    if (prePause) {
      try {
        prePause.kill();
      } catch {
        /* already dead */
      }
    }
    this.record.pendingAskId = undefined;
    this.setState('spawning');
    this.record.spawningAt = this.deps.now();
    this.armSpawnStuck();
    this.runSpawnPhase('resume', answer).catch((err) => {
      this.toTerminal('failed', 'spawn-error', stringify(err));
    });
  }

  /** Direct MCP handshake notification — Session 18's
   *  /api/internal/mcp-handshake route calls this. Idempotent. */
  notifyMcpHandshake(): void {
    this.spawn?.notifyMcpHandshake();
  }

  async send(body: string, echoTimeoutMs?: number): Promise<SendResult> {
    if (this.state !== 'running' || !this.spawn || this.isTerminal()) {
      return 'exited';
    }
    // A submitted user turn means CC is (about to be) producing — busy until
    // the next jsonl-turn-end (G1).
    this.setTurnState('busy');
    return this.spawn.send(body, echoTimeoutMs);
  }

  /** Graceful interrupt (G2) — Escape, CC's stop-streaming key. Non-destructive:
   *  the session stays alive at the composer. No-op unless a spawn is live. */
  interrupt(): void {
    if (this.isTerminal() || !this.spawn) return;
    try {
      this.spawn.interrupt();
    } catch {
      /* already dead */
    }
    // G1 — CC writes NOTHING to the JSONL on an interrupted turn (no assistant
    // row, no turn boundary — live-fired 2026-06-04), so the jsonl-turn-end
    // that normally flips us ready never comes. Report 'ready' — if CC is
    // somehow still streaming, a send queues in CC; staying 'busy' with no
    // future turn-end deadlocks the send-queue forever.
    this.setTurnState('ready');
  }

  /** Terminal-grade resize (G6). No-op when the spawn (or a test fake)
   *  doesn't expose resize. */
  resize(cols: number, rows: number): void {
    if (this.isTerminal() || !this.spawn) return;
    try {
      this.spawn.resize?.(cols, rows);
    } catch {
      /* already dead */
    }
  }

  /** Raw terminal keystrokes (Slice 2 — terminal-mode input). Bypasses the
   *  chat send queue / bracketed paste / echo-ack. False when no live spawn
   *  or the spawn doesn't expose raw writes. */
  writeRaw(bytes: string): boolean {
    if (this.isTerminal() || !this.spawn) return false;
    try {
      return this.spawn.writeRaw?.(bytes) ?? false;
    } catch {
      return false;
    }
  }

  getPolicy(): AgentRunPolicy {
    return this.policy;
  }

  getTurnState(): AgentRunTurnState {
    return this.turnState;
  }

  getJsonlPath(): string | null {
    return this.spawn?.getJsonlPath() ?? null;
  }

  /** OS pid of the live spawn, or null before the spawn phase / after exit.
   *  Used by the factory to persist the pid for the liveness sweep + hard-kill. */
  getPid(): number | null {
    return this.spawn?.getPid?.() ?? null;
  }

  getState(): AgentRunState {
    return this.state;
  }

  getRecord(): AgentRunRecord {
    return { ...this.record };
  }

  isTerminal(): boolean {
    return (
      this.state === 'completed' ||
      this.state === 'failed' ||
      this.state === 'cancelled'
    );
  }

  // -- internals ------------------------------------------------------

  private async runLifecycle(): Promise<void> {
    // Phase 1: queued → wait for admission
    try {
      await this.ticket.granted;
    } catch {
      // Ticket aborted — only happens via cancel() while queued.
      this.toTerminal('cancelled', 'cancel-while-queued');
      return;
    }

    if (this.state !== 'queued') return; // raced — shouldn't normally happen

    this.emit('queued-started');

    this.setState('spawning');
    this.record.spawningAt = this.deps.now();
    this.armSpawnStuck();
    this.armWallClock();

    const mode: 'fresh' | 'resume' = this.input.mode ?? 'fresh';
    await this.runSpawnPhase(mode, this.input.initialInput);
  }

  /** Walks the spawn → ready → running phase. Shared by initial dispatch
   *  AND resume-with-answer. Stops at running; the rest of the lifecycle
   *  is event-driven from spawn events. */
  private async runSpawnPhase(
    mode: 'fresh' | 'resume',
    inputBody: string | undefined,
  ): Promise<void> {
    const spawn = this.deps.spawnFactory(this.buildSpawnInput(mode));
    this.spawn = spawn;

    // Identity-guarded handlers (M7 fix): a replaced spawn (the pre-pause
    // child killed by _resumeWithAnswer) must not feed events into the run —
    // its kill-driven exit would otherwise misfire onSpawnExit as
    // 'unexpected-exit' while the resume spawn is mid-flight.
    const current = () => this.spawn === spawn;
    spawn.on('jsonl-event', (ev: JsonlEvent, meta?: JsonlEventMeta) => {
      if (current()) this.onJsonlEvent(ev, meta);
    });
    spawn.on('exit', (code, signal) => {
      if (current()) this.onSpawnExit(code, signal);
    });
    spawn.on('state', (s: SpawnState) => {
      if (current()) this.emit('spawn-state', s);
    });
    spawn.on('chunk', (text: string) => {
      if (current()) this.emit('chunk', text);
    });
    spawn.on('ready', (ts: ReadyTimestamps) => {
      if (current()) this.emit('ready', ts);
    });

    spawn.start();

    try {
      await spawn.awaitReady();
    } catch (err) {
      if (this.cancelling) {
        // Cancel path is handling its own terminal; no-op here. Cancel-grace
        // window will fire completeCancel().
        return;
      }
      this.toTerminal('failed', 'ready-timeout', stringify(err));
      return;
    }

    this.clearSpawnStuck();
    this.record.readyAt = this.deps.now();

    if (this.cancelling || this.isTerminal()) return;

    this.setState('running');
    this.record.runningAt = this.deps.now();
    // G1 — composer is at the prompt. If we're about to paste an input body
    // the very next thing is a turn, so go (or stay) busy instead.
    this.setTurnState(
      inputBody !== undefined && inputBody.length > 0 ? 'busy' : 'ready',
    );

    if (inputBody !== undefined && inputBody.length > 0) {
      try {
        if (mode === 'resume') {
          // M7 live-fire fix — a resume send raced CC's replay repaint: the
          // echo-ack passed (keystrokes echo immediately) but CC discarded the
          // composer on a later repaint, leaving the answer un-submitted and
          // the run wedged 'running' forever (2/2 repro 2026-06-04;
          // [[resume-needs-quiet-window]], lab-isolated 2026-05-22). Quiet-gate
          // the send, then require the POSITIVE receipt — the answer's user
          // row in the JSONL — with bounded re-sends. Silence is a typed
          // failure, never a wedge.
          const landed = await this.sendResumeInputWithReceipt(spawn, inputBody);
          if (!landed) {
            this.toTerminal(
              'failed',
              'send-failed',
              `resume-input-lost: answer never appeared as a JSONL user row after ${RESUME_SEND_MAX_ATTEMPTS} sends`,
            );
            return;
          }
        } else {
          const sendResult = await spawn.send(inputBody);
          if (sendResult !== 'ok') {
            this.toTerminal('failed', 'send-failed', `send: ${sendResult}`);
            return;
          }
        }
      } catch (err) {
        this.toTerminal('failed', 'send-failed', stringify(err));
        return;
      }
    }

    // ☠ Step 8 (P9/FD-17): the resume first-output watchdog is DELETED. A
    // resume that reaches `running` but never produces output (the
    // continuation input didn't land — the S2 ask-roundtrip killer) is now
    // the reconciler ladder's job: badge → verify-alive → notify the
    // orchestrator, never a 90s execution.
    // From here, lifecycle is event-driven via onJsonlEvent / onSpawnExit /
    // cancel / _markPaused.
  }

  /** M7 live-fire fix — deliver a resume answer with a POSITIVE receipt.
   *  Per attempt: wait for the PTY quiet window (CC discards composer input
   *  typed mid-replay-repaint), send via echo-ack, then require the answer's
   *  user row to appear in the JSONL past the pre-send cursor floor. Echo-ack
   *  alone is insufficient on resume — the echo arrives while CC is still
   *  repainting and the Enter is dropped (observed 2/2 live 2026-06-04).
   *  Returns true once the receipt lands; false after all attempts. A failed
   *  echo already double-Escape-clears the composer (send-protocol), and an
   *  eaten send leaves it empty, so re-pasting is safe. */
  private async sendResumeInputWithReceipt(
    spawn: SpawnLike,
    body: string,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= RESUME_SEND_MAX_ATTEMPTS; attempt++) {
      if (this.cancelling || this.isTerminal()) return false;
      await spawn.awaitOutputQuiet?.(
        this.timeouts.resumeQuietMs,
        this.timeouts.resumeQuietMaxWaitMs,
      );

      const floor = this.lastJsonlCursorSeen;
      const receipt = new Promise<boolean>((resolve) => {
        this.resumeReceiptWaiter = { floor, resolve: () => resolve(true) };
      });

      const sendResult = await spawn.send(body);
      if (sendResult === 'exited') {
        this.resumeReceiptWaiter = null;
        return false;
      }
      if (sendResult !== 'ok') {
        // echo-timeout — composer cleared by the protocol; retry.
        this.resumeReceiptWaiter = null;
        continue;
      }

      let receiptTimer: NodeJS.Timeout | undefined;
      const landed = await Promise.race([
        receipt,
        new Promise<boolean>((resolve) => {
          receiptTimer = setTimeout(
            () => resolve(false),
            this.timeouts.resumeReceiptTimeoutMs,
          );
        }),
      ]);
      if (receiptTimer) clearTimeout(receiptTimer);
      if (landed) return true;
      this.resumeReceiptWaiter = null;
    }
    return false;
  }

  /** Build the LowLevelSpawn input. Caller (Session 9 wiring) is expected to
   *  have already materialized the pod + rewritten `.mcp.json`; here we just
   *  hand the descriptor through. Shared by fresh and resume spawn. */
  private buildSpawnInput(mode: 'fresh' | 'resume'): LowLevelSpawnInput {
    return {
      podDefinition: this.input.podDefinition,
      worktreePath: this.input.worktreePath,
      env: this.input.env,
      ccProviderSessionId: this.input.ccProviderSessionId,
      mode,
      // initialInput is delivered explicitly via echo-ack after the gate opens;
      // we don't pass it to LowLevelSpawn (kept as a no-op pass-through field).
      mcpConfigPath: this.input.mcpConfigPath,
      settingsPath: this.input.settingsPath,
      settingSources: this.input.settingSources,
      pluginDirs: this.input.pluginDirs,
      claudeExe: this.input.claudeExe,
      transcriptPath: this.input.transcriptPath,
      jsonlStartLine: this.input.jsonlStartLine,
      jsonlPath: this.input.jsonlPath,
      // Step-4 Slice 2 — orchestrator spawn shaping (no-ops for workers).
      envOverrides: this.input.envOverrides,
      model: this.input.model,
      requireReadySignal: this.input.requireReadySignal,
      requireMcpHandshake: this.input.requireMcpHandshake,
      remoteControl: this.input.remoteControl,
      cols: this.input.cols,
      rows: this.input.rows,
      handshakeTimeoutMs: this.timeouts.handshakeTimeoutMs,
      readyTimeoutMs: this.timeouts.readyTimeoutMs,
    };
  }

  private onJsonlEvent(ev: JsonlEvent, meta?: JsonlEventMeta): void {
    this.emit('jsonl-event', ev, meta);
    if (meta && meta.sourceCursor > this.lastJsonlCursorSeen) {
      this.lastJsonlCursorSeen = meta.sourceCursor;
    }
    // G1 — turn boundaries: a user row (typed send / queued command popping)
    // opens a turn; a turn-end closes it.
    const kind = (ev as { kind?: unknown }).kind;
    if (kind === 'jsonl-user') {
      this.setTurnState('busy');
      // M7 fix — the resume positive receipt: a user row BEYOND the pre-send
      // cursor floor proves the answer landed as a real turn. (No meta = test
      // fake; accept arrival-order.)
      const waiter = this.resumeReceiptWaiter;
      if (waiter && (!meta || meta.sourceCursor > waiter.floor)) {
        this.resumeReceiptWaiter = null;
        waiter.resolve();
      }
    } else if (kind === 'jsonl-turn-end') this.setTurnState('ready');
    // Capture last assistant text for the completed-state result field.
    const text = extractAssistantText(ev);
    if (text !== null) this.lastAssistantText = text;
    // Workflow-engine redesign — a turn-end is NO LONGER a completion signal.
    // Completion comes solely from `complete()` (the agent's
    // `pc_submit_deliverable` receipt). A worker that ends its turn WITHOUT
    // delivering gets the server's deliverable-nudge (P9), then the stall
    // ladder; an exit without delivering falls to onSpawnExit, and the
    // server's terminal gate records `no-deliverable` — never a "completed-
    // but-empty". This kills completion-by-JSONL-inference (and the
    // dual-end_turn premature-complete race) at the root.
  }

  private onSpawnExit(_code: number | null, _signal: number | null): void {
    // A dead spawn can never deliver the resume receipt — drop the waiter so
    // it can't fire against a later spawn's JSONL stream.
    this.resumeReceiptWaiter = null;
    // Pause is the only state where a clean exit is expected. In any other
    // non-terminal state, a spawn exit is unexpected → failed.
    if (this.isTerminal()) return;
    if (this.state === 'paused') return; // CC exits cleanly when paused
    if (this.cancelling) return; // cancel-grace owns the terminal call
    this.toTerminal('failed', 'unexpected-exit');
  }

  private setState(next: AgentRunState): void {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.record.state = next;
    this.emit('state', next, prev);
  }

  /** G1 — turn-level ready⇌busy. Emits 'turn-state' on change so the host
   *  service can refresh snapshots (the chat send-queue drains on ready). */
  private setTurnState(next: AgentRunTurnState): void {
    if (this.turnState === next) return;
    this.turnState = next;
    this.record.turnState = next;
    this.emit('turn-state', next);
  }

  private toTerminal(
    next: 'completed' | 'failed' | 'cancelled',
    cause?: AgentRunFailureCause,
    result?: string,
  ): void {
    if (this.isTerminal()) return;
    this.clearAllTimers();
    this.record.cause = cause;
    this.record.result = next === 'completed' ? (result ?? '') : undefined;
    this.record.terminalAt = this.deps.now();
    this.setState(next);
    // Release the cap-slot. Idempotent — release / abort both safe here.
    this.ticket.release();
    // Terminal means this dispatched worker is done. Kill the PTY so completed
    // agents don't leave idle node.exe/claude.exe children behind.
    //
    // Issue 1 fix (Option A, belt-and-suspenders) — for `completed`, defer the
    // kill 2 s. An immediate kill injects \x03 via ConPTY in ~μs while the
    // HTTP tool-result response travels back over TCP in ~ms; \x03 wins and CC
    // sees its own correct pc_submit_deliverable as "[Request interrupted by
    // user]". For `failed`/`cancelled` there is no in-flight response to
    // protect, so kill immediately as before.
    if (this.spawn) {
      const spawnRef = this.spawn;
      if (next === 'completed') {
        // .unref() so the deferred kill doesn't hold the process open after
        // the rest of the app (or a test) exits.
        setTimeout(() => {
          try { spawnRef.kill(); } catch { /* already dead */ }
        }, 2000).unref();
      } else {
        try {
          spawnRef.kill();
        } catch {
          /* already dead */
        }
      }
    }
    this.emit('terminal', {
      status: next,
      cause,
      result: this.record.result,
    });
  }

  private armSpawnStuck(): void {
    this.clearSpawnStuck();
    this.timers.spawnStuck = setTimeout(() => {
      if (this.state === 'spawning') {
        this.toTerminal('failed', 'spawn-stuck');
        if (this.spawn) {
          try {
            this.spawn.kill();
          } catch {
            /* already dead */
          }
        }
      }
    }, this.timeouts.spawnStuckMs);
  }
  private clearSpawnStuck(): void {
    if (this.timers.spawnStuck) {
      clearTimeout(this.timers.spawnStuck);
      this.timers.spawnStuck = undefined;
    }
  }

  // ☠ Step 8 (P9/FD-17): armIdleTimer / resetIdleTimer / clearIdleTimer and
  // armFirstTurnWatchdog / clearFirstTurn are DELETED. Silence is the
  // reconciler ladder's business (badge → verify-alive → notify), never a
  // kill. The only timer-driven kills left are spawn-stuck (the spawn never
  // became ready — positive-receipt failure) and wall-clock (the FD-17
  // sanctioned hard ceiling).

  private armWallClock(): void {
    // G3 — no 2h ceiling on the chat; it lives as long as the app does.
    if (this.policy === 'persistent-interactive') return;
    if (this.timers.wallClock) return; // arm once; persists through paused
    this.timers.wallClock = setTimeout(() => {
      if (!this.isTerminal()) {
        this.toTerminal('failed', 'wall-clock-timeout');
        if (this.spawn) {
          try {
            this.spawn.kill();
          } catch {
            /* already dead */
          }
        }
      }
    }, this.timeouts.wallClockMs);
  }
  private clearWallClock(): void {
    if (this.timers.wallClock) {
      clearTimeout(this.timers.wallClock);
      this.timers.wallClock = undefined;
    }
  }

  private armCancelGrace(): void {
    this.clearCancelGrace();
    this.timers.cancelGrace = setTimeout(() => {
      this.completeCancel();
    }, this.timeouts.cancelGraceMs);
  }
  private clearCancelGrace(): void {
    if (this.timers.cancelGrace) {
      clearTimeout(this.timers.cancelGrace);
      this.timers.cancelGrace = undefined;
    }
  }

  /** End of cancel-grace window. If the spawn produced a late turn-end
   *  (Section 18 V-4 lesson — Windows kill isn't synchronous), the
   *  onJsonlEvent path will have already transitioned to completed; this
   *  function only fires the cancelled terminal if we're not yet done. */
  private completeCancel(): void {
    if (this.isTerminal()) return;
    this.toTerminal('cancelled', 'cancelled');
  }

  private clearAllTimers(): void {
    this.clearSpawnStuck();
    this.clearWallClock();
    this.clearCancelGrace();
  }
}

// -- helpers ----------------------------------------------------------

function stringify(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Extract the assistant's text from a JSONL event. Handles both the v1
 *  JsonlTailer event shape (`{ kind: 'jsonl-turn-end', text, stopReason }`)
 *  AND the v2 AgentRunJsonlTailer / fake-event shape that carries a raw `row`
 *  field. Returns null when neither shape applies. */
function extractAssistantText(ev: JsonlEvent): string | null {
  // v1/v2 typed shape — `jsonl-turn-end` carries the assistant text directly
  // on the event.
  if ((ev as { kind?: unknown }).kind === 'jsonl-turn-end') {
    const t = (ev as { text?: unknown }).text;
    return typeof t === 'string' && t.length > 0 ? t : null;
  }
  // Raw-row fallback — Session 6 tests + future v2 tailer pass-throughs feed
  // events shaped as `{ row: <jsonl-line-as-object> }`.
  const row = (ev as { row?: unknown }).row ?? (ev as { entry?: unknown }).entry;
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  if (r.type !== 'assistant') return null;
  const msg = (r.message ?? r) as Record<string, unknown>;
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .filter(
        (c): c is { type: 'text'; text: string } =>
          typeof c === 'object' &&
          c !== null &&
          (c as { type?: unknown }).type === 'text' &&
          typeof (c as { text?: unknown }).text === 'string',
      )
      .map((c) => c.text)
      .join('');
    return text || null;
  }
  return null;
}

