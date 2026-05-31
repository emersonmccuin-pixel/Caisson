// Bracketed-paste + echo-ack send.
//
// Production today uses a 500ms setTimeout between paste and `\r`
// (pty-session.ts:517, labeled "conservative"). The rebuild replaces this
// with the positive ack — the labs anti-criteria (D7) prohibits timing-
// heuristic gates and the labs scenarios proved echo-ack reliable across
// 45+ runs.
//
// Send sequence:
//   1. Write `\x1b[200~<body>\x1b[201~` to the PTY.
//   2. Poll raw stdout buffer for an ANSI-normalized echo of the body.
//      CC usually echoes the first 12 characters of the paste into the
//      composer within 5–50ms. Windows ConPTY can repaint that leading slice
//      with cursor moves that drop/overwrite a character in our transcript, so
//      we also accept a small quorum of significant body words in the post-send
//      tail. This keeps Enter gated on evidence that the paste landed without
//      stranding a valid prompt in the composer.
//   3. After echo lands, write `\r`.
//
// The 5s ceiling is defense — if the echo never lands the spawn is in a bad
// state that needs to be reported as a failure, not silently retried.

import { collapseAnsiToWhitespace } from './ansi.ts';

export type SendResult = 'ok' | 'echo-timeout' | 'exited';

export interface SendDeps {
  /** Write raw bytes to the PTY. */
  write: (bytes: string) => void;
  /** Return the current raw output buffer accumulated by the spawn. */
  getRawBuffer: () => string;
  /** Returns true if the PTY has exited. */
  isExited: () => boolean;
  /** Optional clock override for tests. */
  now?: () => number;
  /** Optional sleep override for tests. Default is setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const ECHO_TIMEOUT_MS_DEFAULT = 5000;
const ECHO_POLL_MS = 25;
/** First N chars of body used to build the echo-detection probe. CC normalizes
 *  pasted input in the composer; matching on the leading slice maximizes the
 *  hit rate while staying short enough to avoid spuriously matching pre-paste
 *  prompt content. */
const ECHO_PROBE_LEN = 12;
const ECHO_WORD_SCAN_LEN = 160;
const ECHO_MIN_WORD_LEN = 3;
/** Gap between the two echo-timeout clear Escapes. CC's composer clear is a
 *  double-press (useDoublePress, 800ms window): the two `\x1b` must arrive as
 *  distinct keypress events but well inside that window. A small gap also lets
 *  the cleared composer render before the next drain pastes. */
const ECHO_CLEAR_SETTLE_MS = 40;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export type TimedPasteQueueResult = 'queued' | 'exited';

export interface TimedPasteQueueDeps {
  write: (bytes: string) => void;
  isExited: () => boolean;
  onSubmitted?: () => void;
  setTimeout?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface TimedPasteQueueOptions {
  submitDelayMs?: number;
  drainGapMs?: number;
}

const DEFAULT_TIMED_SUBMIT_DELAY_MS = 500;
const DEFAULT_TIMED_DRAIN_GAP_MS = 50;

/**
 * Legacy interactive PTY sender.
 *
 * PtySession cannot yet await echo-ack the way LowLevelSpawn does, but it must
 * still serialize paste/Enter pairs. Without serialization, two sends inside
 * the 500 ms paste window merge in Claude's composer while the UI records two
 * separate pending prompts.
 */
export class TimedBracketedPasteQueue {
  private queue: string[] = [];
  private inFlight = false;
  private submitTimer: ReturnType<typeof setTimeout> | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private submitDelayMs: number;
  private drainGapMs: number;
  private setTimeoutImpl: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private clearTimeoutImpl: (handle: ReturnType<typeof setTimeout>) => void;

  constructor(
    private deps: TimedPasteQueueDeps,
    opts: TimedPasteQueueOptions = {},
  ) {
    this.submitDelayMs = opts.submitDelayMs ?? DEFAULT_TIMED_SUBMIT_DELAY_MS;
    this.drainGapMs = opts.drainGapMs ?? DEFAULT_TIMED_DRAIN_GAP_MS;
    this.setTimeoutImpl = deps.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimeoutImpl = deps.clearTimeout ?? ((handle) => clearTimeout(handle));
  }

  enqueue(body: string): TimedPasteQueueResult {
    if (this.deps.isExited()) return 'exited';
    this.queue.push(body);
    this.drain();
    return 'queued';
  }

  clear(): void {
    this.queue = [];
    this.inFlight = false;
    if (this.submitTimer) {
      this.clearTimeoutImpl(this.submitTimer);
      this.submitTimer = null;
    }
    if (this.drainTimer) {
      this.clearTimeoutImpl(this.drainTimer);
      this.drainTimer = null;
    }
  }

