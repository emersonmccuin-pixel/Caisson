// Gap B (pc-pty-chat-338) -- unit tests for claude-firstrun-seed.ts
//
// Covers:
//   1. Absent config -- created with the three keys set.
//   2. Existing complete config -- no write (idempotent).
//   3. Partial config (hasCompletedOnboarding missing) -- patched, rest preserved.
//   4. Corrupt / non-JSON config -- treated as fresh (no throw).
//   5. claude --version failure -- seed still succeeds (lastOnboardingVersion omitted).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Each test allocates its own temp dir and restores CLAUDE_CONFIG_DIR afterward.
// Module-level import caching in tsx is per-process, not per-test, so re-importing
// the same module returns the cached module -- resolveClaudeJsonPath() reads
// process.env.CLAUDE_CONFIG_DIR at CALL time (not import time), so env overrides
// work correctly within the test body.

test('absent config: creates file with required keys', async () => {
  const dir = mkdtempSync(join(homedir(), '.cs-a-'));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const { seedClaudeFirstRun, resolveClaudeJsonPath } = await import(
      '../src/services/claude-firstrun-seed.ts'
    );
    const configPath = resolveClaudeJsonPath();
    assert.equal(existsSync(configPath), false, 'precondition: no config yet');

    const result = await seedClaudeFirstRun('nonexistent-claude-xyz');

    assert.equal(result.written, true);
    assert.equal(result.claudeVersion, null, 'version null when exe missing');
    assert.equal(existsSync(result.configPath), true, 'file created');

    const data = JSON.parse(readFileSync(result.configPath, 'utf-8'));
    assert.equal(data.hasCompletedOnboarding, true);
    assert.equal(typeof data.theme, 'string');
    assert.equal('lastOnboardingVersion' in data, false, 'omitted when version unknown');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('existing complete config: no write (idempotent)', async () => {
  const dir = mkdtempSync(join(homedir(), '.cs-b-'));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const { seedClaudeFirstRun, resolveClaudeJsonPath } = await import(
      '../src/services/claude-firstrun-seed.ts'
    );
    const configPath = resolveClaudeJsonPath();
    // hasCompletedOnboarding + theme present; no lastOnboardingVersion ->
    // when claudeVersion=null the alreadyDone check passes.
    const existing = {
      hasCompletedOnboarding: true,
      theme: 'light',
      oauthAccount: { email: 'test@example.com' },
    };
    writeFileSync(configPath, JSON.stringify(existing), 'utf-8');

    const result = await seedClaudeFirstRun('nonexistent-claude-xyz');

    assert.equal(result.written, false, 'no write needed');
    const data = JSON.parse(readFileSync(configPath, 'utf-8'));
    assert.deepEqual(data.oauthAccount, existing.oauthAccount, 'existing keys preserved');
    assert.equal(data.theme, 'light', 'user theme preserved');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('partial config: hasCompletedOnboarding missing -- patched, existing keys preserved', async () => {
  const dir = mkdtempSync(join(homedir(), '.cs-c-'));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const { seedClaudeFirstRun, resolveClaudeJsonPath } = await import(
      '../src/services/claude-firstrun-seed.ts'
    );
    const configPath = resolveClaudeJsonPath();
    const existing = {
      oauthAccount: { email: 'test@example.com' },
      numStartups: 5,
      theme: 'light',
    };
    writeFileSync(configPath, JSON.stringify(existing), 'utf-8');

    const result = await seedClaudeFirstRun('nonexistent-claude-xyz');

    assert.equal(result.written, true, 'file patched');
    const data = JSON.parse(readFileSync(result.configPath, 'utf-8'));
    assert.equal(data.hasCompletedOnboarding, true);
    assert.equal(data.theme, 'light', 'user theme not overwritten');
    assert.deepEqual(data.oauthAccount, existing.oauthAccount, 'oauthAccount preserved');
    assert.equal(data.numStartups, 5, 'other keys preserved');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('corrupt/non-JSON config: treated as fresh, no throw', async () => {
  const dir = mkdtempSync(join(homedir(), '.cs-d-'));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const { seedClaudeFirstRun, resolveClaudeJsonPath } = await import(
      '../src/services/claude-firstrun-seed.ts'
    );
    const configPath = resolveClaudeJsonPath();
    writeFileSync(configPath, '{ this is not json !!!', 'utf-8');

    const result = await seedClaudeFirstRun('nonexistent-claude-xyz');

    assert.equal(result.written, true, 'fresh config written over corrupt file');
    const data = JSON.parse(readFileSync(result.configPath, 'utf-8'));
    assert.equal(data.hasCompletedOnboarding, true);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claude version lookup fails: seed completes, lastOnboardingVersion omitted', async () => {
  const dir = mkdtempSync(join(homedir(), '.cs-e-'));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const { seedClaudeFirstRun } = await import('../src/services/claude-firstrun-seed.ts');

    const result = await seedClaudeFirstRun('totally-nonexistent-binary-xyz');

    assert.equal(result.written, true);
    assert.equal(result.claudeVersion, null);
    const data = JSON.parse(readFileSync(result.configPath, 'utf-8'));
    assert.equal(data.hasCompletedOnboarding, true);
    assert.equal('lastOnboardingVersion' in data, false);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
