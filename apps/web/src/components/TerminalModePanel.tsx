import { useCallback, useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import {
  removeOverlappingPrefix,
  terminalRawBatchFromEvents,
} from '@/features/chat/terminalTranscript';
import { runtimeApi } from '@/features/runtime/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';
import { uploadPastedImage } from '@/features/pasted-images/client';

const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;

interface TerminalModePanelProps {
  projectId: string;
  sessionId: string | null;
  /** Stable imperative subscription for raw PTY batches. Each 50 ms flush
   *  delivers frames directly to the subscriber callback without touching
   *  React state, so terminal output causes ~0 re-renders in the parent tree. */
  subscribeRawTerminal?: (cb: (envs: WsEnvelope[]) => void) => () => void;
  visible: boolean;
  writable: boolean;
  onInput: (data: string) => boolean;
  onResize: (cols: number, rows: number) => boolean;
}

export function TerminalModePanel({
  projectId,
  sessionId,
  subscribeRawTerminal,
  visible,
  writable,
  onInput,
  onResize,
}: TerminalModePanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fitTargetRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  const dataDisposableRef = useRef<{ dispose(): void } | null>(null);
  const sessionKeyRef = useRef<string | null>(null);
  const lastTerminalSeqRef = useRef(0);
  const attachingRef = useRef(false);
  const attachLiveBufferRef = useRef('');
  const writeQueueRef = useRef('');
  const rafRef = useRef<number | null>(null);
  const writableRef = useRef(writable);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const [readyToReveal, setReadyToReveal] = useState(false);

  useEffect(() => {
    writableRef.current = writable;
    const term = termRef.current;
    if (term) term.options.disableStdin = !writable;
  }, [writable]);
  useEffect(() => {
    onInputRef.current = onInput;
  }, [onInput]);
  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  // Intercept paste events in the capture phase (before xterm's own handler)
  // so image items are routed through the upload API. Plain-text pastes are NOT
  // intercepted — the event propagates to xterm normally.
  useEffect(() => {
    const target = fitTargetRef.current;
    if (!target) return;

    function onPaste(e: ClipboardEvent): void {
      if (!writableRef.current) return;
      const items = e.clipboardData?.items;
      if (!items) return;

      const imageItems: DataTransferItem[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) imageItems.push(items[i]);
      }
      if (imageItems.length === 0) return; // text-only: let xterm handle it

      // Image paste — intercept before xterm touches it
      e.preventDefault();
      e.stopPropagation();

      // Send any plain-text part first
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (text) onInputRef.current(text);

      // Upload images; write each path into the PTY as typed text
      for (const item of imageItems) {
        const blob = item.getAsFile();
        if (!blob) continue;
        void uploadPastedImage(projectId, blob).then((result) => {
          if (!writableRef.current) return;
          if (result.ok) {
            onInputRef.current(result.path + ' ');
          } else {
            console.error('[pc] terminal image upload failed:', result.error);
          }
        });
      }
    }

    target.addEventListener('paste', onPaste, { capture: true });
    return () => target.removeEventListener('paste', onPaste, { capture: true });
    // projectId captured in handler; onInputRef + writableRef are always-current refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const flushWrites = useCallback(() => {
    rafRef.current = null;
    const text = writeQueueRef.current;
    writeQueueRef.current = '';
    if (!text) return;
    termRef.current?.write(text);
    if ((window as Window & { __PC_TERMINAL_TEST_HOOK__?: boolean }).__PC_TERMINAL_TEST_HOOK__) {
      window.dispatchEvent(new CustomEvent('pc:terminal-write', { detail: { text } }));
    }
  }, []);

  const enqueueWrite = useCallback((text: string) => {
    if (!text) return;
    writeQueueRef.current += text;
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(flushWrites);
  }, [flushWrites]);

  const fitAndResize = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return false;
    try {
      fit.fit();
      const next = { cols: term.cols, rows: term.rows };
      onResizeRef.current(next.cols, next.rows);
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    if (!sessionId || !hostRef.current) return;
    const sessionKey = `${projectId}:${sessionId}`;
    if (sessionKeyRef.current === sessionKey && termRef.current) return;

    disposeTerminal();
    sessionKeyRef.current = sessionKey;
    // Subscription delivers frames from now forward; the transcript fetch covers
    // all prior history. Initialize to 0 — the seq guard in the subscription
    // callback prevents any double-writes from the overlapping window.
    lastTerminalSeqRef.current = 0;
    attachingRef.current = true;
    attachLiveBufferRef.current = '';
    setReadyToReveal(false);

    const term = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      disableStdin: !writableRef.current,
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;
    // GPU renderer — xterm's default DOM renderer is the terminal's main perf
    // bottleneck under heavy output/scroll. Load after open(); fall back
    // silently to the DOM renderer if WebGL is unavailable or its GPU context
    // is lost. On context loss (GPU process crash, driver reset), attempts to
    // re-acquire a fresh WebglAddon after a short delay so GPU-accelerated
    // scroll stays live rather than permanently falling back to the CPU path.
    function attachWebgl(target: Terminal): void {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          console.warn('[pc] terminal: WebGL context lost — attempting recovery in 500ms');
          webgl.dispose();
          if (webglRef.current === webgl) webglRef.current = null;
          setTimeout(() => {
            // Guard: terminal may have been disposed, or a concurrent recovery
            // already succeeded (webglRef.current non-null).
            if (!termRef.current || webglRef.current) return;
            attachWebgl(termRef.current);
          }, 500);
        });
        target.loadAddon(webgl);
        webglRef.current = webgl;
        console.log('[pc] terminal: WebGL renderer active');
      } catch {
        /* WebGL unavailable — stays on the DOM renderer */
      }
    }
    attachWebgl(term);
    term.attachCustomKeyEventHandler((event) => {
      if (
        event.type === 'keydown' &&
        event.key === 'Enter' &&
        event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        if (writableRef.current) {
          onInputRef.current('\n');
        }
        event.preventDefault();
        event.stopPropagation();
        return false;
      }
      return true;
    });
    dataDisposableRef.current = term.onData((data) => {
      if (!writableRef.current) return;
      onInputRef.current(data);
    });

    let cancelled = false;
    void runtimeApi.getTerminalTranscript(projectId, sessionId, TRANSCRIPT_TAIL_BYTES)
      .then((transcript) => {
        if (cancelled || sessionKeyRef.current !== sessionKey) return;
        const live = attachLiveBufferRef.current;
        attachLiveBufferRef.current = '';
        // transcript null = 404 (no runtime / no session yet) — treat as empty
        // scrollback and still flush any live data buffered during attach.
        const bytes = transcript?.bytes ?? '';
        enqueueWrite(bytes);
        enqueueWrite(removeOverlappingPrefix(bytes, live));
      })
      .catch((err: unknown) => {
        if (cancelled || sessionKeyRef.current !== sessionKey) return;
        // Unexpected error (non-404, network failure) — warn so it's visible
        // but don't let it propagate. Flush the live buffer so buffered output
        // isn't silently discarded.
        console.warn('[pc] terminal-transcript: unexpected fetch error:', err);
        const live = attachLiveBufferRef.current;
        attachLiveBufferRef.current = '';
        enqueueWrite(live);
      })
      .finally(() => {
        if (cancelled || sessionKeyRef.current !== sessionKey) return;
        attachingRef.current = false;
      });

    return () => {
      cancelled = true;
    };
    // Terminal lifetime is keyed only by project/session. Event and callback
    // freshness flows through refs above so rerenders cannot duplicate listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, sessionId, enqueueWrite]);

  useEffect(() => {
    if (!sessionId) {
      disposeTerminal();
      sessionKeyRef.current = null;
      lastTerminalSeqRef.current = 0;
      setReadyToReveal(false);
    }
  }, [sessionId]);

  // Imperative subscription — frames are pushed directly from the WS batch-flush
  // handler; this effect never runs on a prop change, so terminal output causes
  // ~0 React re-renders in the parent tree. Deps are all stable: subscribeRawTerminal
  // is a useCallback([], []) from useProjectWs, sessionId only changes on session
  // switch, enqueueWrite is a stable useCallback.
  useEffect(() => {
    if (!sessionId || !subscribeRawTerminal) return;
    const unsub = subscribeRawTerminal((envs) => {
      // envs is the current 50 ms batch — small. Full batch scan (no startIdx
      // needed); seq guard + sessionId filter in terminalRawBatchFromEvents still apply.
      const pending = terminalRawBatchFromEvents(envs, sessionId, lastTerminalSeqRef.current);
      for (const raw of pending) {
        if (attachingRef.current) {
          attachLiveBufferRef.current += raw.text;
        } else {
          enqueueWrite(raw.text);
        }
        lastTerminalSeqRef.current = Math.max(lastTerminalSeqRef.current, raw.seq);
      }
    });
    return unsub;
  }, [subscribeRawTerminal, sessionId, enqueueWrite]);

  useEffect(() => {
    const target = fitTargetRef.current;
    if (!target) return;
    const observer = new ResizeObserver(() => {
      if (!visible) return;
      fitAndResize();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [fitAndResize, visible]);

  useEffect(() => {
    if (!visible) {
      setReadyToReveal(false);
      return;
    }
    setReadyToReveal(false);
    let second: number | null = null;
    const first = window.requestAnimationFrame(() => {
      const term = termRef.current;
      const prevCols = term?.cols;
      const prevRows = term?.rows;
      fitAndResize();
      // The WebGL renderer caches glyph tiles in a GPU texture atlas keyed by
      // the cell geometry at draw time. When the pane is re-fit to a different
      // size, stale tiles can survive and render as overlapping / garbled text.
      // Only clear when fit() actually changed the terminal dimensions — clearing
      // unconditionally wipes the warm GPU cache on every tab switch, causing a
      // cold-atlas scroll-lag spike on the first scroll after every chat→terminal
      // reveal even when the layout is unchanged.
      if (webglRef.current && term && (term.cols !== prevCols || term.rows !== prevRows)) {
        webglRef.current.clearTextureAtlas();
      }
      second = window.requestAnimationFrame(() => {
        if (term) term.refresh(0, term.rows - 1);
        setReadyToReveal(true);
        term?.focus();
      });
    });
    return () => {
      window.cancelAnimationFrame(first);
      if (second !== null) window.cancelAnimationFrame(second);
    };
  }, [visible, fitAndResize]);

  useEffect(() => {
    return () => disposeTerminal();
  }, []);

  return (
    <div
      data-testid="terminal-mode-panel"
      className={
        'absolute inset-0 bg-[#050505] transition-opacity duration-100 ' +
        (visible ? 'pointer-events-auto' : 'pointer-events-none invisible') +
        (visible && readyToReveal ? ' opacity-100' : ' opacity-0')
      }
      aria-hidden={!visible}
    >
      <div
        ref={fitTargetRef}
        data-testid="terminal-mode-fit-target"
        className="box-border h-full w-full overflow-hidden bg-[#050505] px-3"
      >
        <div ref={hostRef} className="h-full w-full" />
      </div>
    </div>
  );

  function disposeTerminal() {
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    writeQueueRef.current = '';
    attachLiveBufferRef.current = '';
    attachingRef.current = false;
    dataDisposableRef.current?.dispose();
    dataDisposableRef.current = null;
    webglRef.current?.dispose();
    webglRef.current = null;
    fitRef.current?.dispose();
    fitRef.current = null;
    termRef.current?.dispose();
    termRef.current = null;
  }
}

function terminalTheme() {
  return {
    background: '#050505',
    foreground: '#d6d6d6',
    cursor: '#f8f8f2',
    selectionBackground: '#264f78',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#e5e5e5',
  };
}
