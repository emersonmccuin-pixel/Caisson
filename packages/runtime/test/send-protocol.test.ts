// Pin the bracketed-paste + echo-ack send protocol.
//
// Real-CC verification lives in the labs scenario port; this suite covers
// the pure logic. Replaces the production 500ms setTimeout — see
// the agent-system design § 3.4.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendBracketedPaste, type SendDeps } from '../src/send-protocol.ts';

interface FakeDeps extends SendDeps {
  writes: string[];
  buffer: { value: string };
}

function makeDeps(opts: { exited?: boolean } = {}): FakeDeps {
  const writes: string[] = [];
  const buffer = { value: '' };
  let exited = !!opts.exited;
  return {
    writes,
    buffer,
    write: (bytes: string) => {
      writes.push(bytes);
    },
    getRawBuffer: () => buffer.value,
    isExited: () => exited,
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    // expose a way to toggle exit from tests:
    // (not part of SendDeps interface; tests set exited via the closure)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _setExited: (v: boolean) => {
      exited = v;
    },
  } as unknown as FakeDeps;
}

test('echo-ack: paste + echo lands → Enter sent → ok', async () => {
  const deps = makeDeps();
  // Simulate CC echoing the leading slice of the body into the composer.
  setTimeout(() => {
    deps.buffer.value += 'composer renders: Reply with only';
  }, 10);

  const result = await sendBracketedPaste(deps, 'Reply with only the word OK.', 1000);
  assert.equal(result, 'ok');
  // First write: bracketed-paste wrapped body.
  assert.equal(
    deps.writes[0],
    '\x1b[200~Reply with only the word OK.\x1b[201~',
  );
  // Second write: bare carriage return.
  assert.equal(deps.writes[1], '\r');
});

