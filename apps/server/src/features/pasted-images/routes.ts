// POST /api/projects/:projectId/pasted-images
//
// Accepts a raw binary image body (Content-Type is the image MIME type). Raw
// binary is cleaner than base64 JSON: the client sends the Blob directly as the
// request body; Hono reads it with c.req.arrayBuffer() — no encoding overhead,
// no extra parsing.
//
// Returns { ok: true, path: <absolute path> } on success. The caller pastes the
// path into their chat input or PTY and Claude reads the image via the Read tool.

import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Hono } from 'hono';
import { getProjectById } from '@pc/db';
import type { ULID } from '@pc/domain';
import { getDataDir } from '@pc/utils';

const ALLOWED_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
// Broad alphanumeric pattern — sufficient for path-safety (no slashes, dots, etc.)
const ULID_RE = /^[A-Z0-9]{26}$/i;

/** Best-effort prune: delete files older than 14 days from the pasted-images
 *  tree. Exported for direct testing; the route calls it fire-and-forget. */
export async function pruneOldImages(root: string): Promise<void> {
  const cutoff = Date.now() - RETENTION_MS;
  try {
    const dirs = await readdir(root);
    await Promise.all(
      dirs.map(async (dir) => {
        try {
          const projectDir = join(root, dir);
          const files = await readdir(projectDir);
          await Promise.all(
            files.map(async (file) => {
              try {
                const p = join(projectDir, file);
                const s = await stat(p);
                if (s.isFile() && s.mtimeMs < cutoff) await rm(p, { force: true });
              } catch { /* best-effort */ }
            }),
          );
        } catch { /* best-effort */ }
      }),
    );
  } catch { /* best-effort: root may not exist yet */ }
}

export interface PastedImageRoutesDeps {
  /** Override the data dir (default: getDataDir()). Used by tests. */
  dataDir?: string;
  /** Override project lookup (default: getProjectById). Used by tests. */
  getProject?: (id: string) => { id: string } | null | undefined;
}

export function registerPastedImageRoutes(app: Hono, deps: PastedImageRoutesDeps = {}): void {
  const getDir = () => deps.dataDir ?? getDataDir();
  const lookupProject = deps.getProject ?? ((id) => getProjectById(id as ULID));
  let prunedOnce = false;

  app.post('/api/projects/:projectId/pasted-images', async (c) => {
    const projectId = c.req.param('projectId');

    // Validate projectId charset (prevents path traversal via directory names)
    if (!ULID_RE.test(projectId)) {
      return c.json({ ok: false, error: 'invalid project id' }, 400);
    }
    if (!lookupProject(projectId)) {
      return c.json({ ok: false, error: `unknown project: ${projectId}` }, 404);
    }

    const ct = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const ext = ALLOWED_TYPES[ct];
    if (!ext) {
      return c.json(
        {
          ok: false,
          error: `unsupported content-type: ${ct || '(none)'}; expected image/png, image/jpeg, image/gif, or image/webp`,
        },
        415,
      );
    }

    const buf = await c.req.arrayBuffer();
    if (buf.byteLength === 0) {
      return c.json({ ok: false, error: 'empty body' }, 400);
    }
    if (buf.byteLength > MAX_SIZE_BYTES) {
      return c.json({ ok: false, error: 'image exceeds 20 MB limit' }, 413);
    }

    const pastedRoot = join(getDir(), 'pasted-images');

    // Best-effort prune on first upload per registered route (i.e. once per
    // server process). Fire-and-forget — never blocks or fails the response.
    if (!prunedOnce) {
      prunedOnce = true;
      void pruneOldImages(pastedRoot);
    }

    const projectDir = join(pastedRoot, projectId);
    await mkdir(projectDir, { recursive: true });
    const rand = Math.random().toString(36).slice(2, 7);
    const filename = `${Date.now()}-${rand}.${ext}`;
    // resolve() ensures an absolute path even if getDir() returns relative
    const filePath = resolve(projectDir, filename);
    await writeFile(filePath, new Uint8Array(buf));

    return c.json({ ok: true, path: filePath });
  });
}
