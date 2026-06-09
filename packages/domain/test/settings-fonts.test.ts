// Tests for the per-surface font normalizer in domain/settings.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeFontKey,
  normalizeFontSettings,
  FONT_GROUP_DEFAULTS,
  FONT_KEYS,
  MONO_FONT_KEYS,
  type FontKey,
} from '../src/settings.ts';

// ── normalizeFontKey ──────────────────────────────────────────────────────────

test('normalizeFontKey: known key accepted for non-code group', () => {
  assert.equal(normalizeFontKey('inter', 'chat'), 'inter');
  assert.equal(normalizeFontKey('ibm-plex-sans', 'workItems'), 'ibm-plex-sans');
  assert.equal(normalizeFontKey('source-serif-4', 'ui'), 'source-serif-4');
});

test('normalizeFontKey: mono key accepted for code group', () => {
  assert.equal(normalizeFontKey('jetbrains-mono', 'code'), 'jetbrains-mono');
  assert.equal(normalizeFontKey('fira-code', 'code'), 'fira-code');
  assert.equal(normalizeFontKey('ibm-plex-mono', 'code'), 'ibm-plex-mono');
  assert.equal(normalizeFontKey('system-mono', 'code'), 'system-mono');
});

test('normalizeFontKey: sans key in code group falls back to default', () => {
  assert.equal(normalizeFontKey('inter', 'code'), FONT_GROUP_DEFAULTS.code);
  assert.equal(normalizeFontKey('ibm-plex-sans', 'code'), FONT_GROUP_DEFAULTS.code);
  assert.equal(normalizeFontKey('atkinson-hyperlegible', 'code'), FONT_GROUP_DEFAULTS.code);
  assert.equal(normalizeFontKey('source-serif-4', 'code'), FONT_GROUP_DEFAULTS.code);
  assert.equal(normalizeFontKey('system', 'code'), FONT_GROUP_DEFAULTS.code);
});

test('normalizeFontKey: unknown string falls back to group default', () => {
  assert.equal(normalizeFontKey('comic-sans', 'chat'), FONT_GROUP_DEFAULTS.chat);
  assert.equal(normalizeFontKey('', 'ui'), FONT_GROUP_DEFAULTS.ui);
  assert.equal(normalizeFontKey('totally-unknown', 'code'), FONT_GROUP_DEFAULTS.code);
});

test('normalizeFontKey: non-string values fall back to group default', () => {
  assert.equal(normalizeFontKey(null, 'chat'), FONT_GROUP_DEFAULTS.chat);
  assert.equal(normalizeFontKey(undefined, 'workItems'), FONT_GROUP_DEFAULTS.workItems);
  assert.equal(normalizeFontKey(42, 'ui'), FONT_GROUP_DEFAULTS.ui);
  assert.equal(normalizeFontKey({}, 'code'), FONT_GROUP_DEFAULTS.code);
});

test('normalizeFontKey: defaults match expected values', () => {
  assert.equal(FONT_GROUP_DEFAULTS.chat, 'system');
  assert.equal(FONT_GROUP_DEFAULTS.workItems, 'system');
  assert.equal(FONT_GROUP_DEFAULTS.ui, 'ibm-plex-sans');
  assert.equal(FONT_GROUP_DEFAULTS.code, 'jetbrains-mono');
});

// ── normalizeFontSettings ─────────────────────────────────────────────────────

test('normalizeFontSettings: valid full object passes through', () => {
  const input = { chat: 'inter', workItems: 'ibm-plex-sans', ui: 'fira-code', code: 'ibm-plex-mono' };
  const result = normalizeFontSettings(input);
  assert.equal(result.chat, 'inter');
  assert.equal(result.workItems, 'ibm-plex-sans');
  assert.equal(result.ui, 'fira-code');
  assert.equal(result.code, 'ibm-plex-mono');
});

test('normalizeFontSettings: null input → all defaults', () => {
  const result = normalizeFontSettings(null);
  assert.deepEqual(result, FONT_GROUP_DEFAULTS);
});

test('normalizeFontSettings: undefined input → all defaults', () => {
  const result = normalizeFontSettings(undefined);
  assert.deepEqual(result, FONT_GROUP_DEFAULTS);
});

test('normalizeFontSettings: partial object backfills missing keys with defaults', () => {
  const result = normalizeFontSettings({ chat: 'source-serif-4' });
  assert.equal(result.chat, 'source-serif-4');
  assert.equal(result.workItems, FONT_GROUP_DEFAULTS.workItems);
  assert.equal(result.ui, FONT_GROUP_DEFAULTS.ui);
  assert.equal(result.code, FONT_GROUP_DEFAULTS.code);
});

test('normalizeFontSettings: coerces ineligible code font to default', () => {
  const result = normalizeFontSettings({
    chat: 'inter',
    workItems: 'inter',
    ui: 'inter',
    code: 'inter', // not mono — should fall back
  });
  assert.equal(result.code, FONT_GROUP_DEFAULTS.code);
  assert.equal(result.ui, 'inter'); // non-code group accepts any font
});

// ── registry constants ────────────────────────────────────────────────────────

test('FONT_KEYS contains all 9 keys', () => {
  assert.equal(FONT_KEYS.length, 9);
});

test('MONO_FONT_KEYS contains 4 keys', () => {
  assert.equal(MONO_FONT_KEYS.length, 4);
});

test('MONO_FONT_KEYS are all in FONT_KEYS', () => {
  for (const k of MONO_FONT_KEYS) {
    assert.ok((FONT_KEYS as readonly FontKey[]).includes(k), `${k} not in FONT_KEYS`);
  }
});
