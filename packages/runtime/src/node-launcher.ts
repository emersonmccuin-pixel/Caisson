// Section 10 Phase 1.4 — how to launch a Node script in the current runtime.
//
// PC's per-session `.claude/settings.json` bakes a node command into every
// hook entry (event-capture, path-guard, ask-intercept, statusline). That
// worked under tsx dev (system `node` on PATH), but a packaged Electron app
// runs on machines with NO system node — so claude.exe's attempt to run those
// hooks would fail silently and PC would lose event capture + path isolation.
//
// Electron ships a Node runtime inside its own binary, re-entered via the
// ELECTRON_RUN_AS_NODE=1 env var. The api/host bundle-children already run AS
// the app executable under that flag (apps/desktop main.ts childEnv), so for
// them `process.execPath` IS the app binary — but `process.versions.electron`
// is absent in that mode, which is why detection must also look at the env.
//
// Resolution order:
//   PC_NODE_LAUNCHER env override  → that command, no extra env (tests / unusual setups)
//   running inside Electron proper → process.execPath + { ELECTRON_RUN_AS_NODE: '1' }
//   ELECTRON_RUN_AS_NODE in env    → process.execPath + { ELECTRON_RUN_AS_NODE: '1' }
//     (bundle-child: execPath is the app exe — or plain node under dev, where
//      the flag is harmless)
//   otherwise (tsx dev / Node)     → process.execPath, no extra env (this
//     process IS a node runtime; absolute path beats PATH lookup)

export interface NodeLauncher {
  /** Executable that runs a Node script: the system node binary under dev;
   *  the app binary in a packaged Electron build. Always an absolute path
   *  unless overridden via PC_NODE_LAUNCHER. */
  command: string;
  /** Env that MUST be present for `command` to run in Node mode. Empty under
   *  dev; `{ ELECTRON_RUN_AS_NODE: '1' }` when `command` is an Electron
   *  binary. Callers embedding the command in a POSIX shell line (CC hooks
   *  run via bash on every platform) can inline it as a `VAR=1` prefix. */
  env: Record<string, string>;
}

/** Resolve the node launcher for the current process. Args are injectable so
 *  unit tests can exercise the packaged branches without an Electron runtime. */
export function resolveNodeLauncher(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  isElectron: boolean = Boolean(process.versions.electron),
): NodeLauncher {
  const override = env.PC_NODE_LAUNCHER?.trim();
  if (override) return { command: override, env: {} };
  if (isElectron || env.ELECTRON_RUN_AS_NODE) {
    return { command: execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  return { command: execPath, env: {} };
}

/** The node command as a POSIX shell prefix for CC hook lines — quoted, and
 *  with the Electron-as-node env var inlined when required. CC runs hook
 *  commands via bash on every platform (Git Bash on Windows), so the `VAR=1`
 *  prefix form is always valid. Backslashes are normalized to forward slashes
 *  (node accepts them on Windows) so the result embeds safely in JSON. */
export function nodeShellCommand(launcher: NodeLauncher = resolveNodeLauncher()): string {
  const exe = launcher.command.replace(/\\/g, '/');
  const prefix = launcher.env.ELECTRON_RUN_AS_NODE ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
  return `${prefix}"${exe}"`;
}
