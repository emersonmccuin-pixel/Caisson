// Pin detection of CC's resume-cost dialog so a future CC wording change can't
// silently break the auto-"resume from summary" press in low-level-spawn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeResumeSummaryDialog } from '../src/low-level-spawn.ts';

// Captured verbatim from a real resumed orchestrator session's transcript.log
// (caisson project, 130.7k-token / ~2-day-old chat). Letters/words are split
// by cursor-right escapes exactly as CC paints them — the detector must still
// fire.
const REAL_DIALOG_RAW =
  '\x1b[2K This session is 1d 23h old and 130.7k tokens. Resuming the full ' +
  'session will consume a substantial portion of your usage limits. We ' +
  'recommend resuming from a summary.\r\n' +
  '\x1b[36m❯\x1b[0m 1. Resume\x1b[1Cfrom\x1b[1Csummary (recommended)\r\n' +
  '  2. Resume full session as-is\r\n' +
  "  3. Don't ask me again\r\n" +
  'Enter to confirm · Esc to cancel';

test('fires on the real resume-cost dialog', () => {
  assert.equal(looksLikeResumeSummaryDialog(REAL_DIALOG_RAW), true);
});

test('fires even when CC splits the matched phrase with cursor-right escapes', () => {
  // "Resuming the full session" painted with cursor-rights between letters/words.
  const split = 'R\x1b[1Cesuming\x1b[1Cthe\x1b[1Cfull\x1b[1Csession will consume…';
  assert.equal(looksLikeResumeSummaryDialog(split), true);
});

test('does not fire on the trust dialog', () => {
  const trust =
    'Quick safety check\r\n Is this a project you created or downloaded?\r\n' +
    ' 1. Yes, I trust this folder';
  assert.equal(looksLikeResumeSummaryDialog(trust), false);
});

test('does not fire on ordinary chat output mentioning resume', () => {
  const chat = 'Tip: Run claude --continue or claude --resume to resume a conversation';
  assert.equal(looksLikeResumeSummaryDialog(chat), false);
});

test('does not fire on an empty buffer', () => {
  assert.equal(looksLikeResumeSummaryDialog(''), false);
});
