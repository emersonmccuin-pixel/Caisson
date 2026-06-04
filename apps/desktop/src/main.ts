// Electron main process — Caisson desktop shell.
//
// ONE RUNTIME (Step 7, supervisor-build-scope-2026-06-03): the app boots
// exactly one way, always — Electron main is THE supervisor. It spawns the
// API and the agent host as supervised child processes (respawn-with-backoff,
// crash budget, sentinel-75 restart) and loads the window from one configured
// URL. There is no dev/packaged fork of this tree — anything that could
// differ (entry paths, the node binary, data dir, ports, window URL) is an
// INPUT resolved once in resolveStackConfig(), never a code branch. Dev
// tooling (scripts/dev-app.mjs) feeds different inputs; it cannot change the
// shape of the boot.
//
// ☠ Step 7 demolition: `startInProcessServer` (the packaged in-process API
// import) and the packaged one-shot host spawn are DELETED — an API crash no
// longer takes the window with it, and a dead host respawns instead of
// logging.

import { app, BrowserWindow, dialog, Menu, shell, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import {
  Supervisor,
  SupervisedChild,
  waitForFreshFile,
  waitForPortsBound,
  waitForPortsFree,
  type ExitInfo,
} from '@pc/supervisor';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  packagedAgentHostLockFilePath,
  removePackagedAgentHostLockFile,
  requestPackagedAgentHostShutdown,
} from './agent-host-process';
import { findPortConflicts, freeCaissonPorts, type PortConflict } from './port-conflict';

// Cosmetic-only dev labeling (window title / icon / app id) so a dev instance
// is visually distinct from the packaged app. It gates NOTHING about boot.
const DEV_LABEL = process.env.PC_DESKTOP_DEV === '1';
const APP_NAME = DEV_LABEL ? 'Caisson Dev' : 'Caisson';
const APP_ID = DEV_LABEL ? 'com.projectcompanion.app.dev' : 'com.projectcompanion.app';

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

// ── Stack config — the ONLY place launch inputs are read ────────────────────
// Defaults are the packaged layout (electron-builder `extraResources`); dev
// tooling overrides via env. One value → one code path.

interface StackConfig {
  port: number;
  dataDir: string;
  /** API server bundle the api child runs (`node <apiEntry>`). */
  apiEntry: string;
  /** Agent host bundle the host child runs. */
  hostEntry: string;
  /** Node binary for both children. Packaged default: this executable via
   *  ELECTRON_RUN_AS_NODE (natives staged for Electron's ABI); dev passes the
   *  system node (repo natives are Node-ABI). */
  childNode: string;
  /** PC_ROOT for the children — anchors the server's resource layout
   *  (apps/web/dist, templates, packages/mcp/dist). null = unset: the dev
   *  bundle derives the trunk from its own location, which also keeps the
   *  server's /api/dev/* controls enabled (their dev heuristic is "no
   *  PC_ROOT"). */
  childPcRoot: string | null;
  /** The pinned, app-bundled Claude CLI — only if it exists on disk. */
  bundledClaudeExe: string | null;
  windowUrl: string;
}

function resolveStackConfig(): StackConfig {
  const port = Number(process.env.PORT ?? 4040);
  const envDataDir = process.env.PC_DATA_DIR;
  const dataDir = envDataDir && envDataDir !== 'undefined' ? envDataDir : app.getPath('userData');
  const packagedRoot = join(process.resourcesPath, 'pcserver');
  const apiEntry = process.env.PC_API_ENTRY ?? join(packagedRoot, 'server.mjs');
  const hostEntry = process.env.PC_HOST_ENTRY ?? join(packagedRoot, 'agent-host.mjs');
  const childPcRoot =
    process.env.PC_ROOT ?? (process.env.PC_API_ENTRY ? null : packagedRoot);
  const claudeCandidate =
    process.env.PC_BUNDLED_CLAUDE_EXE ??
    join(process.resourcesPath, 'claude', process.platform === 'win32' ? 'claude.exe' : 'claude');
  return {
    port,
    dataDir,
    apiEntry,
    hostEntry,
    childNode: process.env.PC_CHILD_NODE ?? process.execPath,
    childPcRoot,
    bundledClaudeExe: existsSync(claudeCandidate) ? claudeCandidate : null,
    windowUrl: process.env.PC_DESKTOP_URL ?? `http://127.0.0.1:${port}`,
  };
}

