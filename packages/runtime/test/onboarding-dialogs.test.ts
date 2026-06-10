// Pin detection of CC's onboarding theme-picker and security-step dialogs so
// a future CC wording change can't silently break the headless auto-dismiss in
// low-level-spawn.  The detector logic must survive CC's cursor-right letter-
// splitting quirk (same as the resume-cost dialog — see resume-summary-dialog.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeOnboardingThemePicker,
  looksLikeOnboardingSecurityStep,
  looksLikeBypassPermissionsDialog,
} from '../src/low-level-spawn.ts';

// ── looksLikeOnboardingThemePicker ──────────────────────────────────────────
//
// CC source: src/components/ThemePicker.tsx (showIntroText=true path)
// Rendered text: "Let's get started." + "Choose the text style that looks best
// with your terminal" + theme-option list.

const THEME_PICKER_SIMPLE =
  "\x1b[2K\x1b[1m Let's get started.\x1b[0m\r\n" +
  '\x1b[1m Choose the text style that looks best with your terminal\x1b[0m\r\n' +
  '  \x1b[36m❯\x1b[0m Dark mode\r\n' +
  '    Light mode\r\n' +
  'Enter to confirm';

// "Let's get started" with CC's cursor-right letter-splitting quirk.
const THEME_PICKER_CURSOR_SPLIT =
  "L\x1b[1Ce\x1b[1Ct\x1b[1C'\x1b[1Cs\x1b[1C \x1b[1Cg\x1b[1Ce\x1b[1Ct\x1b[1C \x1b[1Cs\x1b[1Ct\x1b[1Ca\x1b[1Cr\x1b[1Ct\x1b[1Ce\x1b[1Cd\x1b[1C.";

test('theme-picker: fires on full buffer ("Let\'s get started.")', () => {
  assert.equal(looksLikeOnboardingThemePicker(THEME_PICKER_SIMPLE), true);
});

test('theme-picker: fires when phrase is cursor-right split', () => {
  assert.equal(looksLikeOnboardingThemePicker(THEME_PICKER_CURSOR_SPLIT), true);
});

test('theme-picker: fires on "Choose the text style" phrase alone', () => {
  const buf =
    '\x1b[1mChoose the text style that looks best with your terminal\x1b[0m';
  assert.equal(looksLikeOnboardingThemePicker(buf), true);
});

test('theme-picker: does not fire on resume-cost dialog', () => {
  const resume =
    '\x1b[2K This session is 1d 23h old and 130.7k tokens. Resuming the full ' +
    'session will consume a substantial portion of your usage limits.\r\n' +
    '\x1b[36m❯\x1b[0m 1. Resume\x1b[1Cfrom\x1b[1Csummary (recommended)\r\n' +
    'Enter to confirm · Esc to cancel';
  assert.equal(looksLikeOnboardingThemePicker(resume), false);
});

test('theme-picker: does not fire on trust dialog', () => {
  const trust =
    'Quick safety check\r\n Is this a project you created or downloaded?\r\n' +
    ' 1. Yes, I trust this folder\r\n' +
    'Enter to confirm · Esc to cancel';
  assert.equal(looksLikeOnboardingThemePicker(trust), false);
});

test('theme-picker: does not fire on ordinary chat output', () => {
  assert.equal(
    looksLikeOnboardingThemePicker('Hello! How can I help you today?'),
    false,
  );
});

test('theme-picker: does not fire on empty buffer', () => {
  assert.equal(looksLikeOnboardingThemePicker(''), false);
});

// ── looksLikeOnboardingSecurityStep ─────────────────────────────────────────
//
// CC source: src/components/PressEnterToContinue.tsx
// Renders: "Press Enter to continue…" (Enter is bold; … is U+2026)
// Appears at the bottom of the security-notes step in Onboarding.tsx.

const SECURITY_STEP_SIMPLE =
  '\x1b[1m Security notes:\x1b[0m\r\n' +
  '  1. Claude can make mistakes\r\n' +
  '  2. Due to prompt injection risks, only use it with code you trust\r\n' +
  '\x1b[32m Press \x1b[1mEnter\x1b[0m\x1b[32m to continue…\x1b[0m';

// "Press Enter to continue…" with CC's cursor-right letter-splitting.
const SECURITY_STEP_CURSOR_SPLIT =
  'P\x1b[1Cr\x1b[1Ce\x1b[1Cs\x1b[1Cs\x1b[1C ' +
  '\x1b[1CE\x1b[1Cn\x1b[1Ct\x1b[1Ce\x1b[1Cr\x1b[1C ' +
  '\x1b[1Ct\x1b[1Co\x1b[1C ' +
  '\x1b[1Cc\x1b[1Co\x1b[1Cn\x1b[1Ct\x1b[1Ci\x1b[1Cn\x1b[1Cu\x1b[1Ce…';

