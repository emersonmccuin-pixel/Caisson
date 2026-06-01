import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  collapseDiff,
  computeLineDiff,
  diffStats,
} from '../src/features/chat/lineDiff.ts';

test('empty old + non-empty new → all adds', () => {
  const lines = computeLineDiff('', 'a\nb\nc');
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => l.type === 'add'));
  const adds = lines.filter((l) => l.type === 'add');
  assert.deepEqual(
    adds.map((l) => ('newLineNo' in l ? l.newLineNo : -1)),
    [1, 2, 3],
  );
});

test('non-empty old + empty new → all removes', () => {
  const lines = computeLineDiff('x\ny', '');
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.type === 'remove'));
});

test('identical text → all context', () => {
  const txt = 'foo\nbar\nbaz';
  const lines = computeLineDiff(txt, txt);
  assert.ok(lines.every((l) => l.type === 'context'));
  assert.equal(lines.length, 3);
});

test('both empty → empty diff', () => {
  assert.deepEqual(computeLineDiff('', ''), []);
});

test('single-line change produces remove + add', () => {
  const lines = computeLineDiff('hello', 'world');
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.type, 'remove');
  assert.equal(lines[1]!.type, 'add');
});

test('middle-line substitution preserves surrounding context', () => {
  const old = 'a\nb\nc';
  const newText = 'a\nx\nc';
  const lines = computeLineDiff(old, newText);
  assert.equal(lines[0]!.type, 'context');
  assert.equal(lines[1]!.type, 'remove');
  assert.equal(lines[2]!.type, 'add');
  assert.equal(lines[3]!.type, 'context');
});

test('diffStats counts correctly', () => {
  const old = 'a\nb\nc';
  const newText = 'a\nx\ny\nc';
  const lines = computeLineDiff(old, newText);
  const stats = diffStats(lines);
  assert.equal(stats.removed, 1);
  assert.equal(stats.added, 2);
});

test('collapseDiff collapses long unchanged runs', () => {
  // 10 context lines, no changes → should collapse entirely
  const txt = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
  const lines = computeLineDiff(txt, txt);
  const collapsed = collapseDiff(lines, 3);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0]!.type, 'collapse');
  if (collapsed[0]!.type === 'collapse') {
    assert.equal(collapsed[0]!.count, 10);
  }
});

test('collapseDiff keeps context around changes', () => {
  // 10 context lines then a change then 10 more context lines
  const oldLines = Array.from({ length: 10 }, (_, i) => `line${i}`);
  const newLines = [...oldLines];
  oldLines.push('OLD');
  newLines.push('NEW');
  for (let i = 0; i < 10; i++) {
    oldLines.push(`after${i}`);
    newLines.push(`after${i}`);
  }
  const lines = computeLineDiff(oldLines.join('\n'), newLines.join('\n'));
  const collapsed = collapseDiff(lines, 3);

  // Should have: collapse(7) + 3 context + remove + add + 3 context + collapse(7)
  const types = collapsed.map((r) => r.type);
  assert.ok(types.includes('collapse'), 'should have at least one collapse row');
  assert.ok(types.includes('remove'), 'should have remove');
  assert.ok(types.includes('add'), 'should have add');
  assert.ok(types.includes('context'), 'should have context');
});
