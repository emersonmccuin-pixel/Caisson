// Unit tests for the ancestor-walk fix in fs-browse.ts
//
// The bug: browseFolder used to throw 'not_found' when the requested path
// didn't exist on disk (e.g. ~/Projects on a fresh Mac). The fix walks up
// to the nearest existing ancestor — so the picker never dead-ends.
//
// These tests use a real temporary directory tree to exercise the real code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { browseFolder } from '../src/services/fs-browse.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'pc-fsbrowse-ancestor-'));
// Always clean up after tests.
process.on('exit', () => { try { rmSync(tmpRoot, { recursive: true }); } catch { /* ignore */ } });

test('browseFolder falls back to existing ancestor when path does not exist', () => {
  // tmpRoot exists; tmpRoot/nonexistent does not.
  const nonexistent = join(tmpRoot, 'nonexistent', 'deeply', 'nested');
  const result = browseFolder(nonexistent, { homeDir: tmpRoot });
  // Should land at tmpRoot (the nearest existing ancestor) rather than throwing.
  assert.equal(result.path, tmpRoot);
});

test('browseFolder returns the actual dir when it exists', () => {
  const subDir = join(tmpRoot, 'actual-dir');
  mkdirSync(subDir, { recursive: true });
  const result = browseFolder(subDir, { homeDir: tmpRoot });
  assert.equal(result.path, subDir);
});

test('browseFolder with nonexistent gated path walks back to gate root', () => {
  // Create a gate root but not the requested subdirectory.
  const gateRoot = join(tmpRoot, 'projects');
  mkdirSync(gateRoot, { recursive: true });
  const nonexistent = join(gateRoot, 'does-not-exist');
  const result = browseFolder(nonexistent, { homeDir: tmpRoot, roots: [gateRoot] });
  // Should land at gateRoot, not below or above it.
  assert.equal(result.path, gateRoot);
});

test('browseFolder returns entries when landing at an existing ancestor', () => {
  // tmpRoot has at least one child (the 'actual-dir' we created above + projects).
  const nonexistent = join(tmpRoot, 'ghost-path');
  const result = browseFolder(nonexistent, { homeDir: tmpRoot });
  // entries is an array (may be empty or populated — just must not throw).
  assert.ok(Array.isArray(result.entries));
});

test('browseFolder still 403s for paths outside the gate root', () => {
  const gateRoot = join(tmpRoot, 'projects');
  mkdirSync(gateRoot, { recursive: true });
  // tmpRoot itself is above gateRoot — must be forbidden.
  assert.throws(
    () => browseFolder(tmpRoot, { homeDir: tmpRoot, roots: [gateRoot] }),
    /not inside the allowed root/,
  );
});