let mainWindow: BrowserWindow | null = null;
let supervisor: Supervisor | null = null;
let quitting = false;
let windowUrl = '';

// ── Supervisor wiring ────────────────────────────────────────────────────────

let childrenLogPath: string | null = null;

function initChildrenLog(dataDir: string): void {
  try {
    const dir = join(dataDir, 'diagnostics');
    mkdirSync(dir, { recursive: true });
    childrenLogPath = join(dir, 'children.log');
    writeFileSync(childrenLogPath, `# supervised children — ${APP_NAME} — session ${new Date().toISOString()}\n`);
  } catch {
    childrenLogPath = null; // best-effort; never blocks boot
  }
}

function supervisorLog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  if (childrenLogPath) {
    try {
      appendFileSync(childrenLogPath, `${line}\n`);
    } catch {
      /* best-effort */
    }
  }
}

function teeChildOutput(name: string) {
  return (_stream: 'stdout' | 'stderr', chunk: Buffer): void => {
    process.stdout.write(chunk);
    if (childrenLogPath) {
      try {
        appendFileSync(childrenLogPath, chunk);
      } catch {
        /* best-effort */
      }
    }
    void name;
  };
}

function onChildGiveUp(info: ExitInfo): void {
  // Crash budget exhausted — the app can't run without either child. Be loud,
  // point at the log, and close. Never a silent dead service.
  dialog.showErrorBox(
    'Caisson keeps crashing',
    `Caisson's background service ("${info.name}") crashed repeatedly and could not be recovered ` +
      `(last exit code ${info.code ?? 'none'}).\n\n` +
      (childrenLogPath ? `Details: ${childrenLogPath}\n\n` : '') +
      `Caisson will close. If this keeps happening, restart your computer or reinstall Caisson.`,
  );
  supervisor?.stopAll();
  quitting = true;
  app.quit();
}

function buildSupervisor(config: StackConfig): Supervisor {
  const lockFilePath = packagedAgentHostLockFilePath(config.dataDir);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1', // harmless under plain node; required under the app exe
    PC_DATA_DIR: config.dataDir,
    PORT: String(config.port),
    PC_AGENT_HOST_LOCK_FILE: lockFilePath,
  };
  if (config.childPcRoot) childEnv.PC_ROOT = config.childPcRoot;
  else delete childEnv.PC_ROOT;
  if (config.bundledClaudeExe) childEnv.PC_BUNDLED_CLAUDE_EXE = config.bundledClaudeExe;

  let hostSpawnedAt = 0;
  const host = new SupervisedChild({
    spec: {
      name: 'agent-host',
      command: config.childNode,
      args: ['--report-on-fatalerror', config.hostEntry, '--http-lock-file', lockFilePath],
      cwd: dirname(config.hostEntry),
      env: childEnv,
    },
    deps: { log: supervisorLog },
    hooks: {
      // A stale lock from a dead host must never count as ready.
      preSpawn: async () => {
        removePackagedAgentHostLockFile(lockFilePath);
        hostSpawnedAt = Date.now();
      },
      onReady: () =>
        waitForFreshFile(lockFilePath, { notBefore: hostSpawnedAt, timeoutMs: 10_000 }),
      onOutput: teeChildOutput('agent-host'),
      onGiveUp: onChildGiveUp,
      // Polite stop: HTTP `shutdown host-exit` lets the host tear down its PTY
      // children instead of orphaning them; a failed ask falls back to the
      // signal, and stopAndWait's deadline escalates to SIGKILL.
      requestStop: () => requestPackagedAgentHostShutdown({ lockFilePath }),
    },
  });

  const api = new SupervisedChild({
    spec: {
      name: 'api',
      command: config.childNode,
      args: ['--report-on-fatalerror', config.apiEntry],
      cwd: dirname(config.apiEntry),
      env: childEnv,
    },
    // exit 75 = intentional restart (POST /api/dev/restart) — never a crash.
    policy: { sentinelRestartCode: 75 },
    deps: { log: supervisorLog },
    hooks: {
      // Don't bind until the previous process has released the port.
      preSpawn: async () => {
        await waitForPortsFree([config.port], { timeoutMs: 12_000 });
      },
      onOutput: teeChildOutput('api'),
      onGiveUp: onChildGiveUp,
    },
  });

  // Host first: its lock file is on disk before the API boots and connects.
  return new Supervisor({ children: [host, api], deps: { log: supervisorLog } });
}

