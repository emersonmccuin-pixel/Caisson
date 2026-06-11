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

import { app, BrowserWindow, dialog, Menu, shell, ipcMain, safeStorage } from 'electron';
import { autoUpdater } from 'electron-updater';
import {
  Supervisor,
  SupervisedChild,
  waitForFreshFile,
  waitForPortsBound,
  waitForPortsFree,
  type ExitInfo,
} from '@pc/supervisor';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  packagedAgentHostLockFilePath,
  reapStaleAgentHost,
  requestPackagedAgentHostShutdown,
} from './agent-host-process';
import { findPortConflicts, freeCaissonPorts, type PortConflict } from './port-conflict';

// Cosmetic-only dev labeling (window title / icon / app id) so a dev instance
// is visually distinct from the packaged app. It gates NOTHING about boot.
const DEV_LABEL = process.env.PC_DESKTOP_DEV === '1';
// Optional explicit label (e.g. "Staging") so a second non-packaged instance
// gets its OWN Electron profile + single-instance lock + taskbar identity
// instead of colliding with a plain dev instance (which is also DEV_LABEL).
// Absent: dev instances are "Caisson Dev"; the packaged app is "Caisson".
const APP_LABEL = process.env.PC_APP_LABEL?.trim() || (DEV_LABEL ? 'Dev' : '');
const APP_NAME = APP_LABEL ? `Caisson ${APP_LABEL}` : 'Caisson';
const APP_ID = APP_LABEL
  ? `com.projectcompanion.app.${APP_LABEL.toLowerCase().replace(/[^a-z0-9]/g, '')}`
  : 'com.projectcompanion.app';

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

// ── Vault master-key lifecycle ────────────────────────────────────────────────
//
// The master key is a random 32-byte value that lives ONLY in memory (and in
// the encrypted-at-rest copy below). It is NEVER stored in an environment
// variable or passed via the command line — both are visible to process
// listings, crash dumps, and inheriting child processes.
//
// Primary path (Windows/macOS and most Linux with a keyring):
//   safeStorage.encryptString(base64(key)) → saved to userData/vault-master-key.enc
//   safeStorage.decryptString(bytes) → raw key on every boot
//
// Fallback (keyring-less Linux, safeStorage.isEncryptionAvailable() === false):
//   key stored as hex in userData/vault-master-key.raw with 0600 permissions
//   A 'less protected' warning is emitted to the supervisor log.
//
// The raw key is handed to the API child via a private stdin pipe (one-shot
// JSON init message). See `buildSupervisor` below.

const VAULT_KEY_ENC_FILE = 'vault-master-key.enc';
const VAULT_KEY_RAW_FILE = 'vault-master-key.raw';

interface MasterKeyResult {
  key: Buffer;
  /** True when safeStorage was unavailable and the key file uses 0600 perms
   *  instead of OS-level keychain encryption. */
  lessProtected: boolean;
}

function loadOrCreateMasterKey(dataDir: string): MasterKeyResult {
  if (safeStorage.isEncryptionAvailable()) {
    const keyFile = join(dataDir, VAULT_KEY_ENC_FILE);
    try {
      const encrypted = readFileSync(keyFile); // returns Buffer
      const b64 = safeStorage.decryptString(encrypted);
      return { key: Buffer.from(b64, 'base64'), lessProtected: false };
    } catch {
      // First boot or corrupted file — regenerate.
      const key = randomBytes(32);
      const encrypted = safeStorage.encryptString(key.toString('base64'));
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(keyFile, encrypted);
      return { key, lessProtected: false };
    }
  } else {
    // Fallback: hex text file, chmod 0600 for Unix protection.
    const keyFile = join(dataDir, VAULT_KEY_RAW_FILE);
    try {
      const hex = readFileSync(keyFile, 'utf8').trim();
      return { key: Buffer.from(hex, 'hex'), lessProtected: true };
    } catch {
      const key = randomBytes(32);
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(keyFile, key.toString('hex'), 'utf8');
      try { chmodSync(keyFile, 0o600); } catch { /* best-effort on non-Unix */ }
      return { key, lessProtected: true };
    }
  }
}

// ── Supervisor wiring ────────────────────────────────────────────────────────

let childrenLogPath: string | null = null;
/** The stack's resolved data dir — set once in whenReady so every diagnostics
 *  writer (children.log, renderer-console.log) shares one home. */
let resolvedDataDir: string | null = null;

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

