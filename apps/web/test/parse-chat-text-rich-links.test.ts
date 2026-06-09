// Tests for pc:// rich-link parsing in parse-chat-text.ts.
// Covers the workflow kind (pc-pty-chat-358.2) and verifies existing kinds
// still parse correctly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseUserText } from '../src/lib/parse-chat-text.ts';

const WI_URL = 'pc://' + 'work-item/01KTNB006F6JS2HQ8M84CWATS2';
const WF_URL = 'pc://' + 'workflow/triage';
const WF_MIXED = 'pc://' + 'workflow/my-process';
const UNKNOWN_URL = 'pc://' + 'unknown/xyz';
const FILE_URL = 'pc://' + 'file/CLAUDE.md';
const CALLSIGN_URL = 'pc://' + 'work-item/pc-pty-chat-356';

test('pc://work-item ref parses to a rich-link part', () => {
  const parts = parseUserText(`[my-card](${WI_URL})`);
  assert.equal(parts.length, 1);
  const [p] = parts;
  assert.equal(p.kind, 'rich-link');
  assert.equal(p.richLinkKind, 'work-item');
  assert.equal(p.richLinkRef, '01KTNB006F6JS2HQ8M84CWATS2');
  assert.equal(p.linkText, 'my-card');
});

test('pc://workflow slug parses to a rich-link part', () => {
  const parts = parseUserText(`[triage-workflow](${WF_URL})`);
  assert.equal(parts.length, 1);
  const [p] = parts;
  assert.equal(p.kind, 'rich-link');
  assert.equal(p.richLinkKind, 'workflow');
  assert.equal(p.richLinkRef, 'triage');
  assert.equal(p.linkText, 'triage-workflow');
});

test('workflow link in mixed text keeps text neighbours', () => {
  const parts = parseUserText(`Check out [my process](${WF_MIXED}) now.`);
  const link = parts.find((p) => p.kind === 'rich-link');
  assert.ok(link, 'should contain a rich-link part');
  assert.equal(link.richLinkKind, 'workflow');
  assert.equal(link.richLinkRef, 'my-process');
});

test('unknown pc scheme falls back to external-link', () => {
  const parts = parseUserText(`[label](${UNKNOWN_URL})`);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].kind, 'external-link');
});

test('pc file path still parses correctly', () => {
  const parts = parseUserText(`[CLAUDE.md](${FILE_URL})`);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].richLinkKind, 'file');
  assert.equal(parts[0].richLinkRef, 'CLAUDE.md');
});

test('callsign as work-item ref parses correctly', () => {
  const parts = parseUserText(`[pc-pty-chat-356](${CALLSIGN_URL})`);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].richLinkKind, 'work-item');
  assert.equal(parts[0].richLinkRef, 'pc-pty-chat-356');
});