// ── Port-conflict guard (one path — runs before every boot) ─────────────────

function describeConflict(c: PortConflict): string {
  if (c.isCaisson) {
    return `  • port ${c.port} — another Caisson/dev process (PID ${c.pid})`;
  }
  const who = c.pid ? `${c.name} (PID ${c.pid})` : 'an unknown process';
  return `  • port ${c.port} — ${who}`;
}

/** Detect port conflicts, offer to free Caisson-owned offenders, then start
 *  the supervised stack and wait for the API to answer. False = user quit. */
async function bootSupervisedStack(config: StackConfig): Promise<boolean> {
  const ports = [config.port];

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const conflicts = await findPortConflicts(ports);
    if (conflicts.length === 0) break;

    const freeable = conflicts.some((c) => c.isCaisson);
    const buttons = freeable ? ['Free ports & retry', 'Quit'] : ['Retry', 'Quit'];
    const detail =
      `Caisson needs port ${ports.join(' and ')}, but it's already in use:\n\n` +
      conflicts.map(describeConflict).join('\n') +
      (freeable
        ? `\n\nThis is usually another Caisson window or a running dev stack. ` +
          `"Free ports & retry" will close those Caisson processes and start up.`
        : `\n\nClose whatever is using these ports, then click Retry.`);

    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Caisson can’t start',
      message: 'Another program is using Caisson’s ports.',
      detail,
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      noLink: true,
    });

    if (response === buttons.length - 1) return false; // Quit
    if (freeable && response === 0) {
      const result = await freeCaissonPorts(ports);
      console.log(
        `[boot] freed ${result.killed.length} process(es): ${result.killed.map((k) => k.pid).join(', ')}`,
      );
      await new Promise((r) => setTimeout(r, 1500)); // let the OS release the sockets
    }
  }

  const remaining = await findPortConflicts(ports);
  if (remaining.length > 0) {
    dialog.showErrorBox(
      'Caisson can’t start',
      `These ports are still in use:\n\n` +
        remaining.map(describeConflict).join('\n') +
        `\n\nClose the program using them and launch Caisson again.`,
    );
    return false;
  }

  supervisor = buildSupervisor(config);
  await supervisor.start();

  // Positive receipt: the window is only worth opening once the API answers.
  // (First boot runs migrations/seeds — give it a generous deadline.)
  const apiUp = await waitForPortsBound([config.port], {
    timeoutMs: 60_000,
    shouldAbort: () => quitting,
  });
  if (!apiUp && !quitting) {
    dialog.showErrorBox(
      'Caisson failed to start',
      `The background service did not come up within 60 seconds.\n\n` +
        (childrenLogPath ? `Details: ${childrenLogPath}\n\n` : '') +
        `If this keeps happening, restart your computer or reinstall Caisson.`,
    );
    return false;
  }
  return true;
}

