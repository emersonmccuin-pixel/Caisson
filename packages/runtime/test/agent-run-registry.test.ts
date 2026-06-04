// FD-15 — AgentRunRegistry cap admission + live setMaxConcurrent.
//
// The cap was construction-frozen before FD-15; these tests pin the live
// update semantics: raising admits queued waiters immediately, lowering
// never revokes an admitted slot (over-cap drains on release).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRunRegistry } from '../src/agent-run-registry.ts';

test('admits up to cap, queues the rest FIFO', () => {
  const reg = new AgentRunRegistry({ maxConcurrent: 2 });
  const a = reg.admit();
  const b = reg.admit();
  const c = reg.admit();
  assert.equal(a.state, 'admitted');
  assert.equal(b.state, 'admitted');
  assert.equal(c.state, 'queued');
  assert.equal(reg.getActiveCount(), 2);
  assert.equal(reg.getQueueLength(), 1);

  a.release();
  assert.equal(c.state, 'admitted');
  assert.equal(reg.getQueueLength(), 0);
});

test('setMaxConcurrent raise admits queued waiters immediately', () => {
  const reg = new AgentRunRegistry({ maxConcurrent: 1 });
  const a = reg.admit();
  const b = reg.admit();
  const c = reg.admit();
  assert.equal(b.state, 'queued');
  assert.equal(c.state, 'queued');

  const effective = reg.setMaxConcurrent(3);
  assert.equal(effective, 3);
  assert.equal(reg.getMaxConcurrent(), 3);
  assert.equal(b.state, 'admitted');
  assert.equal(c.state, 'admitted');
  assert.equal(reg.getActiveCount(), 3);
  assert.equal(reg.getQueueLength(), 0);
  a.release();
});

test('setMaxConcurrent lower never revokes admitted runs; over-cap drains on release', () => {
  const reg = new AgentRunRegistry({ maxConcurrent: 3 });
  const a = reg.admit();
  const b = reg.admit();
  const c = reg.admit();
  assert.equal(reg.getActiveCount(), 3);

  reg.setMaxConcurrent(1);
  // All three stay admitted — lowering is non-destructive.
  assert.equal(a.state, 'admitted');
  assert.equal(b.state, 'admitted');
  assert.equal(c.state, 'admitted');
  assert.equal(reg.getActiveCount(), 3);

  // New arrivals queue behind the lowered cap.
  const d = reg.admit();
  assert.equal(d.state, 'queued');

  // Releases drain the over-cap; d only admits once active < cap.
  a.release();
  assert.equal(d.state, 'queued'); // active 2 ≥ cap 1
  b.release();
  assert.equal(d.state, 'queued'); // active 1 ≥ cap 1
  c.release();
  assert.equal(d.state, 'admitted'); // active 0 < cap 1
});

test('setMaxConcurrent clamps to [1, 50] and defaults non-finite to 5', () => {
  const reg = new AgentRunRegistry({ maxConcurrent: 5 });
  assert.equal(reg.setMaxConcurrent(0), 1);
  assert.equal(reg.setMaxConcurrent(99), 50);
  assert.equal(reg.setMaxConcurrent(7.9), 7);
  assert.equal(reg.setMaxConcurrent(Number.NaN), 5);
});

test('aborting a queued ticket frees its FIFO spot without a slot', () => {
  const reg = new AgentRunRegistry({ maxConcurrent: 1 });
  const a = reg.admit();
  const b = reg.admit();
  const c = reg.admit();
  b.abort();
  await_rejection(b);
  a.release();
  assert.equal(c.state, 'admitted');
});

function await_rejection(ticket: { granted: Promise<void> }): void {
  // granted already has an internal .catch; just confirm it rejects.
  ticket.granted.catch(() => {});
}

// Step-4 Slice 1 (G4) — cap-exempt lane for persistent-interactive runs.

test('exempt ticket is born admitted and never counts toward the cap', () => {
  const reg = new AgentRunRegistry({ maxConcurrent: 1 });
  const chat = reg.exempt();
  assert.equal(chat.state, 'admitted');
  assert.equal(reg.getActiveCount(), 0);

  // A worker still gets the one real slot — the chat consumed nothing.
  const worker = reg.admit();
  assert.equal(worker.state, 'admitted');
  assert.equal(reg.getActiveCount(), 1);
});

test('exempt release/abort never touch the slot math', () => {
  const reg = new AgentRunRegistry({ maxConcurrent: 1 });
  const worker = reg.admit();
  const queued = reg.admit();
  assert.equal(queued.state, 'queued');

  const chat = reg.exempt();
  chat.release();
  // Releasing the exempt ticket must NOT admit the queued worker (it never
  // held a slot to free).
  assert.equal(queued.state, 'queued');
  assert.equal(reg.getActiveCount(), 1);

  chat.abort(); // idempotent no-op
  assert.equal(reg.getActiveCount(), 1);
  worker.release();
  assert.equal(queued.state, 'admitted');
});
