import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useChatComposerPrefill } from '@/store/chat-composer-prefill';
import { useOrchestratorTelemetry } from '@/store/orchestrator-telemetry';
import { uploadPastedImage } from '@/features/pasted-images/client';

const PROMPT_HISTORY_CAP = 100;

function ComposerRuntimeChips({
  sessionState,
  contextUsedPct,
}: {
  sessionState: string | null;
  contextUsedPct: number | null;
}) {
  const stateTone =
    sessionState === 'requires_action'
      ? 'bg-warning'
      : sessionState === 'running'
        ? 'bg-primary'
        : sessionState === 'idle'
          ? 'bg-foreground/40'
          : 'bg-foreground/20';
  const barTone =
    contextUsedPct == null
      ? 'bg-foreground/20'
      : contextUsedPct >= 85
        ? 'bg-destructive'
        : contextUsedPct >= 65
          ? 'bg-warning'
          : 'bg-primary/60';
  return (
    <span className="flex items-center gap-3 text-[var(--fg-dim)]">
      {sessionState && (
        <span className="inline-flex items-center gap-1.5" title="CC session_state_changed">
          <span className={`h-1.5 w-1.5 rounded-full ${stateTone}`} />
          <span>{sessionState.replace('_', ' ')}</span>
        </span>
      )}
      <span
        className="inline-flex items-center gap-2"
        title={
          contextUsedPct == null
            ? 'Context window \u2014 no data yet (CC fills this after the first turn)'
            : `Context window: ${contextUsedPct.toFixed(0)}% used. CC auto-compacts around 85-90%.`
        }
      >
        <span>ctx</span>
        <span className="relative h-1.5 w-24 overflow-hidden bg-muted">
          <span
            className={`absolute inset-y-0 left-0 ${barTone}`}
            style={{
              width: `${contextUsedPct == null ? 0 : Math.min(100, contextUsedPct)}%`,
            }}
          />
        </span>
        <span className="tabular-nums text-foreground">
          {contextUsedPct == null ? '\u2014' : `${contextUsedPct.toFixed(0)}%`}
        </span>
      </span>
    </span>
  );
}

function historyStorageKey(key: string) {
  return `pc:prompt-history:${key}`;
}