// ── Auto-update (electron-updater → public GitHub Releases feed) ───────────
// The renderer is PC's web bundle and can't touch `autoUpdater` directly, so
// the main process owns the update lifecycle and mirrors a single state object
// to the UI over IPC (`pc:update-state`). Only meaningful in a packaged build
// (feed/signing exist); otherwise the status stays `unsupported` and every IPC
// verb short-circuits.

type UpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  percent: number | null;
  error: string | null;
  checkedAt: number | null;
}

let updateState: UpdateState = {
  status: app.isPackaged ? 'idle' : 'unsupported',
  currentVersion: app.getVersion(),
  availableVersion: null,
  percent: null,
  error: null,
  checkedAt: null,
};

function pushUpdateState(patch: Partial<UpdateState>): void {
  updateState = { ...updateState, ...patch };
  mainWindow?.webContents.send('pc:update-state', updateState);
}

function updaterEnabled(): boolean {
  return app.isPackaged;
}

function initAutoUpdater(): void {
  if (!updaterEnabled()) return;
  // User-driven: the UI explicitly downloads and installs. We still install a
  // staged update on the next quit so a downloaded-but-not-clicked update isn't
  // lost.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () =>
    pushUpdateState({ status: 'checking', error: null }),
  );
  autoUpdater.on('update-available', (info) =>
    pushUpdateState({
      status: 'available',
      availableVersion: info.version,
      checkedAt: Date.now(),
    }),
  );
  autoUpdater.on('update-not-available', () =>
    pushUpdateState({ status: 'not-available', availableVersion: null, checkedAt: Date.now() }),
  );
  autoUpdater.on('download-progress', (p) =>
    pushUpdateState({ status: 'downloading', percent: Math.round(p.percent) }),
  );
  autoUpdater.on('update-downloaded', (info) =>
    pushUpdateState({ status: 'downloaded', availableVersion: info.version, percent: 100 }),
  );
  autoUpdater.on('error', (err) =>
    pushUpdateState({ status: 'error', error: err == null ? 'unknown error' : err.message }),
  );
}

ipcMain.handle('pc:update:get-state', () => updateState);

ipcMain.handle('pc:update:check', async () => {
  if (!updaterEnabled()) return updateState;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    pushUpdateState({ status: 'error', error: (err as Error).message });
  }
  return updateState;
});

ipcMain.handle('pc:update:download', async () => {
  if (!updaterEnabled() || updateState.status !== 'available') return updateState;
  try {
    pushUpdateState({ status: 'downloading', percent: 0 });
    await autoUpdater.downloadUpdate();
  } catch (err) {
    pushUpdateState({ status: 'error', error: (err as Error).message });
  }
  return updateState;
});

ipcMain.handle('pc:update:install', () => {
  if (!updaterEnabled() || updateState.status !== 'downloaded') return false;
  // Reply to this IPC call first, then quit-and-install on the next tick.
  setImmediate(() => autoUpdater.quitAndInstall());
  return true;
});

// ── Renderer diagnostics ───────────────────────────────────────────────────
// Mirror the renderer's console + crash/freeze signals to a file so they can be
// read outside DevTools (e.g. to debug a UI freeze where the page stops
// responding to clicks). Best-effort; never throws into the boot path.
// Fresh per window launch (truncated on createWindow).

function resolveDiagnosticsDir(): string {
  const envDir = process.env.PC_DATA_DIR;
  if (envDir && envDir !== 'undefined') return join(envDir, 'diagnostics');
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return join(dir, 'data', 'diagnostics');
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return app.getPath('logs');
}

