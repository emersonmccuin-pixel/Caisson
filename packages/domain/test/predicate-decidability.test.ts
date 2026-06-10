// Guardrail (Slice 1): every AcceptancePredicateKind must be classified in
// PREDICATE_DECIDABILITY. Adding a new predicate kind without classifying it
// causes this test to fail — the intended canary.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCEPTANCE_PREDICATE_KINDS,
  PREDICATE_DECIDABILITY,
  isDecidablePredicate,
} from '../src/contract.ts';

test('PREDICATE_DECIDABILITY covers every kind in ACCEPTANCE_PREDICATE_KINDS exactly once', () => {
  // Every kind must have an entry.
  for (const kind of ACCEPTANCE_PREDICATE_KINDS) {
    assert.ok(kind in PREDICATE_DECIDABILITY, `'${kind}' missing from PREDICATE_DECIDABILITY`);
  }
  // No orphan keys — every key must be a known kind.
  for (const key of Object.keys(PREDICATE_DECIDABILITY)) {
    assert.ok(
      (ACCEPTANCE_PREDICATE_KINDS as readonly string[]).includes(key),
      `orphan key '${key}' in PREDICATE_DECIDABILITY`,
    );
  }
  assert.equal(
    Object.keys(PREDICATE_DECIDABILITY).length,
    ACCEPTANCE_PREDICATE_KINDS.length,
    'key count must equal kind count',
  );
});

test('every classification value is "decidable" or "judgment"', () => {
  for (const [kind, cls] of Object.entries(PREDICATE_DECIDABILITY)) {
    assert.ok(
      cls === 'decidable' || cls === 'judgment',
      `'${kind}' has invalid classification '${cls as string}'`,
    );
  }
});

test('all current kinds classify as decidable', () => {
  for (const kind of ACCEPTANCE_PREDICATE_KINDS) {
    assert.equal(PREDICATE_DECIDABILITY[kind], 'decidable', `'${kind}' must be 'decidable'`);
  }
});

test('isDecidablePredicate returns true for all current kinds', () => {
  for (const kind of ACCEPTANCE_PREDICATE_KINDS) {
    assert.equal(isDecidablePredicate(kind), true, `isDecidablePredicate('${kind}') must be true`);
  }
});

test('report_contains and body_contains are decidable (syntactic matchers — auto-emit removed, not the kind)', () => {
  // These kinds remain valid for orchestrator-authored literal assertions.
  // Slice 2 only removes AUTO-DERIVING them from semantic fields (must_address / sections).
  assert.equal(isDecidablePredicate('report_contains'), true);
  assert.equal(isDecidablePredicate('body_contains'), true);
});