function readHistory(key: string): string[] {
  try {
    const raw = localStorage.getItem(historyStorageKey(key));
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

function writeHistory(key: string, list: string[]) {
  try {
    localStorage.setItem(historyStorageKey(key), JSON.stringify(list));
  } catch {
    /* quota / disabled storage - best effort */
  }
}

function draftStorageKey(key: string) {
  return `pc:composer-draft:${key}`;
}

function readDraft(key: string): string {
  try {
    return localStorage.getItem(draftStorageKey(key)) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(key: string, value: string) {
  try {
    if (value) localStorage.setItem(draftStorageKey(key), value);
    else localStorage.removeItem(draftStorageKey(key));
  } catch {
    /* quota / disabled storage - best effort */
  }
}

export function Composer({
  projectId,
  historyKey,
  onSend,
  onInterrupt,
  disabled,
  sendDisabled,
  interruptDisabled,
  placeholder,
  disabledReason,
  statusMessage,
  sendLabel,
}: {
  projectId: string;
  historyKey: string;
  onSend: (text: string) => boolean;
  onInterrupt: () => boolean;
  disabled?: boolean;
  sendDisabled?: boolean;
  interruptDisabled?: boolean;
  placeholder?: string;
  disabledReason?: string;
  statusMessage?: string;
  sendLabel: string;
}) {
  const [text, setText] = useState(() => readDraft(historyKey));
  const [interruptFeedback, setInterruptFeedback] = useState<'sent' | 'failed' | null>(null);
  const [pasteUpload, setPasteUpload] = useState<{
    uploading: number;
    errors: string[];
  } | null>(null);
  const interruptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const composerMinPx = 56;
  const composerMaxPx = 200;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const prefillSeq = useChatComposerPrefill((s) => s.seq);
  const consumePrefill = useChatComposerPrefill((s) => s.consume);
  useEffect(() => {
    const pending = consumePrefill();
    if (pending === null) return;
    setText(pending);
    setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pending.length, pending.length);
    }, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillSeq]);
  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.max(composerMinPx, Math.min(el.scrollHeight, composerMaxPx));
    el.style.height = `${next}px`;
  }, []);
  useEffect(() => {
    resizeTextarea();
  }, [text, resizeTextarea]);

  function clickInterrupt() {
    if (sendDisabled || interruptDisabled) return;
    if (interruptTimerRef.current) clearTimeout(interruptTimerRef.current);
    const ok = onInterrupt();
    setInterruptFeedback(ok ? 'sent' : 'failed');
    interruptTimerRef.current = setTimeout(() => setInterruptFeedback(null), 1500);
  }
  useEffect(
    () => () => {
      if (interruptTimerRef.current) clearTimeout(interruptTimerRef.current);
    },
    [],
  );

  const historyRef = useRef<string[]>(readHistory(historyKey));
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);

  // Tracks which historyKey the current `text` belongs to, so the persist
  // effect can skip the render right after a key switch (where `text` still
  // holds the previous key's value).
  const draftKeyRef = useRef(historyKey);

  useEffect(() => {
    historyRef.current = readHistory(historyKey);
    setHistoryIdx(null);
    // Restore this key's saved draft instead of clearing.
    setText(readDraft(historyKey));
  }, [historyKey]);

  // Persist the live draft per historyKey so it survives navigation away.
  useEffect(() => {
    if (draftKeyRef.current !== historyKey) {
      draftKeyRef.current = historyKey;
      return;
    }
    writeDraft(historyKey, text);
  }, [text, historyKey]);

  function submit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (sendDisabled) return;
    if (onSend(trimmed)) {
      const hist = historyRef.current;
      if (hist[hist.length - 1] !== trimmed) {
        hist.push(trimmed);
        if (hist.length > PROMPT_HISTORY_CAP) {
          hist.splice(0, hist.length - PROMPT_HISTORY_CAP);
        }
        writeHistory(historyKey, hist);
      }
      setHistoryIdx(null);
      setText('');
    }
  }

  function navHistory(direction: -1 | 1) {
    const hist = historyRef.current;
    if (hist.length === 0) return;
    if (direction === -1) {
      const next = historyIdx === null ? hist.length - 1 : Math.max(0, historyIdx - 1);
      setHistoryIdx(next);
      setText(hist[next] ?? '');
    } else {
      if (historyIdx === null) return;
      const next = historyIdx + 1;
      if (next >= hist.length) {
        setHistoryIdx(null);
        setText('');
      } else {
        setHistoryIdx(next);
        setText(hist[next] ?? '');
      }
    }
  }

  /** Insert text at the current textarea cursor position, padded with spaces
   *  when mid-text. Used synchronously for the text part of a mixed paste. */
  function insertAtCursor(insert: string): void {
    const el = textareaRef.current;
    if (!el) {
      setText((prev) => prev + (prev && !/\s$/.test(prev) ? ' ' : '') + insert);
      return;
    }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const needLead = before.length > 0 && !/\s$/.test(before);
    const needTrail = after.length > 0 && !/^\s/.test(after);
    const padded = (needLead ? ' ' : '') + insert + (needTrail ? ' ' : '');
    setText(before + padded + after);
    if (historyIdx !== null) setHistoryIdx(null);
    const newPos = start + padded.length - (needTrail ? 1 : 0);
    setTimeout(() => el.setSelectionRange(newPos, newPos), 0);
  }

  /** Append a path to the end of the composer text (used for async image upload
   *  results where the cursor may have moved since the paste event). */
  function appendPath(path: string): void {
    setText((prev) => {
      const sep = prev.length > 0 && !/\s$/.test(prev) ? ' ' : '';
      return prev + sep + path + ' ';
    });
  }

  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>): Promise<void> {
    const imageItems: DataTransferItem[] = [];
    for (let i = 0; i < e.clipboardData.items.length; i++) {
      const item = e.clipboardData.items[i];
      if (item.type.startsWith('image/')) imageItems.push(item);
    }
    if (imageItems.length === 0) return; // text-only paste: default browser handling

    // Has images — take over the paste entirely
    e.preventDefault();

    // Insert any plain-text portion at the cursor position (synchronous)
    const plainText = e.clipboardData.getData('text/plain');
    if (plainText) insertAtCursor(plainText);

    // Collect blobs synchronously before the event object goes stale
    const blobs = imageItems
      .map((item) => item.getAsFile())
      .filter((b): b is File => b !== null);
    if (blobs.length === 0) return;

    const errors: string[] = [];
    let remaining = blobs.length;
    setPasteUpload({ uploading: remaining, errors: [] });

    // Upload sequentially; append each path as it resolves
    for (const blob of blobs) {
      const result = await uploadPastedImage(projectId, blob);
      remaining -= 1;
      if (result.ok) {
        appendPath(result.path);
      } else {
        errors.push(result.error);
      }
      setPasteUpload(remaining > 0 ? { uploading: remaining, errors: [...errors] } : null);
      if (remaining === 0 && errors.length > 0) {
        // Keep errors visible for a few seconds then auto-clear
        const snap = [...errors];
        setPasteUpload({ uploading: 0, errors: snap });
        setTimeout(() => setPasteUpload(null), 4000);
      }
    }
  }

  const historyLen = historyRef.current.length;
  const sessionState = useOrchestratorTelemetry((s) => s.sessionState);
  const contextUsedPct = useOrchestratorTelemetry((s) => s.contextUsedPct);

  return (
    <div className="flex flex-col gap-1.5 border-t border-border bg-card px-4 py-2.5">
      <div className="flex items-center gap-3 text-[10px] uppercase tracking-[0.04em] text-muted-foreground">
        <span
          className="inline-flex items-center gap-1.5 text-[var(--fg-dim)]"
          title={'\u2191/\u2193 in the textarea walks your prompt history for this project'}
        >
          <kbd className="border border-border px-1 text-[9px]">{'\u2191'}</kbd>
          <kbd className="border border-border px-1 text-[9px]">{'\u2193'}</kbd>
          <span>prompt history · {historyLen}</span>
        </span>
        <ComposerRuntimeChips
          sessionState={sessionState}
          contextUsedPct={contextUsedPct}
        />
        {disabledReason || statusMessage ? (
          <span
            className={
              'ml-auto normal-case tracking-normal ' +
              (disabledReason ? 'text-warning' : 'text-[var(--fg-dim)]')
            }
          >
            {disabledReason ?? statusMessage}
          </span>
        ) : (
          <span className="ml-auto text-[var(--fg-dim)]">
            enter to send · shift+enter newline
          </span>
        )}
      </div>
      <textarea
        ref={textareaRef}
        data-testid="chat-composer-input"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (historyIdx !== null) setHistoryIdx(null);
        }}
        onPaste={(e) => { void handlePaste(e); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
            return;
          }
          if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
            if (text === '' || historyIdx !== null) {
              e.preventDefault();
              navHistory(-1);
            }
            return;
          }
          if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
            if (historyIdx !== null) {
              e.preventDefault();
              navHistory(1);
            }
            return;
          }
        }}
        placeholder={placeholder ?? 'Message the orchestrator\u2026'}
        disabled={disabled}
        className="resize-none overflow-y-auto border border-border bg-background px-2 py-1 text-sm focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:bg-muted/60 disabled:opacity-60"
        style={{ minHeight: composerMinPx, maxHeight: composerMaxPx }}
      />
      {pasteUpload && (
        <div className="flex items-center gap-2 bg-muted px-2 py-1 text-[10px]">
          {pasteUpload.uploading > 0 && (
            <span className="text-muted-foreground">
              saving image{pasteUpload.uploading > 1 ? `s (${pasteUpload.uploading})` : ''}…
            </span>
          )}
          {pasteUpload.errors.map((err, i) => (
            <span key={i} className="text-destructive">
              image upload failed: {err}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={disabled || sendDisabled || !text.trim()}
          data-testid="chat-composer-send"
          className="bg-primary px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {sendLabel}
        </button>
        <button
          type="button"
          onClick={clickInterrupt}
          disabled={disabled || sendDisabled || interruptDisabled || interruptFeedback === 'sent'}
          title="Stop the current response (sends Escape to the PTY)"
          className={
            'border px-3 py-1 text-[10px] uppercase tracking-wider disabled:opacity-50 ' +
            (interruptFeedback === 'sent'
              ? 'border-success bg-success/10 text-success'
              : interruptFeedback === 'failed'
                ? 'border-warning bg-warning/10 text-warning'
                : 'border-border text-muted-foreground hover:border-destructive hover:text-destructive')
          }
        >
          {interruptFeedback === 'sent'
            ? '\u2713 Sent'
            : interruptFeedback === 'failed'
              ? 'Failed \u2014 not connected'
              : 'Interrupt esc'}
        </button>
      </div>
    </div>
  );
}
