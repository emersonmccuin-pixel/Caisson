// Bracketed-paste + echo-ack send.
//
// The positive ack replaced the old 500ms paste-then-Enter timing guess —
// the labs anti-criteria (D7) prohibits timing-heuristic gates and the labs
// scenarios proved echo-ack reliable across 45+ runs. (The timing-guess
// sender died with PtySession in Step 6.)
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

// ☠ Step 6 (P8, 2026-06-04) — `TimedBracketedPasteQueue` (the 500ms
// timing-guess sender PtySession used) DELETED with PtySession. Echo-ack
// (`sendBracketedPaste` below) is the one send protocol.

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
  // so submitting is correct. The tail is anchored AFTER our paste write so this
  // is our own placeholder, not a stale one.
  //
  // pc-pty-chat-455 — the marker MUST be matched mangling-tolerantly. Windows
  // ConPTY repaints the placeholder with cursor-move escapes that SKIP unchanged
  // cells; collapseAnsiToWhitespace turns the cursor-forward into whitespace and
  // the strip above then deletes the skipped characters, so "Pasted text #1" is
  // captured as `Pasted \x1b[2Cxt\x1b[1C#1` → compacts to "pastedxt#1", NOT
  // "pastedtext#1". The old `includes('pastedtext#')` check therefore missed and
  // the dispatch echo-timed-out → send-failed → spawn-failed (confirmed on two
  // live runs, both `pastedxt#1+…`). Match the distinctive, mangling-proof
  // signature instead: "pasted" followed within a few chars by "#<digit>".
  if (/pasted.{0,8}#\d/.test(compactTail)) return true;

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
