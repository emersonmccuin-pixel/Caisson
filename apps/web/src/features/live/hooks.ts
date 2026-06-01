export const PROJECT_CHANGED_CURSOR_STORAGE_KEY = 'pc.live.projectChanged.cursor';

export interface CursorStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export function readStoredProjectChangedCursor(
  storage: CursorStorageLike | null = browserStorage(),
): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(PROJECT_CHANGED_CURSOR_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeStoredProjectChangedCursor(
  cursor: string | null,
  storage: CursorStorageLike | null = browserStorage(),
): void {
  if (!cursor || !storage) return;
  try {
    storage.setItem(PROJECT_CHANGED_CURSOR_STORAGE_KEY, cursor);
  } catch {
    /* best-effort */
  }
}

function browserStorage(): CursorStorageLike | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

// ── Slice 015a — generic live-event cursor (the global `seq`) ──────────────
//
// Per-scope cursor: the max `seq` (the global gapless outbox cursor — NOT the
// per-entity `version`) this client has applied for a given scope. The WS
// subscribe handshake sends this as `lastVersion` on (re)connect so the server
// replays `(lastVersion, snapshot]`. A per-project key scopes the per-project
// socket; the `__global__` key scopes the cold/global cursor.

const LIVE_CURSOR_KEY_PREFIX = 'pc.live.cursor.';
const GLOBAL_CURSOR_SCOPE = '__global__';

function liveCursorKey(scope: string): string {
  return `${LIVE_CURSOR_KEY_PREFIX}${scope}`;
}

export function readLiveCursor(
  scope: string,
  storage: CursorStorageLike | null = browserStorage(),
): string | undefined {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(liveCursorKey(scope));
    return raw && /^(0|[1-9]\d*)$/.test(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Advance the stored cursor to `cursor` only if it is strictly greater (the
 *  `seq` stream is monotonic; never move the cursor backwards). */
export function advanceLiveCursor(
  scope: string,
  cursor: string | null | undefined,
  storage: CursorStorageLike | null = browserStorage(),
): void {
  if (!cursor || !storage || !/^(0|[1-9]\d*)$/.test(cursor)) return;
  try {
    const current = storage.getItem(liveCursorKey(scope));
    if (current && Number(current) >= Number(cursor)) return;
    storage.setItem(liveCursorKey(scope), cursor);
  } catch {
    /* best-effort */
  }
}

/** Drop the cursor after a `resetRequired`/`live-reset` gap so the next
 *  (re)connect cold-loads HTTP truth instead of replaying a stale window. */
export function clearLiveCursor(
  scope: string,
  storage: CursorStorageLike | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem?.(liveCursorKey(scope));
  } catch {
    /* best-effort */
  }
}

export function liveCursorScopeForProject(projectId: string): string {
  return projectId;
}

export const LIVE_CURSOR_GLOBAL_SCOPE = GLOBAL_CURSOR_SCOPE;
