// Tests for the BuildMarker pure view logic (build-marker-view.ts).
// The web runner is tsx --test (no jsdom) — React rendering is not available.
// We test the REAL parseBuildMarker export from the shipped module so any
// signature change or logic regression fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseBuildMarker } from '../src/features/system/build-marker-view.ts';

test('parseBuildMarker: no buildSha → null', () => {
  assert.equal(parseBuildMarker({}), null);
});

test('parseBuildMarker: null buildSha → null', () => {
  assert.equal(parseBuildMarker({ buildSha: null }), null);
});

test('parseBuildMarker: empty string buildSha → null', () => {
  assert.equal(parseBuildMarker({ buildSha: '' }), null);
});

test('parseBuildMarker: sha only, no branch → view with empty branch', () => {
  const v = parseBuildMarker({ buildSha: 'abc1234' });
  assert.ok(v);
  assert.equal(v.sha, 'abc1234');
  assert.equal(v.branch, '');
});

test('parseBuildMarker: sha + branch → full view', () => {
  const v = parseBuildMarker({ buildSha: 'abc1234', buildBranch: 'dev' });
  assert.ok(v);
  assert.equal(v.sha, 'abc1234');
  assert.equal(v.branch, 'dev');
});

test('parseBuildMarker: null branch → empty string', () => {
  const v = parseBuildMarker({ buildSha: 'abc1234', buildBranch: null });
  assert.ok(v);
  assert.equal(v.branch, '');
});
