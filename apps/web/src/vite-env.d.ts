/// <reference types="vite/client" />

// Desktop shell bridge exposed by apps/desktop/src/preload.ts. Only present
// when PC runs inside the Caisson Electron shell; `undefined` in a browser.
interface DesktopUpdateState {
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
}

interface PcDesktopBridge {
  isDesktop: true;
  platform: string;
  /** Open the native OS folder chooser. Returns the chosen path, or null if cancelled. */
  chooseFolder(): Promise<string | null>;
  updates: {
    getState(): Promise<DesktopUpdateState>;
    check(): Promise<DesktopUpdateState>;
    download(): Promise<DesktopUpdateState>;
    install(): Promise<boolean>;
    getBetaOptIn(): Promise<boolean>;
    setBetaOptIn(enabled: boolean): Promise<boolean>;
    subscribe(cb: (state: DesktopUpdateState) => void): () => void;
  };
}

interface Window {
  pcDesktop?: PcDesktopBridge;
}
