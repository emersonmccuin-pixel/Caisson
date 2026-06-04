// Ready gate for spawned Claude sessions.
//
// Send is only permitted when the required signals have fired:
//   1. MCP handshake — pc-rig's `server.oninitialized` POSTs to
//      /api/internal/mcp-handshake. We expose notifyHandshake() so the HTTP
//      route can flip the flag.
//   2. Composer-ready — CC emitted `\x1b[?2004h` (bracketed-paste-mode-on)
//      into the PTY. One-shot ANSI sequence. Banner-immune.
//   3. Optional init-complete — CC emitted a stable composer-ready UI marker
//      somewhere in raw stdout. Remote-control markers count when enabled, but
//      the regular Claude footer counts too so the phone bridge is not a
//      dependency for interactive readiness.
//
// Subagents deliberately do not use `--remote-control`, so their gate requires
// only the first two signals. Step 6 (P8): this is THE one ready-detector —
// PtySession and its banner-regex (`terminalBufferLooksReady`) are deleted.
//
// The fresh and resume orderings differ — fresh often emits composer-ready
// first, resume often emits handshake first. The gate doesn't enforce ordering;
// it waits for the configured signal set.
//
// Pure logic. No PTY, no HTTP, no fs. Tested in isolation.

import { EventEmitter } from 'node:events';
import { collapseAnsiToWhitespace } from './ansi.ts';

const INIT_COMPLETE_SUBSTRING = '/remote-control is active';
const INIT_COMPLETE_STATUS_RE = /Remote\s*Control\s*active/i;
const CLAUDE_FOOTER_READY_RE = /bypass\s+permissions\s+on/i;
const CLAUDE_START_READY_RE =
  /Welcome\s*back|Tips\s*for\s*getting\s*started|What's\s*new|Try\s*"/i;
const BRACKETED_PASTE_ON = '\x1b[?2004h';

function looksInitComplete(rawBuffer: string): boolean {
  const normalized = collapseAnsiToWhitespace(rawBuffer);
  const compact = normalized.replace(/\s+/g, '').toLowerCase();
  return (
    normalized.includes(INIT_COMPLETE_SUBSTRING) ||
    INIT_COMPLETE_STATUS_RE.test(normalized) ||
    CLAUDE_FOOTER_READY_RE.test(normalized) ||
    CLAUDE_START_READY_RE.test(normalized) ||
    compact.includes('/remote-controlisactive') ||
    compact.includes('remotecontrolactive')
  );
}

export interface ReadyTimestamps {
  /** ms since epoch — when notifyHandshake() was called.
   *  Null when the gate was configured not to require the MCP handshake. */
  handshakeAt: number | null;
  /** ms since epoch — when `\x1b[?2004h` was first observed. */
  composerReadyAt: number;
  /** ms since epoch — when "/remote-control is active" first matched.
   *  Null when init-complete is not required for this gate. */
  initCompleteAt: number | null;
}

export class ReadyGate extends EventEmitter {
  private handshakeAt: number | null = null;
  private composerReadyAt: number | null = null;
  private initCompleteAt: number | null = null;
  private rawBuffer = '';
  private settled = false;
  private readonly requireInitComplete: boolean;
  private readonly requireHandshake: boolean;
  /** Optional override so tests can advance time deterministically. */
  private readonly now: () => number;

  constructor(opts: { now?: () => number; requireInitComplete?: boolean; requireHandshake?: boolean } = {}) {
    super();
    this.now = opts.now ?? Date.now;
    this.requireInitComplete = opts.requireInitComplete ?? true;
    this.requireHandshake = opts.requireHandshake ?? true;
  }

  /** Feed a raw stdout chunk from the PTY. Idempotent once the gate opens. */
  feedChunk(bytes: string): void {
    if (this.settled) return;
    this.rawBuffer += bytes;

    if (this.composerReadyAt === null && bytes.includes(BRACKETED_PASTE_ON)) {
      this.composerReadyAt = this.now();
    }

    if (this.initCompleteAt === null && looksInitComplete(this.rawBuffer)) {
      this.initCompleteAt = this.now();
    }

    this.maybeFire();
  }

  /** Called by the HTTP handler when the agent's pc-rig MCP child POSTs
   *  /api/internal/mcp-handshake. Idempotent. */
  notifyHandshake(): void {
    if (this.settled) return;
    if (this.handshakeAt !== null) return;
    this.handshakeAt = this.now();
    this.maybeFire();
  }

  /** Returns the three timestamps if all signals have fired, else null. */
  snapshot(): ReadyTimestamps | null {
    if (
      (this.requireHandshake && this.handshakeAt === null) ||
      this.composerReadyAt === null ||
      (this.requireInitComplete && this.initCompleteAt === null)
    ) {
      return null;
    }
    return {
      handshakeAt: this.handshakeAt,
      composerReadyAt: this.composerReadyAt,
      initCompleteAt: this.initCompleteAt,
    };
  }

  isOpen(): boolean {
    return this.settled;
  }

  /** Defensive: clear state. Used when the spawn dies before the gate opens
   *  so the consumer's awaitReady promise can be rejected cleanly. */
  abort(reason: string): void {
    if (this.settled) return;
    this.settled = true;
    this.emit('aborted', reason);
  }

  private maybeFire(): void {
    if (this.settled) return;
    const snap = this.snapshot();
    if (!snap) return;
    this.settled = true;
    // Defer emit so callers attaching listeners after construction still
    // receive the event. (Section 15 lesson: synchronous emit during
    // construction races caller listener attach.)
    setImmediate(() => this.emit('ready', snap));
  }
}
