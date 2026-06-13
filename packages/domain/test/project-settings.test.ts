import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultProjectSettings,
  INTEGRATION_BRANCH_RE,
  withProjectSettingsDefaults,
} from '../src/project.ts';

// withProjectSettingsDefaults rebuilds the object key-by-key — any key it
// doesn't know is silently erased on the next read OR write. This round-trip
// is the regression that would have eaten integrationBranch.
test('integrationBranch survives the settings defaults round-trip', () => {
  const out = withProjectSettingsDefaults({ integrationBranch: 'reporting-rebuild-phase2' });
  assert.equal(out.integrationBranch, 'reporting-rebuild-phase2');

  // double round-trip (read → write merge → read)
  const again = withProjectSettingsDefaults({ ...out });
  assert.equal(again.integrationBranch, 'reporting-rebuild-phase2');
});

test('integrationBranch defaults to null and rejects junk', () => {
  assert.equal(defaultProjectSettings().integrationBranch, null);
  assert.equal(withProjectSettingsDefaults(undefined).integrationBranch, null);
  assert.equal(withProjectSettingsDefaults({}).integrationBranch, null);
  assert.equal(withProjectSettingsDefaults({ integrationBranch: '   ' }).integrationBranch, null);
  assert.equal(
    withProjectSettingsDefaults({ integrationBranch: '-leading-dash' }).integrationBranch,
    null,
  );
  // trims + accepts slashes
  assert.equal(
    withProjectSettingsDefaults({ integrationBranch: ' release/2026 ' }).integrationBranch,
    'release/2026',
  );
});

test('INTEGRATION_BRANCH_RE accepts real-world refs and rejects malformed ones', () => {
  for (const ok of ['dev', 'main', 'reporting-rebuild-phase2', 'release/2026.1', 'a.b_c-d']) {
    assert.equal(INTEGRATION_BRANCH_RE.test(ok), true, ok);
  }
  for (const bad of ['-x', '.hidden', '/abs', 'spa ce', '']) {
    assert.equal(INTEGRATION_BRANCH_RE.test(bad), false, bad);
  }
});

test('existing settings keys are unaffected by the new field', () => {
  const out = withProjectSettingsDefaults({
    cancelledVisibility: 'force-hidden',
    remoteControl: 'on',
  });
  assert.deepEqual(out, {
    cancelledVisibility: 'force-hidden',
    remoteControl: 'on',
    integrationBranch: null,
  });
});
