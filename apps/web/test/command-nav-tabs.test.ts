// pc-pty-chat-354 — Command nav trim: verify COMMAND_TABS omits Files, Patterns,
// and Processes (workflows) while the standard TABS keeps them.
//
// No DOM / renderer needed — these are pure constant checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TABS, COMMAND_TABS } from '../src/components/tabs-config.ts';

// ── Normal project TABS (all sections present) ────────────────────────────────

test('TABS includes files', () => {
  assert.ok((TABS as readonly string[]).includes('files'));
});

test('TABS includes workflows (Processes)', () => {
  assert.ok((TABS as readonly string[]).includes('workflows'));
});

test('TABS includes orchestrator (chat)', () => {
  assert.ok((TABS as readonly string[]).includes('orchestrator'));
});

test('TABS includes work-items', () => {
  assert.ok((TABS as readonly string[]).includes('work-items'));
});

test('TABS includes agents', () => {
  assert.ok((TABS as readonly string[]).includes('agents'));
});

// ── Command TABS (planning surface — trimmed) ─────────────────────────────────

test('COMMAND_TABS omits files', () => {
  assert.ok(!(COMMAND_TABS as readonly string[]).includes('files'));
});

test('COMMAND_TABS omits workflows (Processes)', () => {
  assert.ok(!(COMMAND_TABS as readonly string[]).includes('workflows'));
});

test('COMMAND_TABS omits patterns', () => {
  assert.ok(!(COMMAND_TABS as readonly string[]).includes('patterns'));
});

test('COMMAND_TABS keeps orchestrator (chat)', () => {
  assert.ok((COMMAND_TABS as readonly string[]).includes('orchestrator'));
});

test('COMMAND_TABS keeps work-items', () => {
  assert.ok((COMMAND_TABS as readonly string[]).includes('work-items'));
});

test('COMMAND_TABS keeps agents', () => {
  assert.ok((COMMAND_TABS as readonly string[]).includes('agents'));
});

// ── COMMAND_TABS is a strict subset of TABS ───────────────────────────────────

test('every COMMAND_TABS entry is in TABS', () => {
  const full = TABS as readonly string[];
  for (const t of COMMAND_TABS) {
    assert.ok(full.includes(t), `COMMAND_TABS entry "${t}" not found in TABS`);
  }
});
