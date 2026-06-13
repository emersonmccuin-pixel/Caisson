// Shared "Fullsize" affordance for modals. A single sticky preference
// (localStorage) so once the user expands one modal, every modal that opts in
// opens full-window until they collapse it again.
//
// Usage in a modal:
//   const { full, toggle, panelSizeClass } = useFullsizeModal();
//   <div className={`...base panel classes... ${panelSizeClass(collapsed, full)}`}>
//     <header>... <FullsizeButton full={full} onToggle={toggle} /> ...</header>
//
// `panelSizeClass(normal, fullOverride?)` returns the size utilities to splice
// into a panel's className: the modal's normal sizing when collapsed, and a
// full-window sizing when expanded.

import { useCallback, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';

const STORAGE_KEY = 'pc:modal-fullsize';

/** Tailwind utilities that make a panel fill the app window. */
export const FULLSIZE_PANEL_CLASS = 'h-screen w-screen max-w-none rounded-none';

function readPref(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export interface FullsizeModalState {
  /** Whether modals should currently render full-window. */
  full: boolean;
  /** Flip the sticky preference. */
  toggle: () => void;
  /**
   * Compose a panel's size classes. Pass the modal's normal (collapsed) size
   * utilities; when `full` is set they're replaced with the full-window set.
   */
  panelSizeClass: (normal: string) => string;
}

export function useFullsizeModal(): FullsizeModalState {
  const [full, setFull] = useState<boolean>(readPref);

  const toggle = useCallback(() => {
    setFull((f) => {
      const next = !f;
      try {
        localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
      } catch {
        /* ignore — preference is best-effort */
      }
      return next;
    });
  }, []);

  const panelSizeClass = useCallback(
    (normal: string) => (full ? FULLSIZE_PANEL_CLASS : normal),
    [full],
  );

  return { full, toggle, panelSizeClass };
}

export function FullsizeButton({
  full,
  onToggle,
  className,
}: {
  full: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={
        'text-muted-foreground hover:text-foreground ' + (className ?? '')
      }
      title={full ? 'Exit full size' : 'Full size'}
      aria-label={full ? 'Exit full size' : 'Full size'}
    >
      {full ? (
        <Minimize2 className="h-4 w-4" />
      ) : (
        <Maximize2 className="h-4 w-4" />
      )}
    </button>
  );
}