test('security-step: fires on full buffer with PressEnterToContinue', () => {
  assert.equal(looksLikeOnboardingSecurityStep(SECURITY_STEP_SIMPLE), true);
});

test('security-step: fires when phrase is cursor-right split', () => {
  assert.equal(looksLikeOnboardingSecurityStep(SECURITY_STEP_CURSOR_SPLIT), true);
});

test('security-step: fires on bare "Press Enter to continue…" phrase', () => {
  assert.equal(
    looksLikeOnboardingSecurityStep('Press Enter to continue…'),
    true,
  );
});

test('security-step: does not fire on resume-cost dialog ("Enter to confirm", not "press enter to continue")', () => {
  const resume =
    '\x1b[2K This session is 1d 23h old. Resuming the full session will consume…\r\n' +
    '\x1b[36m❯\x1b[0m 1. Resume\x1b[1Cfrom\x1b[1Csummary (recommended)\r\n' +
    'Enter to confirm · Esc to cancel';
  assert.equal(looksLikeOnboardingSecurityStep(resume), false);
});

test('security-step: does not fire on trust dialog', () => {
  const trust =
    'Quick safety check\r\n Is this a project you created or downloaded?\r\n' +
    ' 1. Yes, I trust this folder\r\n' +
    'Enter to confirm · Esc to cancel';
  assert.equal(looksLikeOnboardingSecurityStep(trust), false);
});

test('security-step: does not fire on theme-picker buffer', () => {
  assert.equal(looksLikeOnboardingSecurityStep(THEME_PICKER_SIMPLE), false);
});

test('security-step: does not fire on output with "enter" but not the full phrase', () => {
  const chat = 'Tip: Press any key or run claude --resume to continue a session.';
  assert.equal(looksLikeOnboardingSecurityStep(chat), false);
});

test('security-step: does not fire on empty buffer', () => {
  assert.equal(looksLikeOnboardingSecurityStep(''), false);
});

// ── looksLikeBypassPermissionsDialog ────────────────────────────────────────
//
// CC source: src/components/BypassPermissionsModeDialog.tsx (CC ≥2.1.170)
// Dialog title: "WARNING: Claude Code running in Bypass Permissions mode"
// Select options: "1. No, exit" (pre-selected) / "2. Yes, I accept"

const BYPASS_DIALOG_SIMPLE =
  '\x1b[31m WARNING: Claude Code running in Bypass Permissions mode\x1b[0m\r\n' +
  ' In Bypass Permissions mode, Claude Code will not ask for your approval\r\n' +
  ' before running potentially dangerous commands.\r\n' +
  '  \x1b[36m❯\x1b[0m 1. No, exit\r\n' +
  '    2. Yes, I accept\r\n';

// Title with CC's cursor-right letter-splitting quirk.
const BYPASS_DIALOG_CURSOR_SPLIT =
  'B\x1b[1Cy\x1b[1Cp\x1b[1Ca\x1b[1Cs\x1b[1Cs\x1b[1C \x1b[1CP\x1b[1Ce\x1b[1Cr' +
  '\x1b[1Cm\x1b[1Ci\x1b[1Cs\x1b[1Cs\x1b[1Ci\x1b[1Co\x1b[1Cn\x1b[1Cs\x1b[1C ' +
  '\x1b[1Cm\x1b[1Co\x1b[1Cd\x1b[1Ce\r\n' +
  '2. Y\x1b[1Ce\x1b[1Cs\x1b[1C,\x1b[1C \x1b[1CI\x1b[1C \x1b[1Ca\x1b[1Cc\x1b[1Cc\x1b[1Ce\x1b[1Cp\x1b[1Ct';

test('bypass-dialog: fires on full buffer', () => {
  assert.equal(looksLikeBypassPermissionsDialog(BYPASS_DIALOG_SIMPLE), true);
});

test('bypass-dialog: fires when phrases are cursor-right split', () => {
  assert.equal(looksLikeBypassPermissionsDialog(BYPASS_DIALOG_CURSOR_SPLIT), true);
});

test('bypass-dialog: needs BOTH title and accept option (title alone is chat-mentionable)', () => {
  assert.equal(
    looksLikeBypassPermissionsDialog('Running in Bypass Permissions mode today.'),
    false,
  );
  assert.equal(looksLikeBypassPermissionsDialog('Yes, I accept the plan.'), false);
});

test('bypass-dialog: does not fire on trust dialog', () => {
  const trust =
    'Quick safety check\r\n Is this a project you created or downloaded?\r\n' +
    ' 1. Yes, I trust this folder\r\n' +
    'Enter to confirm · Esc to cancel';
  assert.equal(looksLikeBypassPermissionsDialog(trust), false);
});

test('bypass-dialog: does not fire on theme-picker or empty buffer', () => {
  assert.equal(looksLikeBypassPermissionsDialog(THEME_PICKER_SIMPLE), false);
  assert.equal(looksLikeBypassPermissionsDialog(''), false);
});
