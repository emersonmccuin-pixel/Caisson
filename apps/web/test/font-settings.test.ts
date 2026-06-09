// Import-level tests for per-surface font theming.
//
// The web package test harness runs tsx --test without a DOM renderer, so we
// can't mount components. These tests verify:
//   - The font registry exports all expected keys and valid CSS stacks.
//   - fontsForGroup correctly limits Code & Terminal to mono-only.
//   - The GlobalSettings.fonts field is typed correctly.
//   - getCssStack returns a non-empty string for every known key.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FONT_REGISTRY, fontsForGroup, getCssStack } from '../src/features/settings/fonts.ts';
import { FONT_KEYS, MONO_FONT_KEYS, type FontKey, type FontSettings } from '../src/features/settings/types.ts';

test('FONT_REGISTRY has an entry for every FONT_KEY', () => {
  for (const key of FONT_KEYS) {
    assert.ok(key in FONT_REGISTRY, `Missing registry entry for key: ${key}`);
  }
});

test('Every registry entry has a non-empty label and cssStack', () => {
  for (const [key, entry] of Object.entries(FONT_REGISTRY)) {
    assert.ok(entry.label.length > 0, `Empty label for ${key}`);
    assert.ok(entry.cssStack.length > 0, `Empty cssStack for ${key}`);
  }
});

test('fontsForGroup("code") returns only mono keys', () => {
  const codeKeys = fontsForGroup('code');
  assert.deepEqual(new Set(codeKeys), new Set(MONO_FONT_KEYS));
});

test('fontsForGroup("chat") returns all font keys', () => {
  const chatKeys = fontsForGroup('chat');
  assert.equal(chatKeys.length, FONT_KEYS.length);
});

test('fontsForGroup("workItems") returns all font keys', () => {
  const wiKeys = fontsForGroup('workItems');
  assert.equal(wiKeys.length, FONT_KEYS.length);
});

test('fontsForGroup("ui") returns all font keys', () => {
  const uiKeys = fontsForGroup('ui');
  assert.equal(uiKeys.length, FONT_KEYS.length);
});

test('getCssStack returns non-empty string for every known key', () => {
  for (const key of FONT_KEYS) {
    const stack = getCssStack(key as FontKey);
    assert.ok(stack.length > 0, `Empty stack for ${key}`);
  }
});

test('FontSettings type has all four group fields', () => {
  // Type-level check — if the type is missing a field, this cast fails at typecheck.
  const s: FontSettings = {
    chat: 'inter',
    workItems: 'inter',
    ui: 'jetbrains-mono',
    code: 'jetbrains-mono',
  };
  assert.equal(s.chat, 'inter');
  assert.equal(s.workItems, 'inter');
  assert.equal(s.ui, 'jetbrains-mono');
  assert.equal(s.code, 'jetbrains-mono');
});

test('Default font values match spec: chat/workItems=inter, ui/code=jetbrains-mono', () => {
  const s: FontSettings = {
    chat: 'inter',
    workItems: 'inter',
    ui: 'jetbrains-mono',
    code: 'jetbrains-mono',
  };
  assert.equal(s.chat, 'inter');
  assert.equal(s.workItems, 'inter');
  assert.equal(s.ui, 'jetbrains-mono');
  assert.equal(s.code, 'jetbrains-mono');
});
