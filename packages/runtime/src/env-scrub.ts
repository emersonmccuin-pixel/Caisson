// claude.exe v2+ detects IDE-embedded mode from env vars set by the host
// (VS Code, JetBrains, or a parent claude.exe). When PC spawns a child
// claude.exe from a parent process with any of these set — most commonly a
// developer running `pnpm dev` from inside a Claude-Code-driven terminal —
// the child inherits them, tries to attach to the parent's IPC channel
// (which doesn't exist for it), prints "Visual Studio Code disconnected",
// and silently discards the first user prompt. PC is the host; spawned
// claude.exes are tools, not peers. Scrub all IDE-integration markers
// before pty.spawn.
//
// Mirrors labs/agent-system/support/env-scrub.mjs + the production
// pty-session.ts:33 set. Single source of truth for the rebuild.

export const IDE_INTEGRATION_ENV_KEYS: ReadonlySet<string> = new Set([
  // VS Code terminal integration
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'VSCODE_PID',
  'VSCODE_CWD',
  'VSCODE_IPC_HOOK',
  'VSCODE_IPC_HOOK_CLI',
  'VSCODE_IPC_HOOK_EXTHOST',
  'VSCODE_INJECTION',
  'VSCODE_NLS_CONFIG',
  'VSCODE_NONCE',
  'VSCODE_GIT_ASKPASS_MAIN',
  'VSCODE_GIT_ASKPASS_NODE',
  'VSCODE_GIT_ASKPASS_EXTRA_ARGS',
  'VSCODE_GIT_IPC_HANDLE',
  'GIT_ASKPASS',
  // Parent claude.exe handoff — these signal "I'm a child of another CC".
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_NO_FLICKER',
]);

export function scrubIdeEnv(
  env: Record<string, string | undefined>,
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (IDE_INTEGRATION_ENV_KEYS.has(k)) continue;
    out[k] = v;
  }
  // Default to low-ANSI output for non-terminal consumers. Interactive xterm
  // sessions can override this through `extra` after the IDE scrub completes.
  out.FORCE_COLOR = '0';
  // FD-22 — spawned claude.exes must never self-update; PC pins the tested
  // version and bumps it deliberately. CC honors this env var natively.
  out.DISABLE_AUTOUPDATER = '1';
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