function setupRendererDiagnostics(win: BrowserWindow): void {
  let logPath: string;
  try {
    const dir = resolveDiagnosticsDir();
    mkdirSync(dir, { recursive: true });
    logPath = join(dir, 'renderer-console.log');
    writeFileSync(logPath, `# renderer console — ${APP_NAME} — session ${new Date().toISOString()}\n`);
    // eslint-disable-next-line no-console
    console.log(`[diagnostics] renderer console → ${logPath}`);
  } catch {
    return; // diagnostics are best-effort; a write failure must not break boot
  }
  const write = (entry: Record<string, unknown>): void => {
    try {
      appendFileSync(logPath, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);
    } catch {
      /* ignore */
    }
  };
  win.webContents.on('console-message', (details) => {
    write({
      kind: 'console',
      level: details.level,
      message: details.message,
      source: `${details.sourceId}:${details.lineNumber}`,
    });
  });
  // The freeze signal: Electron fires 'unresponsive' when the renderer stops
  // pumping its event loop (the exact "clicks do nothing" symptom).
  win.on('unresponsive', () => write({ kind: 'unresponsive', message: 'renderer stopped responding' }));
  win.on('responsive', () => write({ kind: 'responsive', message: 'renderer recovered' }));
  win.webContents.on('render-process-gone', (_event, gone) => {
    write({ kind: 'render-process-gone', reason: gone.reason, exitCode: gone.exitCode });
  });
}

async function createWindow(url: string): Promise<void> {
  const windowIcon = join(__dirname, '..', 'build', DEV_LABEL ? 'icon-dev.png' : 'icon.png');

  // No native File/Edit/View/Window menu — PC's chrome is the web UI. Removing
  // the application menu also drops its default accelerators; copy/paste/etc.
  // still work via Chromium's built-in editing handling in the renderer.
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    icon: windowIcon,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow?.setTitle(APP_NAME);
  });

  // Reload affordances. The app menu is nulled (above) which also drops the
  // default Ctrl+R / F5 accelerators, leaving no way to refresh the renderer.
  // Add them back via raw key input plus a right-click context menu.
  const { webContents } = mainWindow;
  setupRendererDiagnostics(mainWindow);
  webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    // DevTools: F12 or Ctrl/Cmd+Shift+I (the menu is nulled, so bind raw input).
    if (key === 'f12' || ((input.control || input.meta) && input.shift && key === 'i')) {
      webContents.toggleDevTools();
      return;
    }
    const isReload = key === 'f5' || (input.control && key === 'r');
    if (!isReload) return;
    if (input.shift) webContents.reloadIgnoringCache();
    else webContents.reload();
  });
  webContents.on('context-menu', () => {
    Menu.buildFromTemplate([
      { label: 'Reload', click: () => webContents.reload() },
      { label: 'Force Reload', click: () => webContents.reloadIgnoringCache() },
      { type: 'separator' },
      { label: 'Toggle DevTools', click: () => webContents.toggleDevTools() },
    ]).popup({ window: mainWindow ?? undefined });
  });

  // External links open in the system browser, not a new Electron window
  // (the OAuth login flow during onboarding relies on this — Phase 2).
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(url);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

void app.whenReady().then(async () => {
  const config = resolveStackConfig();
  windowUrl = config.windowUrl;
  initChildrenLog(config.dataDir);

  try {
    const booted = await bootSupervisedStack(config);
    if (!booted) {
      quitting = true;
      supervisor?.stopAll();
      app.quit();
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox(
      'Caisson failed to start',
      `Something went wrong while starting up:\n\n${message}\n\n` +
        `If this keeps happening, restart your computer or reinstall Caisson.`,
    );
    quitting = true;
    supervisor?.stopAll();
    app.quit();
    return;
  }
  initAutoUpdater();
  await createWindow(windowUrl);

  // Background check on launch so the "update ready" banner can appear without
  // the user opening settings. Errors (offline, no release yet) are non-fatal.
  if (updaterEnabled()) {
    autoUpdater
      .checkForUpdates()
      .catch((err) => pushUpdateState({ status: 'error', error: (err as Error).message }));
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow(windowUrl);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ONE quit path: ask the supervisor to stop everything (host gets its polite
// HTTP shutdown; stragglers are SIGKILLed at the deadline), then really quit.
app.on('before-quit', (event) => {
  if (quitting || !supervisor) return;
  event.preventDefault();
  quitting = true;
  void supervisor.stopAndWait('SIGINT', 5_000).finally(() => app.quit());
});
