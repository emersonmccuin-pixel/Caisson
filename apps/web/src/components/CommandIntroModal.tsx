// One-time explainer modal for the Command space. Shows the first time a user
// navigates to Command (when commandIntroDismissed is false). A "Don't show
// this again" checkbox controls whether dismissal is permanent — if checked,
// the modal PATCHes commandIntroDismissed=true so it never shows again.

import { useEffect, useState } from 'react';

interface CommandIntroModalProps {
  onClose: (dismissed: boolean) => void;
}

export function CommandIntroModal({ onClose }: CommandIntroModalProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose(dontShowAgain);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dontShowAgain, onClose]);

  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-black/40"
      onClick={() => onClose(dontShowAgain)}
    >
      <div
        className="flex w-[520px] flex-col border border-border bg-card text-foreground"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold">
            Command — your cross-project planning space
          </h2>
          <button
            type="button"
            onClick={() => onClose(dontShowAgain)}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="flex flex-col gap-4 px-4 py-4">
          <p className="text-sm leading-relaxed text-foreground/90">
            Command sits above all your projects — one place to step back and
            decide what matters most across everything you're juggling. Use it
            to star the work you want to focus on (it surfaces at the top of
            each project), capture cross-cutting to-dos that don't belong to
            any single project, and plan across the whole picture. Open a
            project to do the actual work; come to Command to steer.
          </p>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
            />
            <span>Don't show this again</span>
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={() => onClose(dontShowAgain)}
            className="bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
