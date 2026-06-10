// Slice 5 — guardrail test: bash evidence capture.
//
// Principle 2a: no verdict without captured output.
// A bash_exit_zero FAILURE must include the captured stdout/stderr tail in
// the PredicateFailure.reason — a bare "exited N: <cmd>" with output available
// is a verification soundness defect (pc-pty-chat-372 part 1).
//
// These tests fence the *type* of failure, not just the instance: any future
// change that strips the tail out of the reason will be caught here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateAcceptance,
  type PredicateExecutors,
  type EvaluationContext,
} from '../src/index.ts';
import type { AcceptanceCriteria } from '../src/contract.ts';

function ctx(): EvaluationContext {
  return {
    body: '',
    fields: {},
    attachments: [],
    childWorkItems: [],
    report: '',
    toolCalls: [],
    pendingAskCreated: false,
  };
}

function execWith(
  overrides: Partial<Awaited<ReturnType<PredicateExecutors['runBash']>>>,
): PredicateExecutors {
  return {
    fileSize: async () => null,
    runBash: async () => ({ exitCode: 1, timedOut: false, ...overrides }),
  };
}

const failingCmd: AcceptanceCriteria = [
  { kind: 'bash_exit_zero', command: 'pnpm typecheck' },
];

// ── Core invariant ────────────────────────────────────────────────────────────

test('failure reason includes non-empty stdoutTail when present', async () => {
  const exec = execWith({ stdoutTail: 'src/foo.ts(3,5): error TS2322: Type mismatch' });
  const result = await evaluateAcceptance(failingCmd, ctx(), exec);
  assert.equal(result.pass, false);
  const reason = result.failures[0]!.reason;
  assert.ok(
    reason.includes('src/foo.ts(3,5): error TS2322'),
    `reason must contain the captured stdout tail; got: ${reason}`,
  );
});

test('failure reason includes non-empty stderrTail when present', async () => {
  const exec = execWith({ stderrTail: 'ERROR: Cannot find module ./missing' });
  const result = await evaluateAcceptance(failingCmd, ctx(), exec);
  assert.equal(result.pass, false);
  const reason = result.failures[0]!.reason;
  assert.ok(
    reason.includes('ERROR: Cannot find module ./missing'),
    `reason must contain the captured stderr tail; got: ${reason}`,
  );
});

test('failure reason includes both stdout and stderr when both present', async () => {
  const exec = execWith({
    stdoutTail: 'STDOUT: compile error',
    stderrTail: 'STDERR: fatal error',
  });
  const result = await evaluateAcceptance(failingCmd, ctx(), exec);
  assert.equal(result.pass, false);
  const reason = result.failures[0]!.reason;
  assert.ok(reason.includes('STDOUT: compile error'), `stdout missing from: ${reason}`);
  assert.ok(reason.includes('STDERR: fatal error'), `stderr missing from: ${reason}`);
});

// ── Soundness invariant: output present → reason is NOT bare ─────────────────

test('reason is NOT a bare "exited N: cmd" when stdout output is available', async () => {
  const exec = execWith({ exitCode: 2, stdoutTail: 'Test suite failed' });
  const result = await evaluateAcceptance(failingCmd, ctx(), exec);
  assert.equal(result.pass, false);
  const reason = result.failures[0]!.reason;
  // The bare form would be exactly: "bash command exited 2: pnpm typecheck"
  // It is acceptable to START with that, but it must carry MORE when output exists.
  const bareForm = 'bash command exited 2: pnpm typecheck';
  assert.notEqual(
    reason,
    bareForm,
    'reason must not be the bare "exited N: cmd" form when stdout is available',
  );
  assert.ok(reason.includes('Test suite failed'), `captured output missing from: ${reason}`);
});

test('reason is NOT a bare "exited N: cmd" when stderr output is available', async () => {
  const exec = execWith({ exitCode: 1, stderrTail: 'Error: unexpected token' });
  const result = await evaluateAcceptance(failingCmd, ctx(), exec);
  assert.equal(result.pass, false);
  const reason = result.failures[0]!.reason;
  const bareForm = 'bash command exited 1: pnpm typecheck';
  assert.notEqual(reason, bareForm, 'reason must not be bare when stderr is available');
  assert.ok(reason.includes('Error: unexpected token'), `captured stderr missing from: ${reason}`);
});

// ── Edge cases ────────────────────────────────────────────────────────────────

test('pass returns no failures (tails irrelevant on success)', async () => {
  const exec: PredicateExecutors = {
    fileSize: async () => null,
    runBash: async () => ({ exitCode: 0, timedOut: false, stdoutTail: 'all good' }),
  };
  const result = await evaluateAcceptance(failingCmd, ctx(), exec);
  assert.equal(result.pass, true);
  assert.equal(result.failures.length, 0);
});

test('timeout path still says "timed out" and does not require tail evidence', async () => {
  const exec: PredicateExecutors = {
    fileSize: async () => null,
    runBash: async () => ({ exitCode: 124, timedOut: true }),
  };
  const result = await evaluateAcceptance(failingCmd, ctx(), exec);
  assert.equal(result.pass, false);
  const reason = result.failures[0]!.reason;
  assert.match(reason, /timed out/, `timeout reason must say "timed out"; got: ${reason}`);
});

test('empty/absent tails produce the bare form (no phantom evidence injected)', async () => {
  // When the executor returns no tails (undefined), the reason is the minimal
  // "exited N: cmd" — we must NOT inject fake evidence.
  const exec: PredicateExecutors = {
    fileSize: async () => null,
    runBash: async () => ({ exitCode: 1, timedOut: false }),
  };
  const result = await evaluateAcceptance(failingCmd, ctx(), exec);
  assert.equal(result.pass, false);
  const reason = result.failures[0]!.reason;
  assert.match(reason, /exited 1/, `bare form must include exit code; got: ${reason}`);
  assert.match(reason, /pnpm typecheck/, `bare form must include command; got: ${reason}`);
});

// ── verificationNotes persistence (domain-level proxy) ───────────────────────
// The per-predicate failure list is persisted as JSON.stringify(failures) in
// agent-verification.ts. Since reason carries the tail, the tail rides in the
// JSON automatically. Verify the shape here so the server persistence is sound.

test('failures array carries the tail in reason (verificationNotes persistence proxy)', async () => {
  const exec = execWith({ stdoutTail: 'TAIL_MARKER_XYZ' });
  const result = await evaluateAcceptance(failingCmd, ctx(), exec);
  assert.equal(result.pass, false);
  // This is what agent-verification.ts does: JSON.stringify(failures)
  const notes = JSON.stringify(result.failures);
  assert.ok(
    notes.includes('TAIL_MARKER_XYZ'),
    `verificationNotes JSON must contain the captured tail; got: ${notes}`,
  );
});
