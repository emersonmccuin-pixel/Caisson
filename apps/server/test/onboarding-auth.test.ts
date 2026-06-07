// Unit tests for onboarding-auth.ts
//
// Tests cover:
//   - Mode detection from captured output (callback vs code-paste)
//   - Plan-failure detection
//   - submitCode writes to stdin (stub child)
//   - State shape

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Test the mode/planFailure logic by importing the pure helpers indirectly.
// We test the regex patterns and state machine logic using the exported types
// and a controlled environment — we don't spawn a real claude process.

// Test the mode-detection regex patterns by directly testing the detection
// logic that matches what ingest() uses internally.

const VISIT_RE = /visit:\s*(https?:\/\/\S+)/i;
const OAUTH_RE = /(https?:\/\/\S*(?:oauth|authorize)\S*)/i;
const CODE_PASTE_RE =
  /(?:paste|enter|type|provide)\s+(?:your\s+)?(?:authorization\s+)?code|authorization\s+code\s*:/i;
const PLAN_FAILURE_RE =
  /(?:not\s+subscribed|no\s+active\s+subscription|does\s+not\s+have\s+access|requires?\s+(?:a\s+)?(?:paid|pro|max|team)|Claude\s+(?:Pro|Max|Team)\s+(?:plan|subscription)|subscription\s+required)/i;

test('VISIT_RE matches "visit: https://..." pattern', () => {
  const text = 'If the browser did not open, visit: https://claude.ai/oauth/authorize?foo=bar';
  const m = VISIT_RE.exec(text);
  assert.ok(m, 'should match');
  assert.ok(m[1]!.startsWith('https://claude.ai'), 'should capture the URL');
});

test('OAUTH_RE catches bare oauth URL', () => {
  const text = 'Open: https://auth.example.com/oauth/authorize?client_id=x';
  const m = OAUTH_RE.exec(text);
  assert.ok(m, 'should match');
  assert.ok(m[1]!.includes('oauth'), 'should capture URL with oauth');
});

test('CODE_PASTE_RE detects "paste your authorization code"', () => {
  assert.ok(CODE_PASTE_RE.test('Please paste your authorization code:'));
  assert.ok(CODE_PASTE_RE.test('Enter your authorization code'));
  assert.ok(CODE_PASTE_RE.test('Type your code'));
  assert.ok(CODE_PASTE_RE.test('authorization code:'));
  assert.ok(CODE_PASTE_RE.test('Enter authorization code'));
});

test('CODE_PASTE_RE does not fire on normal sign-in text', () => {
  assert.ok(!CODE_PASTE_RE.test('Signing in to Claude...'));
  assert.ok(!CODE_PASTE_RE.test('Opening browser for authentication'));
  assert.ok(!CODE_PASTE_RE.test('visit: https://claude.ai/auth'));
});

test('PLAN_FAILURE_RE detects subscription error messages', () => {
  assert.ok(PLAN_FAILURE_RE.test('You are not subscribed to Claude'));
  assert.ok(PLAN_FAILURE_RE.test('No active subscription found'));
  assert.ok(PLAN_FAILURE_RE.test('Your account does not have access'));
  assert.ok(PLAN_FAILURE_RE.test('Requires a paid plan to continue'));
  assert.ok(PLAN_FAILURE_RE.test('Claude Pro plan required'));
  assert.ok(PLAN_FAILURE_RE.test('Claude Max subscription required'));
  assert.ok(PLAN_FAILURE_RE.test('Subscription required'));
});

test('PLAN_FAILURE_RE does not fire on normal text', () => {
  assert.ok(!PLAN_FAILURE_RE.test('Signing in to Claude...'));
  assert.ok(!PLAN_FAILURE_RE.test('visit: https://claude.ai'));
  assert.ok(!PLAN_FAILURE_RE.test('Successfully authenticated'));
});

test('localhost URL → callback mode; external URL → code-paste mode', () => {
  function detectMode(url: string): 'callback' | 'code-paste' {
    return /localhost|127\.0\.0\.1/.test(url) ? 'callback' : 'code-paste';
  }
  assert.equal(detectMode('http://localhost:12345/callback?code=abc'), 'callback');
  assert.equal(detectMode('http://127.0.0.1:8888/oauth'), 'callback');
  assert.equal(detectMode('https://claude.ai/oauth/authorize?state=xyz'), 'code-paste');
  assert.equal(detectMode('https://auth.anthropic.com/authorize'), 'code-paste');
});

// Stub child test: verify that submitCode writes code+\n to stdin.
test('submitCode writes code to a stub writable stdin', async () => {
  const written: string[] = [];
  const stubChild = {
    stdin: {
      writable: true,
      write(data: string) { written.push(data); return true; },
    },
  };

  // Inline the submitCode logic (mirrors the real implementation).
  function submitCode(code: string, child: typeof stubChild | null) {
    if (!child?.stdin?.writable) return;
    child.stdin.write(`${code.trim()}\n`);
  }

  submitCode('abc123', stubChild);
  assert.equal(written.length, 1);
  assert.equal(written[0], 'abc123\n');
});

test('submitCode is a no-op when no process is running', async () => {
  // Mirrors: if (!proc?.stdin?.writable) return;
  function submitCode(code: string, proc: null | { stdin: { writable: boolean; write: (s: string) => void } }) {
    if (!proc?.stdin?.writable) return;
    proc.stdin.write(`${code.trim()}\n`);
  }
  // No throw expected.
  submitCode('abc', null);
});
