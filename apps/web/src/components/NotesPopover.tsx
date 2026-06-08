// pc-pty-chat-333 — per-project notes scratchpad. Plain-text textarea
// anchored to the Notes button in the slim header. Autosaves on a 500ms
// debounce and on blur/close. Scoped to the active project — switching
// projects loads that project's notes.

import { useCallback, useEffect, useRef, useState } from 'react';

import { projectsApi } from '@/features/projects/client';
import type { ULID } from '@/features/projects/client';

interface NotesPopoverProps {
  projectId: ULID;
  initialNotes: string | null;
  anchorEl: HTMLElement | null;
  onClose: () => void;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function NotesPopover({
  projectId,
  initialNotes,
  anchorEl,
  onClose,
}: NotesPopoverProps) {
  const [text, setText] = useState(initialNotes ?? '');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const savedRef = useRef(text);

  // Reset text when project changes.
  useEffect(() => {
    setText(initialNotes ?? '');
    savedRef.current = initialNotes ?? '';
  }, [projectId, initialNotes]);

  // Reopen-freshness: the initialNotes prop can be stale — a save earlier in
  // this session does NOT refresh the parent's activeProject, so reopening
  // would otherwise paint the pre-save value (looks like data loss on a
  // scratchpad). Fetch the current notes on open and adopt them IF the field
  // is still pristine (never clobber in-progress edits). Falls back silently
  // to the instant-paint initialNotes on fetch failure.
  useEffect(() => {
    let cancelled = false;
    projectsApi
      .project(projectId)
      .then((p) => {
        if (cancelled) return;
        const fresh = p.notes ?? '';
        const prevBaseline = savedRef.current; // capture before mutating
        savedRef.current = fresh;
        setText((current) => (current === prevBaseline ? fresh : current));
      })
      .catch(() => {
        /* keep instant-paint initialNotes */
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const persist = useCallback(
    (value: string) => {
      if (value === savedRef.current) return;
      setSaveState('saving');
      projectsApi
        .updateProjectNotes(projectId, value)
        .then(() => {
          savedRef.current = value;
          setSaveState('saved');
        })
        .catch(() => {
          setSaveState('error');
        });
    },
    [projectId],
  );

  const scheduleAutosave = useCallback(
    (value: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        persist(value);
      }, 500);
    },
    [persist],
  );

  // Click-outside + Escape close with flush save.
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchorEl?.contains(target)) return;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      persist(text);
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
        persist(text);
        onClose();
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorEl, onClose, persist, text]);

  // Flush on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, []);

  const rect = anchorEl?.getBoundingClientRect();
  const style: React.CSSProperties = rect
    ? { position: 'fixed', top: rect.bottom + 4, right: window.innerWidth - rect.right, zIndex: 50 }
    : { display: 'none' };

  return (
    <div
      ref={panelRef}
      data-testid="notes-popover"
      style={style}
      className="w-[320px] border border-primary/40 bg-popover text-popover-foreground shadow-2xl"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
          project notes
        </span>
        <span className="text-[9px] text-muted-foreground/60">
          {saveState === 'saving' && 'saving…'}
          {saveState === 'saved' && 'saved'}
          {saveState === 'error' && 'save failed'}
        </span>
      </div>
      <textarea
        data-testid="notes-textarea"
        value={text}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          setSaveState('idle');
          scheduleAutosave(v);
        }}
        onBlur={() => {
          if (debounceRef.current) {
            clearTimeout(debounceRef.current);
            debounceRef.current = null;
          }
          persist(text);
        }}
        placeholder="Scratch notes for this project…"
        className="h-[200px] w-full resize-none bg-transparent px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
        autoFocus
        spellCheck={false}
      />
    </div>
  );
}
