import { useCallback, useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import {
  maxTerminalSeq,
  removeOverlappingPrefix,
  terminalRawBatchFromEvents,
} from '@/features/chat/terminalTranscript';
import { runtimeApi } from '@/features/runtime/client';
import type { WsEnvelope } from '@/features/runtime/ws-types';

const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;

interface TerminalModePanelProps {
  projectId: string;
  sessionId: string | null;
  events: WsEnvelope[];
  visible: boolean;
  writable: boolean;
  onInput: (data: string) => boolean;
  onResize: (cols: number, rows: number) => boolean;
}

export function TerminalModePanel({
  projectId,
  sessionId,
  events,
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
  const eventsRef = useRef(events);
  const lastTerminalSeqRef = useRef(0);
  // Index cursor into `events` so the live-write effect only scans the new tail
  // each change instead of re-walking the whole array (O(history) per keystroke
  // echo → O(history^2) over a session). The seq check below stays the
  // correctness guard; this is purely the perf cursor.
  const lastScannedIdxRef = useRef(0);
  const attachingRef = useRef(false);
  const attachLiveBufferRef = useRef('');
  const writeQueueRef = useRef('');
  const rafRef = useRef<number | null>(null);
  const writableRef = useRef(writable);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const [readyToReveal, setReadyToReveal] = useState(false);

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);
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
    lastTerminalSeqRef.current = maxTerminalSeq(eventsRef.current, sessionId);
    // Everything currently in the array is accounted for (loaded via the
    // transcript fetch); the live effect only needs to process appends after this.
    lastScannedIdxRef.current = eventsRef.current.length;
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
    // is lost.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        if (webglRef.current === webgl) webglRef.current = null;
      });
      term.loadAddon(webgl);
      webglRef.current = webgl;
    } catch {
      /* WebGL unavailable — stays on the DOM renderer */
    }
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
        enqueueWrite(transcript.bytes);
        enqueueWrite(removeOverlappingPrefix(transcript.bytes, live));
      })
      .catch(() => {
        if (cancelled || sessionKeyRef.current !== sessionKey) return;
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
      lastScannedIdxRef.current = 0;
      setReadyToReveal(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    // Walk only events appended since the last run (index cursor) so a long
    // session's history isn't re-scanned on every keystroke echo. If the array
    // was replaced or shrank (session reset / replay), startIdx falls out of
    // range and the helper does a full rescan; its seq check prevents
    // double-writes either way.
    let startIdx = lastScannedIdxRef.current;
    if (startIdx > events.length) startIdx = 0;
    const pending = terminalRawBatchFromEvents(
      events,
      sessionId,
      lastTerminalSeqRef.current,
      startIdx,
    );
    lastScannedIdxRef.current = events.length;
    for (const raw of pending) {
      if (attachingRef.current) {
        attachLiveBufferRef.current += raw.text;
      } else {
        enqueueWrite(raw.text);
      }
      lastTerminalSeqRef.current = Math.max(lastTerminalSeqRef.current, raw.seq);
    }
  }, [events, enqueueWrite, sessionId]);

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
      fitAndResize();
      // The WebGL renderer caches glyph tiles in a GPU texture atlas keyed by
      // the cell geometry at draw time. When the pane is revealed and re-fit to
      // a different size, stale tiles can survive and render as overlapping /
      // garbled text. Clearing the atlas + forcing a full repaint after the fit
      // rebuilds it against the current geometry. (No-op on the DOM fallback.)
      webglRef.current?.clearTextureAtlas();
      second = window.requestAnimationFrame(() => {
        const term = termRef.current;
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
