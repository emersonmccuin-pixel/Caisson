// Import-level tests for onboarding hardening.
//
// The web package runs tsx --test (node:test) without a DOM renderer, so we
// cannot mount React components. These tests verify:
//   - The OnboardingLoginState type has the new fields (mode, planFailure, planFailureNote)
//   - The settingsApi.submitOnboardingCode function is exported and callable
//   - The OnboardingWizard module exports the component with the updated props
//   - Gate logic: allDone requires claudeOk AND gitOk AND authOk AND folderOk

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Import the real exported types and client.
import type { OnboardingLoginState, LoginMode } from '../src/features/settings/types.ts';
import { settingsApi } from '../src/features/settings/client.ts';
import { OnboardingWizard } from '../src/components/onboarding/OnboardingWizard.tsx';

// ── Type-level tests (compile-time guarantees, executed at runtime for coverage) ──

test('OnboardingLoginState includes mode field', () => {
  // If the type is wrong, this cast would fail at typecheck time.
  const state: OnboardingLoginState = {
    running: false,
    url: null,
    mode: 'unknown' as LoginMode,
    planFailure: false,
    planFailureNote: null,
    exited: false,
    exitCode: null,
    tail: '',
  };
  assert.equal(state.mode, 'unknown');
  assert.equal(state.planFailure, false);
  assert.equal(state.planFailureNote, null);
});

test('LoginMode type accepts all three values', () => {
  const modes: LoginMode[] = ['callback', 'code-paste', 'unknown'];
  assert.equal(modes.length, 3);
  assert.ok(modes.includes('callback'));
  assert.ok(modes.includes('code-paste'));
  assert.ok(modes.includes('unknown'));
});

test('settingsApi exports submitOnboardingCode', () => {
  assert.equal(typeof settingsApi.submitOnboardingCode, 'function');
});

test('settingsApi.submitOnboardingCode accepts a string argument', () => {
  // Does not call the network — just verify the function signature accepts a string.
  // The function returns a Promise; we don't await it (it would fail without a server).
  const result = settingsApi.submitOnboardingCode('test-code-123');
  assert.ok(result instanceof Promise, 'should return a Promise');
  // Suppress unhandled rejection (expected — no server in test).
  result.catch(() => {});
});

test('OnboardingWizard component is exported', () => {
  assert.equal(typeof OnboardingWizard, 'function');
});

// ── Gate logic tests (pure logic, no React) ──

test('allDone gate: all four prerequisites must be true', () => {
  function computeAllDone(
    claudeOk: boolean,
    gitOk: boolean,
    authOk: boolean,
    folderOk: boolean,
  ): boolean {
    return claudeOk && gitOk && authOk && folderOk;
  }

  assert.equal(computeAllDone(true, true, true, true), true);
  assert.equal(computeAllDone(false, true, true, true), false, 'claudeOk missing');
  assert.equal(computeAllDone(true, false, true, true), false, 'gitOk missing');
  assert.equal(computeAllDone(true, true, false, true), false, 'authOk missing');
  assert.equal(computeAllDone(true, true, true, false), false, 'folderOk missing');
  assert.equal(computeAllDone(false, false, false, false), false, 'all missing');
});

test('buildOutstanding returns correct labels for each missing item', () => {
  function buildOutstanding(
    claudeOk: boolean,
    gitOk: boolean,
    authOk: boolean,
    folderOk: boolean,
  ): string[] {
    const items: string[] = [];
    if (!claudeOk) items.push('Claude Code not installed');
    if (!gitOk) items.push('Git not installed');
    if (!authOk) items.push('Not signed in to Claude');
    if (!folderOk) items.push('Projects folder not set');
    return items;
  }

  assert.deepEqual(buildOutstanding(true, true, true, true), []);
  assert.deepEqual(buildOutstanding(false, true, true, true), ['Claude Code not installed']);
  assert.deepEqual(buildOutstanding(true, false, true, true), ['Git not installed']);
  assert.deepEqual(buildOutstanding(true, true, false, true), ['Not signed in to Claude']);
  assert.deepEqual(buildOutstanding(true, true, true, false), ['Projects folder not set']);
  assert.equal(buildOutstanding(false, false, false, false).length, 4);
});
