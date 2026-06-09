// Unit tests for parsePcUrl in use-rich-link-data.ts.
// Pins the accepted kinds including the new 'workflow' kind (pc-pty-chat-358.2)
// and the cross-project resolution path (pc-pty-chat-356).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePcUrl } from '../src/hooks/use-rich-link-data.ts';

const scheme = 'pc://';

test('work-item ULID parses', () => {
  const r = parsePcUrl(scheme + 'work-item/01KTNB006F6JS2HQ8M84CWATS2');
  assert.ok(r);
  assert.equal(r.kind, 'work-item');
  assert.equal(r.ref, '01KTNB006F6JS2HQ8M84CWATS2');
});

test('work-item callsign parses', () => {
  const r = parsePcUrl(scheme + 'work-item/pc-pty-chat-356');
  assert.ok(r);
  assert.equal(r.kind, 'work-item');
  assert.equal(r.ref, 'pc-pty-chat-356');
});

test('workflow slug parses', () => {
  const r = parsePcUrl(scheme + 'workflow/triage');
  assert.ok(r);
  assert.equal(r.kind, 'workflow');
  assert.equal(r.ref, 'triage');
});

test('workflow slug with hyphens parses', () => {
  const r = parsePcUrl(scheme + 'workflow/my-long-workflow-slug');
  assert.ok(r);
  assert.equal(r.kind, 'workflow');
  assert.equal(r.ref, 'my-long-workflow-slug');
});

test('file path parses', () => {
  const r = parsePcUrl(scheme + 'file/src/index.ts');
  assert.ok(r);
  assert.equal(r.kind, 'file');
  assert.equal(r.ref, 'src/index.ts');
});

test('attachment ULID parses', () => {
  const r = parsePcUrl(scheme + 'attachment/01KTABC12345678901234567AB');
  assert.ok(r);
  assert.equal(r.kind, 'attachment');
});

test('inbox ref parses', () => {
  const r = parsePcUrl(scheme + 'inbox/some-id');
  assert.ok(r);
  assert.equal(r.kind, 'inbox');
});

test('unknown kind returns null', () => {
  const r = parsePcUrl(scheme + 'unknown/xyz');
  assert.equal(r, null);
});

test('malformed URL returns null', () => {
  assert.equal(parsePcUrl('http://example.com'), null);
  assert.equal(parsePcUrl(''), null);
  assert.equal(parsePcUrl('not-a-url'), null);
});

test('percent-encoded ref is decoded', () => {
  const r = parsePcUrl(scheme + 'file/path%2Fwith%2Fslashes');
  assert.ok(r);
  assert.equal(r.ref, 'path/with/slashes');
});