// SLICE-009 OBJ-3 (rev) — on echo-timeout the protocol CLEARS the un-submitted
// composer body with a DOUBLE Escape. CC's Esc clear is a double-press
// (useDoublePress, 800ms window): a single Esc only arms an "Esc again to
// clear" notification and leaves the body, which is why the original single-Esc
// glued onto the next send. Two `\x1b` trigger the real clear, emptying the
// whole composer regardless of line count. It still does NOT write \r
// (submitting unverified text is the anti-criteria) and still returns
// 'echo-timeout' so the caller treats the send as failed.
test('echo-ack: never lands → echo-timeout, double-Escape (clear), NOT Enter', async () => {
  const deps = makeDeps();
  // Buffer stays empty — no echo.
  const result = await sendBracketedPaste(deps, 'Reply with only OK.', 150);
  assert.equal(result, 'echo-timeout');
  assert.equal(deps.writes.length, 3); // paste + two composer-clear Escapes
  assert.match(deps.writes[0], /^\x1b\[200~/);
  assert.equal(deps.writes[1], '\x1b', 'first Escape arms the double-press');
  assert.equal(deps.writes[2], '\x1b', 'second Escape triggers the real clear');
  assert.ok(!deps.writes.includes('\r'), 'echo-timeout must NEVER submit (\\r)');
});

test('echo-ack: exited mid-poll → exited result', async () => {
  const writes: string[] = [];
  const buffer = { value: '' };
  let exited = false;
  const deps: SendDeps = {
    write: (bytes) => writes.push(bytes),
    getRawBuffer: () => buffer.value,
    isExited: () => exited,
  };
  setTimeout(() => {
    exited = true;
  }, 30);

  const result = await sendBracketedPaste(deps, 'Hello world', 1000);
  assert.equal(result, 'exited');
  // PTY gone mid-poll: only the paste was written, no composer-clear, no \r.
  assert.ok(!writes.includes('\x1b'), 'exited path writes no composer-clear');
  assert.ok(!writes.includes('\r'), 'exited path writes no Enter');
});

test('echo-ack: exited before send → returns exited, no writes', async () => {
  const writes: string[] = [];
  const deps: SendDeps = {
    write: (b) => writes.push(b),
    getRawBuffer: () => '',
    isExited: () => true,
  };
  const result = await sendBracketedPaste(deps, 'body', 100);
  assert.equal(result, 'exited');
  assert.equal(writes.length, 0);
});

test('echo-ack: probe uses leading 12 chars, normalized', async () => {
  const deps = makeDeps();
  // Provide a body where the leading 12 chars normalize to "Reply with o".
  // Echo back the SAME slice with cursor-move-right between every word —
  // the normalizer should still match.
  setTimeout(() => {
    deps.buffer.value += '\x1b[200~Reply\x1b[1Cwith\x1b[1Co\x1b[1C…';
  }, 10);
  const result = await sendBracketedPaste(deps, 'Reply with only the word OK.', 1000);
  assert.equal(result, 'ok');
});

test('echo-ack: accepts lossy ConPTY cursor repaint when enough body words echo', async () => {
  const deps = makeDeps();
  setTimeout(() => {
    deps.buffer.value +=
      'We n\x1b[1Ced to make\x1b[1Csure you have\x1b[1Cbash,\x1b[1Cedit,\x1b[1Cwrite.';
  }, 10);

  const result = await sendBracketedPaste(
    deps,
    'We need to make sure you have bash, edit, write.',
    1000,
  );

  assert.equal(result, 'ok');
  assert.equal(deps.writes[1], '\r');
});

// SLICE-009 — CC renders a multi-line / >800-char bracketed paste as a
// "[Pasted text #N +L lines]" ref placeholder in the composer instead of the
// literal text (PromptInput.tsx onTextPaste). The literal echo probe can never
// match it, so a structured agent-completion `[pc:agent-event …]` turn used to
// always echo-timeout and silently vanish. The placeholder IS proof the paste
// landed; on Enter, CC expands the ref to the full content. Accept it as a
// match and submit.
test('echo-ack: multi-line body echoed as a Pasted-text-ref placeholder → ok + Enter', async () => {
  const deps = makeDeps();
  const body =
    '[pc:agent-event kind=agent-completed version=1]\n[runId: 01KSZX3DF3M8GB]\nresult: DONE\nmore: lines';
  // CC shows ONLY the placeholder ref in the composer, never the literal body.
  setTimeout(() => {
    deps.buffer.value += '\x1b[2K> [Pasted text #1 +3 lines]';
  }, 10);
  const result = await sendBracketedPaste(deps, body, 1000);
  assert.equal(result, 'ok', 'placeholder ref counts as a landed paste');
  assert.equal(deps.writes[0], `\x1b[200~${body}\x1b[201~`);
  assert.equal(deps.writes[1], '\r', 'submits so CC expands the ref to full content');
});

// pc-pty-chat-455 — Windows ConPTY repaints the "[Pasted text #N]" placeholder
// with cursor-move escapes that SKIP unchanged cells. collapseAnsiToWhitespace
// turns the cursor-forward into whitespace and the strip deletes the skipped
// characters, so "Pasted text #1" is captured as `Pasted \x1b[2Cxt\x1b[1C#1`
// and compacts to "pastedxt#1" (the "te" is gone), NOT "pastedtext#1". The old
// literal `includes('pastedtext#')` check missed → echo-timeout → spawn-failed
// (confirmed on two live runs). The detector must match the mangled form.
test('echo-ack: ConPTY-mangled Pasted-text placeholder (text→xt) still matches → ok', async () => {
  const deps = makeDeps();
  const body =
    'Investigate the codebase and produce a long report. '.repeat(30); // > 800 chars
  // EXACT byte shape captured from the failed runs: cursor-right over "te".
  setTimeout(() => {
    deps.buffer.value += '\x1b[15;3H> [Pasted \x1b[2Cxt\x1b[1C#1 +24 lines]';
  }, 10);
  const result = await sendBracketedPaste(deps, body, 1000);
  assert.equal(result, 'ok', 'mangled placeholder must count as a landed paste');
  assert.equal(deps.writes[1], '\r', 'submits so CC expands the ref to full content');
});

test('echo-ack: empty body returns ok immediately and still sends Enter', async () => {
  const deps = makeDeps();
  // Empty body → probe is empty → match is trivially true → Enter sent.
  const result = await sendBracketedPaste(deps, '', 100);
  assert.equal(result, 'ok');
  assert.equal(deps.writes[0], '\x1b[200~\x1b[201~');
  assert.equal(deps.writes[1], '\r');
});

test('echo-ack: probe is anchored to the post-write tail', async () => {
  // Buffer already contains content that LOOKS like the probe before send.
  // The poll should NOT match on pre-existing buffer — only on what arrives
  // AFTER the paste write.
  const deps = makeDeps();
  deps.buffer.value = 'Reply with only — leftover from a prior render';
  // No new echo lands → expect timeout because the leading slice is in the
  // pre-write portion of the buffer, not the post-write tail. On timeout the
  // composer is cleared with a double-Escape (slice-009 OBJ-3), not submitted.
  const result = await sendBracketedPaste(deps, 'Reply with only OK', 150);
  assert.equal(result, 'echo-timeout');
  assert.equal(deps.writes[deps.writes.length - 1], '\x1b');
  assert.ok(!deps.writes.includes('\r'));
});
