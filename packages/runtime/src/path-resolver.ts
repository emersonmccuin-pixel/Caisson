// Single source of truth for CC JSONL paths.
//
// Honors CLAUDE_CONFIG_DIR (claude.exe respects it; PC code historically did
// not — Section 15 lesson). Every consumer (LowLevelSpawn, retention sweep,
// lab tooling) imports from here. Hardcoding `homedir()` in path-touching
// code is a lint error.
//
// CWD encoding rule pinned against CC source `sessionStoragePortable.ts:311`
// (sanitizePath): EVERY non-alphanumeric byte maps to '-' — dots, underscores,
// spaces, colons, backslashes, all of them. Verified live 2026-06-03 on CC
// 2.1.162: `…\labs\fd2-shared-http-mcp\.work\client-A` →
// `…-labs-fd2-shared-http-mcp--work-client-A` (the '.' became '-'; the old
// keep-[._-] rule computed a path that doesn't exist → tailer goes blind →
// the agent-stall failure class).
//
// ⚠ Divergence we can't reproduce: CC truncates encodings >200 chars and
// appends a Bun.hash (wyhash) suffix. PC workspace paths are far below 200;
// if one ever isn't, transcript discovery breaks — keep workspace roots short.

import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

export function claudeProjectsRoot(): string {
  return join(claudeConfigDir(), 'projects');
}

export function encodeCwdForClaude(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

export function projectDirFor(workspaceAbsPath: string): string {
  return join(claudeProjectsRoot(), encodeCwdForClaude(workspaceAbsPath));
}

export function jsonlPathFor(
  workspaceAbsPath: string,
  ccProviderSessionId: string,
): string {
  return join(projectDirFor(workspaceAbsPath), `${ccProviderSessionId}.jsonl`);
}

/** Inverse for a persisted CC JSONL path.
 *
 * Expected shape:
 *   <CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<session-uuid>.jsonl
 *
 * Resume must launch claude.exe with the same CLAUDE_CONFIG_DIR that produced
 * the transcript. Otherwise a valid persisted session under `.claude-alt`
 * can be resumed by a server currently pointed at `.claude`, and claude.exe
 * exits with "No conversation found with session ID".
 */
export function claudeConfigDirFromJsonlPath(jsonlPath: string): string | null {
  const sessionFile = resolve(jsonlPath);
  const projectDir = dirname(sessionFile);
  const projectsRoot = dirname(projectDir);
  if (basename(projectsRoot) !== 'projects') return null;
  return dirname(projectsRoot);
}