function buildSupervisor(config: StackConfig, masterKey: Buffer): Supervisor {
  const lockFilePath = packagedAgentHostLockFilePath(config.dataDir);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1', // harmless under plain node; required under the app exe
    PC_DATA_DIR: config.dataDir,
    PORT: String(config.port),
    PC_AGENT_HOST_LOCK_FILE: lockFilePath,
    // Signal to the API server that it should read the vault master key from
    // stdin. The key itself travels over the stdin pipe (never an env var).
    PC_VAULT_USE_STDIN: '1',
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
      // A stale lock from a dead host must never count as ready — and a stale
      // lock from a LIVE host (Electron hard-killed last run; the host's port
      // is random, so the port guard can't see it) is an orphan to reap, not
      // just a file to delete. reapStaleAgentHost verifies the pid's command
      // line, stops it (polite HTTP, then tree-kill), and removes the lock.
      preSpawn: async () => {
        await reapStaleAgentHost(lockFilePath, { log: supervisorLog });
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
      // stdin = pipe so we can write the vault master key as a one-shot init
      // message. The child reads it synchronously at boot then stdin closes.
      stdio: ['pipe', 'pipe', 'pipe'],
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
      // Secure master-key handoff: write ONE JSON line to stdin and close it.
      // stdin is a private OS pipe — not visible in process listings, env dumps,
      // or /proc/<pid>/environ. The child reads it before HTTP listen starts.
      // Fires on every (re)spawn so sentinel-75 restarts receive the key too.
      onSpawn: (child) => {
        const initMsg =
          JSON.stringify({ type: 'vault-init', masterKey: masterKey.toString('hex') }) + '\n';
        child.stdin?.write(initMsg, (err) => {
          if (err) {
            supervisorLog(`[api] vault-init stdin write failed: ${err.message}`);
          }
          child.stdin?.end();
        });
      },
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
async function bootSupervisedStack(config: StackConfig, masterKey: Buffer): Promise<boolean> {
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

  supervisor = buildSupervisor(config, masterKey);
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
//
// Beta channel: users opt in via a persisted JSON pref (update-prefs.json in
// userData). When enabled, autoUpdater.channel='beta' so the updater checks
// beta.yml instead of latest.yml. Beta users still receive stable releases
// because stable is the lower channel.

// ── Beta opt-in persistence ───────────────────────────────────────────────

const UPDATE_PREFS_FILENAME = 'update-prefs.json';

interface UpdatePrefs {
  betaOptIn: boolean;
}

function readUpdatePrefs(dataDir: string): UpdatePrefs {
  try {
    const raw = readFileSync(join(dataDir, UPDATE_PREFS_FILENAME), 'utf8');
    const parsed = JSON.parse(raw) as Partial<UpdatePrefs>;
    return { betaOptIn: parsed.betaOptIn === true };
  } catch {
    return { betaOptIn: false };
  }
}

function writeUpdatePrefs(dataDir: string, prefs: UpdatePrefs): void {
  try {
    writeFileSync(join(dataDir, UPDATE_PREFS_FILENAME), JSON.stringify(prefs, null, 2));
  } catch {
    /* best-effort */
  }
}

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

  // Apply persisted beta-channel preference before the first check.
  // allowPrerelease must be set alongside channel: without it the GitHub provider
  // only scans non-prerelease releases and never finds the prerelease's beta.yml.
  if (resolvedDataDir) {
    const { betaOptIn } = readUpdatePrefs(resolvedDataDir);
    autoUpdater.allowPrerelease = betaOptIn;
    if (betaOptIn) autoUpdater.channel = 'beta';
  }

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

// Beta opt-in: get/set the persisted preference and apply the channel live.
ipcMain.handle('pc:update:getBetaOptIn', () => {
  const dataDir = resolvedDataDir ?? app.getPath('userData');
  return readUpdatePrefs(dataDir).betaOptIn;
});

ipcMain.handle('pc:update:setBetaOptIn', (_event, enabled: unknown) => {
  const dataDir = resolvedDataDir ?? app.getPath('userData');
  const betaOptIn = enabled === true;
  writeUpdatePrefs(dataDir, { betaOptIn });
  if (updaterEnabled()) {
    autoUpdater.channel = betaOptIn ? 'beta' : 'latest';
    autoUpdater.allowPrerelease = betaOptIn;
    autoUpdater
      .checkForUpdates()
      .catch((err) => pushUpdateState({ status: 'error', error: (err as Error).message }));
  }
  return betaOptIn;
});

// Native OS folder chooser — used by the onboarding wizard (and future pickers)
// so desktop users get the familiar system dialog instead of the custom browser
// picker. Returns the chosen absolute path, or null if the user cancelled.
ipcMain.handle('pc:choose-folder', async (): Promise<string | null> => {
  const options = {
    properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    title: 'Choose projects folder',
  };
  // mainWindow can be gone by the time the handler fires — fall back to the
  // detached dialog instead of crashing the IPC call.
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0] ?? null;
});

ipcMain.handle('pc:update:install', async () => {
  if (!updaterEnabled() || updateState.status !== 'downloaded') return false;
  // The supervised api + agent-host run AS Caisson.exe (ELECTRON_RUN_AS_NODE),
  // so while they're alive the NSIS installer's "is the app running?" check
  // finds them and shows "Caisson cannot be closed." quitAndInstall fires the
  // installer immediately and only then quits us, racing our async teardown —
  // the installer wins and sees live children. Fix: tear the whole stack down
  // and WAIT for every child to exit BEFORE the handoff, so the installer's
  // check finds nothing. teardownChildren sets `quitting`, so the subsequent
  // app.quit() inside quitAndInstall passes straight through before-quit.
  await teardownChildren();
  autoUpdater.quitAndInstall();
  return true;
});

// ── Renderer diagnostics ───────────────────────────────────────────────────
// Mirror the renderer's console + crash/freeze signals to a file so they can be
// read outside DevTools (e.g. to debug a UI freeze where the page stops
// responding to clicks). Best-effort; never throws into the boot path.
// Fresh per window launch (truncated on createWindow).

function resolveDiagnosticsDir(): string {
  // ONE diagnostics home: <dataDir>/diagnostics — the same folder children.log
  // uses (initChildrenLog), so a post-mortem reads one directory. dataDir is
  // resolved once in resolveStackConfig(); the fallback below only covers a
  // window created before whenReady (not a real path today).
  if (resolvedDataDir) return join(resolvedDataDir, 'diagnostics');
  const envDir = process.env.PC_DATA_DIR;
  if (envDir && envDir !== 'undefined') return join(envDir, 'diagnostics');
  return join(app.getPath('userData'), 'diagnostics');
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
  resolvedDataDir = config.dataDir;
  initChildrenLog(config.dataDir);

  // Load (or generate on first boot) the vault master key.
  // safeStorage requires app.whenReady(); this is the earliest safe call site.
  let masterKey: Buffer;
  try {
    const result = loadOrCreateMasterKey(config.dataDir);
    masterKey = result.key;
    if (result.lessProtected) {
      supervisorLog(
        '[vault] WARNING: safeStorage is unavailable — vault master key is stored in a ' +
          '0600-perms file instead of the OS keychain. Credentials are less protected.',
      );
    } else {
      supervisorLog('[vault] master key loaded from safeStorage');
    }
  } catch (err) {
    dialog.showErrorBox(
      "Caisson can't start",
      `Failed to load the secure credential vault key:\n\n${(err as Error).message}\n\n` +
        `If this keeps happening, restart your computer or reinstall Caisson.`,
    );
    quitting = true;
    app.quit();
    return;
  }

  try {
    const booted = await bootSupervisedStack(config, masterKey);
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

// ONE teardown, awaited everywhere. Stops every supervised child (host gets its
// polite HTTP shutdown so its claude.exe PTYs go down with it; stragglers are
// SIGKILLed at the deadline) and resolves only once they've actually exited.
// Idempotent: concurrent callers (before-quit + the update-install handoff)
// share the same promise, and `quitting` makes the eventual app.quit() a no-op
// in before-quit. The await matters for updates — the NSIS installer must not
// run its "app still running" check while a Caisson.exe child is alive.
let teardownPromise: Promise<void> | null = null;
function teardownChildren(): Promise<void> {
  if (teardownPromise) return teardownPromise;
  quitting = true;
  teardownPromise = supervisor
    ? supervisor.stopAndWait('SIGINT', 5_000).then(() => undefined)
    : Promise.resolve();
  return teardownPromise;
}

app.on('before-quit', (event) => {
  if (quitting || !supervisor) return;
  event.preventDefault();
  void teardownChildren().finally(() => app.quit());
});
