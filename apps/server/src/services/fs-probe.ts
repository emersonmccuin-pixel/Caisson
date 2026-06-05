// Filesystem probe for the create-project UI. The folder picker calls this
// once the user has chosen a target dir; the response drives the preview
// ("empty folder — will git init here." vs "12 files, no .git — will commit
// as Initial import then add scaffold.") and the default mode selection.
//
// `hasFiles` ignores `.git` so an existing PC-scaffolded folder still reports
// as non-empty for its real content. `isGitRepo` is true iff `<path>/.git`
// exists as a dir (or file, for worktree-attached layouts).

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface FolderProbeResult {
  /** Absolute path that was probed (after ~ expansion). */
  path: string;
  exists: boolean;
  isDirectory: boolean;
  /** Has at least one non-`.git` entry. False for empty / non-existent dirs. */
  hasFiles: boolean;
  /** Count of entries excluding `.git`. 0 for empty / non-existent dirs. */
  fileCount: number;
  /** Whether `<path>/.git` is present (dir or file). */
  isGitRepo: boolean;
  /** Whether `<path>/.mcp.json` already exists. Informational only; PC no
   *  longer writes or owns project-root MCP config. */
  hasMcpJson: boolean;
}

export function probeFolder(input: string): FolderProbeResult {
  const expanded = expandHome(input);
  if (!isAbsolute(expanded)) {
    throw new Error(`path must be absolute (got: ${JSON.stringify(input)})`);
  }
  const path = resolve(expanded);

  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      isDirectory: false,
      hasFiles: false,
      fileCount: 0,
      isGitRepo: false,
      hasMcpJson: false,
    };
  }

  const st = statSync(path);
  if (!st.isDirectory()) {
    return {
      path,
      exists: true,
      isDirectory: false,
      hasFiles: false,
      fileCount: 0,
      isGitRepo: false,
      hasMcpJson: false,
    };
  }

  const entries = readdirSync(path).filter((f) => f !== '.git');
  const isGitRepo = existsSync(join(path, '.git'));
  const hasMcpJson = existsSync(join(path, '.mcp.json'));
  return {
    path,
    exists: true,
    isDirectory: true,
    hasFiles: entries.length > 0,
    fileCount: entries.length,
    isGitRepo,
    hasMcpJson,
  };
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return join(homedir(), p.slice(2));
  }
  return p;
}
