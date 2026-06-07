// Folder browser for the create-project picker UI. Lists one directory at a
// time so the UI can drill into subfolders. Default landing path is the
// user's home dir.
//
// Gating model (D81 refined): callers decide the scope.
//  - When `roots` is omitted, any absolute existing directory is browsable.
//    Used by the AppSettingsModal picker that sets the projectsFolder global
//    setting itself — needs unrestricted roaming.
//  - When `roots` is provided, paths must sit inside one of them. Used by
//    the CreateProjectModal picker (gate root = the global projectsFolder)
//    so new projects live inside the user's declared Projects folder.
//
// `~` expands to the user's home for ergonomic typed-path entry. `parent` is
// null when at the filesystem root OR at the gate root (whichever is higher)
// — stops the picker from walking past the gate.

import { existsSync, mkdirSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

export interface BrowseEntry {
  name: string;
  /** Absolute path. */
  path: string;
  isDirectory: boolean;
  /** True iff the name starts with a `.`. Hidden entries are still listed —
   *  the UI decides whether to show them. */
  isHidden: boolean;
}

export interface BrowseResult {
  /** Absolute path that was listed (after ~ expansion + normalize). */
  path: string;
  /** Parent path, or null when at the filesystem root / gate root. */
  parent: string | null;
  /** Sorted dirs-first, then files; case-insensitive within each group. */
  entries: BrowseEntry[];
}

export interface BrowseOptions {
  /** Override the user's home dir (test seam). */
  homeDir?: string;
  /** When set, restricts browsing to within these absolute paths. Paths
   *  outside any root are 403'd. When omitted, no restriction applies. */
  roots?: string[];
}

/** List the directory at `input` (defaults to ~/ or the first gate root). */
export function browseFolder(input: string | null | undefined, opts: BrowseOptions = {}): BrowseResult {
  const home = opts.homeDir ?? homedir();
  const gateRoots = (opts.roots ?? []).map((r) => resolve(r));
  const fallbackLanding = gateRoots[0] ?? home;

  const raw = (input ?? '').trim();
  const expanded = raw ? expandHome(raw, home) : fallbackLanding;
  if (!isAbsolute(expanded)) {
    throw new BrowseError(`path must be absolute (got: ${JSON.stringify(input)})`, 'invalid');
  }
  const requested = resolve(expanded);

  if (gateRoots.length > 0 && !isInsideAnyRoot(requested, gateRoots)) {
    throw new BrowseError(`path not inside the allowed root(s): ${requested}`, 'forbidden');
  }

  // Walk up to the nearest existing ancestor — prevents the picker from
  // dead-ending when the stored/seeded path doesn't exist yet (e.g. ~/Projects
  // on a fresh Mac). The ancestor is clamped at the gate root (when set) or
  // the home directory so we never escape the intended scope.
  const path = existingAncestor(requested, gateRoots, home);
  if (!existsSync(path)) {
    // Only reachable if home itself doesn't exist — extremely unlikely.
    throw new BrowseError(`path does not exist: ${requested}`, 'not_found');
  }
  if (!statSync(path).isDirectory()) {
    throw new BrowseError(`path is not a directory: ${path}`, 'not_directory');
  }

  const dirents: Dirent[] = readdirSync(path, { withFileTypes: true });
  const entries: BrowseEntry[] = dirents
    .map((d) => ({
      name: d.name,
      path: join(path, d.name),
      isDirectory: d.isDirectory(),
      isHidden: d.name.startsWith('.'),
    }))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

  const atGateRoot = gateRoots.some((r) => normalize(path) === normalize(r));
  const parentPath = dirname(path);
  const atFsRoot = parentPath === path;
  const parent = atGateRoot || atFsRoot ? null : parentPath;

  return { path, parent, entries };
}

export function createChildFolder(
  parentInput: string | null | undefined,
  nameInput: string | null | undefined,
  opts: BrowseOptions = {},
): BrowseResult {
  const parentView = browseFolder(parentInput, opts);
  const name = (nameInput ?? '').trim();
  if (!name) {
    throw new BrowseError('folder name required', 'invalid');
  }
  if (name === '.' || name === '..') {
    throw new BrowseError(`invalid folder name: ${JSON.stringify(name)}`, 'invalid');
  }
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new BrowseError(`folder name must be a single path segment: ${JSON.stringify(name)}`, 'invalid');
  }

  const target = resolve(parentView.path, name);
  if (normalize(dirname(target)) !== normalize(parentView.path)) {
    throw new BrowseError(`folder name escapes the parent directory: ${JSON.stringify(name)}`, 'invalid');
  }

  const gateRoots = (opts.roots ?? []).map((r) => resolve(r));
  if (gateRoots.length > 0 && !isInsideAnyRoot(target, gateRoots)) {
    throw new BrowseError(`path not inside the allowed root(s): ${target}`, 'forbidden');
  }
  if (existsSync(target)) {
    throw new BrowseError(`path already exists: ${target}`, 'already_exists');
  }

  try {
    mkdirSync(target);
  } catch (err) {
    const code = typeof err === 'object' && err && 'code' in err
      ? String((err as { code?: unknown }).code)
      : '';
    if (code === 'EEXIST') {
      throw new BrowseError(`path already exists: ${target}`, 'already_exists');
    }
    throw new BrowseError(`failed to create folder: ${(err as Error).message}`, 'invalid');
  }
  return browseFolder(target, opts);
}

export type BrowseErrorKind =
  | 'invalid'
  | 'forbidden'
  | 'not_found'
  | 'not_directory'
  | 'already_exists';

export class BrowseError extends Error {
  constructor(message: string, public readonly kind: BrowseErrorKind) {
    super(message);
  }
}

/**
 * Walk up from `path` until we reach an existing directory, stopping no
 * higher than the lowest gate root (or `home` if no gate roots are set).
 * Always returns an absolute path that exists on disk (home is the fallback).
 */
function existingAncestor(path: string, gateRoots: string[], home: string): string {
  const floor = gateRoots.length > 0
    ? gateRoots.reduce((shortest, r) =>
        r.length < shortest.length ? r : shortest,
      )
    : home;

  let current = path;
  while (true) {
    if (existsSync(current) && statSync(current).isDirectory()) return current;
    const parent = dirname(current);
    // At filesystem root or at/below the floor — use the floor itself.
    if (parent === current || normalize(current) === normalize(floor)) {
      return existsSync(floor) ? floor : home;
    }
    // Don't walk past the floor.
    if (floor.length > current.length) {
      return existsSync(floor) ? floor : home;
    }
    current = parent;
  }
}

function isInsideAnyRoot(path: string, roots: string[]): boolean {
  const norm = normalize(path);
  return roots.some((root) => {
    const rNorm = normalize(root);
    return norm === rNorm || norm.startsWith(rNorm + sep);
  });
}

/** Case-fold on Windows for the comparison; preserve case on POSIX. */
function normalize(p: string): string {
  const r = resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2));
  return p;
}

/** Enumerate accessible drive roots so the picker can offer drive-jump
 *  buttons (Windows: `C:\`, `D:\`, …). POSIX: returns `['/']` — single root
 *  means the UI naturally hides the drives row. */
export function listDrives(): string[] {
  if (process.platform !== 'win32') return ['/'];
  const drives: string[] = [];
  for (let c = 65; c <= 90; c++) {
    const letter = String.fromCharCode(c);
    const path = `${letter}:\\`;
    try {
      if (existsSync(path)) drives.push(path);
    } catch {
      /* drive not accessible (e.g. empty floppy) — skip */
    }
  }
  return drives;
}