  private drain(): void {
    if (this.inFlight || this.drainTimer || this.deps.isExited()) return;
    const body = this.queue.shift();
    if (body === undefined) return;

    this.inFlight = true;
    this.deps.write(`\x1b[200~${body}\x1b[201~`);
    this.submitTimer = this.setTimeoutImpl(() => {
      this.submitTimer = null;
      if (!this.deps.isExited()) {
        this.deps.write('\r');
        this.deps.onSubmitted?.();
      }
      this.inFlight = false;
      if (this.queue.length > 0 && !this.deps.isExited()) {
        this.drainTimer = this.setTimeoutImpl(() => {
          this.drainTimer = null;
          this.drain();
        }, this.drainGapMs);
      }
    }, this.submitDelayMs);
  }
}

function echoMatched(body: string, tail: string): boolean {
  const normalizedBody = collapseAnsiToWhitespace(body);
  const normalizedTail = collapseAnsiToWhitespace(tail);
  const compactTail = normalizedTail.replace(/\s+/g, '').toLowerCase();

  // CC replaces a multi-line (> ~2 lines) or > 800-char bracketed paste with a
  // "[Pasted text #N +L lines]" REF placeholder in the composer instead of
  // echoing the literal text (leaked CC PromptInput.tsx onTextPaste:
  // `text.length > PASTE_THRESHOLD(800) || numLines > maxLines(<=2)`). The
  // literal probe below can NEVER match that placeholder, so any structured /
  // multi-line body — e.g. an agent-completion `[pc:agent-event …]` turn —
  // would always echo-timeout and the turn would be lost. The placeholder
  // appearing in the post-send tail IS proof the paste landed; on Enter, CC
  // expands the ref back to the full content (history.ts expandPastedTextRefs),
  // so submitting is correct. "Pasted text #" is CC's stable, distinctive
  // marker; the tail is anchored AFTER our paste write so this is our own
  // placeholder, not a stale one.
  if (compactTail.includes('pastedtext#')) return true;

  const probe = normalizedBody.slice(0, ECHO_PROBE_LEN);
  if (probe.length === 0 || normalizedTail.includes(probe)) return true;

  const compactProbe = probe.replace(/\s+/g, '').toLowerCase();
  if (compactProbe.length >= ECHO_MIN_WORD_LEN && compactTail.includes(compactProbe)) {
    return true;
  }

  const words = Array.from(
    new Set(
      normalizedBody
        .slice(0, ECHO_WORD_SCAN_LEN)
        .toLowerCase()
        .match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [],
    ),
  );
  if (words.length === 0) return false;

  const required = words.length === 1 ? 1 : Math.min(3, words.length);
  let hits = 0;
  const lowerTail = normalizedTail.toLowerCase();
  for (const word of words) {
    if (!lowerTail.includes(word)) continue;
    hits++;
    if (hits >= required) return true;
  }
  return false;
}

/** Send a body through the bracketed-paste + echo-ack protocol. */
export async function sendBracketedPaste(
  deps: SendDeps,
  body: string,
  timeoutMs: number = ECHO_TIMEOUT_MS_DEFAULT,
): Promise<SendResult> {
  if (deps.isExited()) return 'exited';

  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;

  const markBefore = deps.getRawBuffer().length;

  deps.write(`\x1b[200~${body}\x1b[201~`);

  const startedAt = now();
  while (now() - startedAt < timeoutMs) {
    if (deps.isExited()) return 'exited';
    const tail = deps.getRawBuffer().slice(markBefore);
    if (echoMatched(body, tail)) {
      deps.write('\r');
      return 'ok';
    }
    await sleep(ECHO_POLL_MS);
  }
  // Slice 009 OBJ-3 (rev) — echo never landed: the bracketed-paste body is
  // sitting un-submitted in claude.exe's composer. Clear it so it can't glue
  // onto the next send's paste. A SINGLE Escape does NOT clear — CC's Esc is a
  // double-press (leaked CC src/hooks/useTextInput.ts handleEscape →
  // useDoublePress, 800ms window): the first Esc only arms an "Esc again to
  // clear" notification, which is exactly why the shipped single-Esc still
  // glued. Send a DOUBLE Escape (within the window, with a settle gap so they
  // parse as two keypresses) to trigger the real clear (onClearInput +
  // onChange('')), which empties the WHOLE composer regardless of line count —
  // Ctrl-U (killToLineStart) only clears to the current line start and would
  // leave earlier lines of a multi-line paste. Do NOT write `\r` — submitting
  // unverified text is the anti-criteria this protocol exists to avoid. The
  // caller still treats the send as failed via the 'echo-timeout' return.
  if (!deps.isExited()) {
    deps.write('\x1b');
    await sleep(ECHO_CLEAR_SETTLE_MS);
    if (!deps.isExited()) {
      deps.write('\x1b');
      await sleep(ECHO_CLEAR_SETTLE_MS);
    }
  }
  return 'echo-timeout';
}
