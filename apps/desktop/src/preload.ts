// Preload — runs with contextIsolation in the renderer's privileged world.
// PC's web bundle talks to the server over HTTP/WS on the same origin, so the
// renderer needs no Node bridge today. We expose a minimal, namespaced surface
// the UI can feature-detect to know it's running inside the desktop shell
// (used by Phase 2's onboarding gate to skip the "you need to install PC"
// framing). Keep this lean — every exposed symbol is attack surface.

import { contextBridge, ipcRenderer } from 'electron';

// Mirror of the main process's UpdateState (kept structurally in sync by hand —
// the two run in separate bundles). The renderer treats it as opaque JSON.
type UpdateState = {
  status:
    | 'unsupported'
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error';
  currentVersion: string;
  availableVersion: string | null;
  percent: number | null;
  error: string | null;
  checkedAt: number | null;
};

const UPDATE_STATE_CHANNEL = 'pc:update-state';

contextBridge.exposeInMainWorld('pcDesktop', {
  isDesktop: true,
  platform: process.platform,
  /** Open the native OS folder chooser. Returns the chosen path, or null if cancelled. */
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('pc:choose-folder'),
  updates: {
    getState: (): Promise<UpdateState> => ipcRenderer.invoke('pc:update:get-state'),
    check: (): Promise<UpdateState> => ipcRenderer.invoke('pc:update:check'),
    download: (): Promise<UpdateState> => ipcRenderer.invoke('pc:update:download'),
    install: (): Promise<boolean> => ipcRenderer.invoke('pc:update:install'),
    // Subscribe to main-process state pushes. Returns an unsubscribe fn.
    subscribe: (cb: (state: UpdateState) => void): (() => void) => {
      const listener = (_event: unknown, state: UpdateState) => cb(state);
      ipcRenderer.on(UPDATE_STATE_CHANNEL, listener);
      return () => ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, listener);
    },
  },
});
