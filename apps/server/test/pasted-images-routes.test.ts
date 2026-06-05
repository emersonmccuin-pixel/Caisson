// Unit tests for POST /api/projects/:projectId/pasted-images
//
// Coverage:
//   - valid upload → 200, absolute path, file written to disk
//   - unsupported content-type → 415
//   - body too large → 413
//   - empty body → 400
//   - invalid project id (non-ULID) → 400
//   - unknown project → 404
//   - pruneOldImages: files older than 14 days are deleted; fresh files kept

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Hono } from 'hono';
import {
  registerPastedImageRoutes,
  pruneOldImages,
} from '../src/features/pasted-images/routes.ts';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-pasted-images-test-'));

after(() => rmSync(tmpDir, { recursive: true, force: true }));

const VALID_PROJECT_ID = '01ARYZ6S41TPTWG9VCBZMSBF9X';
const UNKNOWN_PROJECT_ID = '01ARYZ6S41TPTWG9VCBZMSBF9Y';

// Small valid PNG header bytes (sufficient for the route — it doesn't parse the image)
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

function makeApp() {
  const app = new Hono();
  let dataDir = tmpDir;
  registerPastedImageRoutes(app, {
    dataDir,
    getProject: (id) => (id === VALID_PROJECT_ID ? { id } : null),
  });
  return app;
}

// ── validation ───────────────────────────────────────────────────────────────

test('rejects invalid project id (path traversal chars)', async () => {
  const app = makeApp();
  const res = await app.request('/api/projects/../etc/pasted-images', {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: PNG_BYTES,
  });
  assert.equal(res.status, 404); // Hono won't match the route pattern with slashes
});

test('rejects project id with non-alphanumeric chars', async () => {
  const app = makeApp();
  const res = await app.request('/api/projects/bad-id!/pasted-images', {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: PNG_BYTES,
  });
  // Hono will match the :projectId param but validation will reject it
  assert.equal(res.status, 400);
});

test('rejects unknown project with 404', async () => {
  const app = makeApp();
  const res = await app.request(`/api/projects/${UNKNOWN_PROJECT_ID}/pasted-images`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: PNG_BYTES,
  });
  assert.equal(res.status, 404);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.ok(body.error.includes('unknown project'));
});

test('rejects unsupported content-type with 415', async () => {
  const app = makeApp();
  const res = await app.request(`/api/projects/${VALID_PROJECT_ID}/pasted-images`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/bmp' },
    body: PNG_BYTES,
  });
  assert.equal(res.status, 415);
  const body = (await res.json()) as { ok: boolean; error: string };
  assert.equal(body.ok, false);
  assert.ok(body.error.includes('unsupported content-type'));
});

test('rejects empty body with 400', async () => {
  const app = makeApp();
  const res = await app.request(`/api/projects/${VALID_PROJECT_ID}/pasted-images`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: new Uint8Array(0),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { ok: boolean };
  assert.equal(body.ok, false);
});

test('rejects body > 20 MB with 413', async () => {
  const app = makeApp();
  const big = new Uint8Array(20 * 1024 * 1024 + 1);
  const res = await app.request(`/api/projects/${VALID_PROJECT_ID}/pasted-images`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: big,
  });
  assert.equal(res.status, 413);
  const body = (await res.json()) as { ok: boolean };
  assert.equal(body.ok, false);
});

// ── path generation ──────────────────────────────────────────────────────────

test('returns absolute path for png upload and writes the file', async () => {
  const app = makeApp();
  const res = await app.request(`/api/projects/${VALID_PROJECT_ID}/pasted-images`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: PNG_BYTES,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; path: string };
  assert.equal(body.ok, true);
  assert.ok(typeof body.path === 'string', 'path is a string');
  assert.ok(body.path.includes(VALID_PROJECT_ID), 'path includes projectId segment');
  assert.ok(body.path.endsWith('.png'), 'path ends with .png');
  assert.ok(existsSync(body.path), 'file written to disk');
});

test('uses jpg extension for image/jpeg', async () => {
  const app = makeApp();
  const res = await app.request(`/api/projects/${VALID_PROJECT_ID}/pasted-images`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: JPEG_BYTES,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; path: string };
  assert.ok(body.path.endsWith('.jpg'));
});

// ── prune logic ──────────────────────────────────────────────────────────────

test('pruneOldImages removes files older than 14 days and keeps recent ones', async () => {
  const pruneRoot = join(tmpDir, 'prune-test');
  const projectA = join(pruneRoot, VALID_PROJECT_ID);
  mkdirSync(projectA, { recursive: true });

  const oldFile = join(projectA, 'old.png');
  const freshFile = join(projectA, 'fresh.png');
  writeFileSync(oldFile, PNG_BYTES);
  writeFileSync(freshFile, PNG_BYTES);

  // Back-date oldFile to 15 days ago
  const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  utimesSync(oldFile, fifteenDaysAgo, fifteenDaysAgo);

  await pruneOldImages(pruneRoot);

  assert.ok(!existsSync(oldFile), 'file older than 14 days must be deleted');
  assert.ok(existsSync(freshFile), 'recent file must be kept');
});

test('pruneOldImages is a no-op when root does not exist', async () => {
  // Must not throw
  await pruneOldImages(join(tmpDir, 'nonexistent-prune-root'));
});
