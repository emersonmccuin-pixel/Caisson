// Import-level test: verifies commandIntroDismissed is present on the web
// GlobalSettings type and has the correct shape. No DOM/renderer needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { GlobalSettings } from '../src/features/settings/types.ts';

test('GlobalSettings has commandIntroDismissed as boolean field', () => {
  // Type-level: if the field is missing, this cast fails at typecheck.
  const s: Pick<GlobalSettings, 'commandIntroDismissed'> = {
    commandIntroDismissed: false,
  };
  assert.equal(s.commandIntroDismissed, false);
});

test('commandIntroDismissed can be set to true', () => {
  const s: Pick<GlobalSettings, 'commandIntroDismissed'> = {
    commandIntroDismissed: true,
  };
  assert.equal(s.commandIntroDismissed, true);
});
