// Tests for the commandIntroDismissed field in domain/settings.ts:
// defaultGlobalSettings, and withSettingsDefaults backfill.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultGlobalSettings,
  withSettingsDefaults,
} from '../src/settings.ts';

const DATA_DIR = '/data';
const HOME_DIR = '/home/user';

test('defaultGlobalSettings: commandIntroDismissed is false', () => {
  const defaults = defaultGlobalSettings(DATA_DIR, HOME_DIR);
  assert.equal(defaults.commandIntroDismissed, false);
});

test('withSettingsDefaults: backfills commandIntroDismissed=false when absent', () => {
  const result = withSettingsDefaults({}, DATA_DIR, HOME_DIR);
  assert.equal(result.commandIntroDismissed, false);
});

test('withSettingsDefaults: preserves commandIntroDismissed=true from stored', () => {
  const result = withSettingsDefaults(
    { commandIntroDismissed: true },
    DATA_DIR,
    HOME_DIR,
  );
  assert.equal(result.commandIntroDismissed, true);
});

test('withSettingsDefaults: preserves commandIntroDismissed=false from stored', () => {
  const result = withSettingsDefaults(
    { commandIntroDismissed: false },
    DATA_DIR,
    HOME_DIR,
  );
  assert.equal(result.commandIntroDismissed, false);
});
