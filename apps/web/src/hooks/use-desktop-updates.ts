// Feature-detects the Electron update bridge (window.pcDesktop.updates) and
// mirrors the main process's update state into React. In a browser, or in the
// desktop dev-run where the updater is inert, `isDesktop`/state reflect that so
// the UI can degrade gracefully. All verbs no-op when the bridge is absent.

import { useCallback, useEffect, useState } from 'react';

export interface DesktopUpdates {
  isDesktop: boolean;
  state: DesktopUpdateState | null;
  betaOptIn: boolean | null;
  check: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  setBetaOptIn: (enabled: boolean) => Promise<void>;
}

export function useDesktopUpdates(): DesktopUpdates {
  const bridge = typeof window !== 'undefined' ? window.pcDesktop : undefined;
  const updates = bridge?.updates;
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [betaOptIn, setBetaOptInState] = useState<boolean | null>(null);

  useEffect(() => {
    if (!updates) return;
    let active = true;
    void updates
      .getState()
      .then((s) => {
        if (active) setState(s);
      })
      .catch(() => {});
    void updates
      .getBetaOptIn()
      .then((v) => {
        if (active) setBetaOptInState(v);
      })
      .catch(() => {});
    const unsubscribe = updates.subscribe((s) => setState(s));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [updates]);

  const check = useCallback(async () => {
    if (!updates) return;
    setState(await updates.check());
  }, [updates]);

  const download = useCallback(async () => {
    if (!updates) return;
    setState(await updates.download());
  }, [updates]);

  const install = useCallback(async () => {
    if (!updates) return;
    await updates.install();
  }, [updates]);

  const setBetaOptIn = useCallback(async (enabled: boolean) => {
    if (!updates) return;
    const result = await updates.setBetaOptIn(enabled);
    setBetaOptInState(result);
  }, [updates]);

  return { isDesktop: !!bridge?.isDesktop, state, betaOptIn, check, download, install, setBetaOptIn };
}
