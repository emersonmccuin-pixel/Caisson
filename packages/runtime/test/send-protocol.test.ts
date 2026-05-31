// Pin the bracketed-paste + echo-ack send protocol.
//
// Real-CC verification lives in the labs scenario port; this suite covers
// the pure logic. Replaces the production 500ms setTimeout — see
// the agent-system design § 3.4.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sendBracketedPaste,
  TimedBracketedPasteQueue,
  type SendDeps,
} from '../src/send-protocol.ts';

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

function makeManualTimers() {
  type Handle = ReturnType<typeof setTimeout>;
  const timers: Array<{ id: Handle; cb: () => void; ms: number; cleared: boolean }> = [];
  let nextId = 1;
  return {
    setTimeout(cb: () => void, ms: number): Handle {
      const id = nextId++ as unknown as Handle;
      timers.push({ id, cb, ms, cleared: false });
      return id;
    },
    clearTimeout(handle: Handle): void {
      const timer = timers.find((t) => t.id === handle);
      if (timer) timer.cleared = true;
    },
    runNext(): number {
      const timer = timers.find((t) => !t.cleared);
      if (!timer) throw new Error('no active timer');
      timer.cleared = true;
      timer.cb();
      return timer.ms;
    },
    runAll(): void {
      while (timers.some((t) => !t.cleared)) {
        this.runNext();
      }
    },
  };
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

// SLICE-009 OBJ-3 — on echo-timeout the protocol now CLEARS the un-submitted
// composer body with Escape (\x1b), the existing graceful composer reset, so a
// partially-pasted body cannot glue onto the next send's paste. It still does
// NOT write \r (submitting unverified text is the anti-criteria) and still
// returns 'echo-timeout' so the caller treats the send as failed.
test('echo-ack: never lands → echo-timeout, writes Escape (clear), NOT Enter', async () => {
  const deps = makeDeps();
  // Buffer stays empty — no echo.
  const result = await sendBracketedPaste(deps, 'Reply with only OK.', 150);
  assert.equal(result, 'echo-timeout');
  assert.equal(deps.writes.length, 2); // paste + composer-clear (Escape)
  assert.match(deps.writes[0], /^\x1b\[200~/);
  assert.equal(deps.writes[1], '\x1b', 'echo-timeout clears the composer with Escape');
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
  // composer is cleared with Escape (slice-009 OBJ-3), not submitted.
  const result = await sendBracketedPaste(deps, 'Reply with only OK', 150);
  assert.equal(result, 'echo-timeout');
  assert.equal(deps.writes[deps.writes.length - 1], '\x1b');
  assert.ok(!deps.writes.includes('\r'));
});

test('timed queue serializes rapid paste/Enter pairs', () => {
  const timers = makeManualTimers();
  const writes: string[] = [];
  let submitted = 0;
  const queue = new TimedBracketedPasteQueue(
    {
      write: (bytes) => writes.push(bytes),
      isExited: () => false,
      onSubmitted: () => submitted++,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    },
    { submitDelayMs: 500, drainGapMs: 50 },
  );

  assert.equal(queue.enqueue('sup'), 'queued');
  assert.equal(queue.enqueue('Hello?'), 'queued');
  assert.deepEqual(writes, ['\x1b[200~sup\x1b[201~']);

  assert.equal(timers.runNext(), 500);
  assert.deepEqual(writes, ['\x1b[200~sup\x1b[201~', '\r']);
  assert.equal(submitted, 1);

  assert.equal(timers.runNext(), 50);
  assert.deepEqual(writes, [
    '\x1b[200~sup\x1b[201~',
    '\r',
    '\x1b[200~Hello?\x1b[201~',
  ]);

  assert.equal(timers.runNext(), 500);
  assert.deepEqual(writes, [
    '\x1b[200~sup\x1b[201~',
    '\r',
    '\x1b[200~Hello?\x1b[201~',
    '\r',
  ]);
  assert.equal(submitted, 2);
});

test('timed queue preserves drain gap for sends added during gap', () => {
  const timers = makeManualTimers();
  const writes: string[] = [];
  const queue = new TimedBracketedPasteQueue(
    {
      write: (bytes) => writes.push(bytes),
      isExited: () => false,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    },
    { submitDelayMs: 500, drainGapMs: 50 },
  );

  queue.enqueue('first');
  queue.enqueue('second');
  assert.equal(timers.runNext(), 500);
  assert.deepEqual(writes, ['\x1b[200~first\x1b[201~', '\r']);

  queue.enqueue('third');
  assert.deepEqual(writes, ['\x1b[200~first\x1b[201~', '\r']);

  assert.equal(timers.runNext(), 50);
  assert.deepEqual(writes, [
    '\x1b[200~first\x1b[201~',
    '\r',
    '\x1b[200~second\x1b[201~',
  ]);
});

test('timed queue clear cancels pending Enter and queued sends', () => {
  const timers = makeManualTimers();
  const writes: string[] = [];
  let submitted = 0;
  const queue = new TimedBracketedPasteQueue(
    {
      write: (bytes) => writes.push(bytes),
      isExited: () => false,
      onSubmitted: () => submitted++,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    },
    { submitDelayMs: 500, drainGapMs: 50 },
  );

  queue.enqueue('first');
  queue.enqueue('second');
  queue.clear();
  timers.runAll();

  assert.deepEqual(writes, ['\x1b[200~first\x1b[201~']);
  assert.equal(submitted, 0);
});

test('timed queue rejects enqueue after exit', () => {
  const writes: string[] = [];
  const queue = new TimedBracketedPasteQueue({
    write: (bytes) => writes.push(bytes),
    isExited: () => true,
  });

  assert.equal(queue.enqueue('lost'), 'exited');
  assert.deepEqual(writes, []);
});
