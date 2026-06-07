import { useCallback, useState } from 'react';

const DING_STORAGE_KEY = 'pc.notification-ding.v1';

function readDingEnabled(): boolean {
  try {
    const raw = localStorage.getItem(DING_STORAGE_KEY);
    if (raw === null) return true; // default ON
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'enabled' in parsed &&
      typeof (parsed as { enabled: unknown }).enabled === 'boolean'
    ) {
      return (parsed as { enabled: boolean }).enabled;
    }
    return true;
  } catch {
    return true;
  }
}

function writeDingEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(DING_STORAGE_KEY, JSON.stringify({ enabled }));
  } catch {
    /* best-effort */
  }
}

/**
 * Returns `[enabled, setEnabled]` backed by localStorage.
 * Default: true (notification sounds on).
 */
export function useNotificationDingEnabled(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabledState] = useState(readDingEnabled);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    writeDingEnabled(next);
  }, []);

  return [enabled, setEnabled];
}
