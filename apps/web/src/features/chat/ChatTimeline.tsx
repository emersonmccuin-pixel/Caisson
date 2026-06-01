import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { useChatScrollTarget } from '@/store/chat-scroll-target';

import type { RenderItem } from './types';

// Render only the most recent window of the timeline. A long conversation
// otherwise keeps the entire history in the DOM (thousands of nodes), which
// makes every layout flush — including the composer's per-keystroke textarea
// auto-resize — pay an O(history) reflow cost. "Load earlier" reveals more.
const DEFAULT_HISTORY_WINDOW = 200;
const LOAD_EARLIER_STEP = 200;

export function ChatTimeline({
  renderItems,
  autoFollowKey,
  resetKey,
  empty,
  terminalEligible,
  terminalActive,
  emptyState,
  thinkingIndicator,
  terminalPane,
  renderItem,
}: {
  renderItems: RenderItem[];
  autoFollowKey: number | string;
  resetKey: string | null;
  empty: boolean;
  terminalEligible: boolean;
  terminalActive: boolean;
  emptyState?: ReactNode;
  thinkingIndicator?: ReactNode;
  terminalPane?: ReactNode;
  renderItem: (item: RenderItem, index: number) => ReactNode;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const [visibleCount, setVisibleCount] = useState(DEFAULT_HISTORY_WINDOW);

  const total = renderItems.length;
  const start = Math.max(0, total - visibleCount);
  const windowed = start === 0 ? renderItems : renderItems.slice(start);

  const handleChatScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    setPinnedToBottom(distanceFromBottom < 50);
  }, []);

  const jumpToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setPinnedToBottom(true);
  }, []);

  useEffect(() => {
    if (!pinnedToBottom) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [autoFollowKey, pinnedToBottom]);

  // When the terminal closes, the timeline un-hides and re-renders its bubbles.
  // While it was hidden the scroller collapsed to zero height and the browser
  // reset scrollTop to 0, so restore the bottom-pin after the bubbles lay out.
  useEffect(() => {
    if (terminalActive || !pinnedToBottom) return;
    const el = scrollerRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [terminalActive, pinnedToBottom]);

  useEffect(() => {
    setPinnedToBottom(true);
    setVisibleCount(DEFAULT_HISTORY_WINDOW);
  }, [resetKey]);

  const scrollTargetId = useChatScrollTarget((s) => s.targetId);
  const scrollTargetRequestedAt = useChatScrollTarget((s) => s.requestedAt);
  const handledScrollReqRef = useRef<number | null>(null);
  useEffect(() => {
    if (!scrollTargetId || !scrollTargetRequestedAt) return;
    const el = scrollerRef.current?.querySelector<HTMLElement>(
      `[data-bubble-id="${CSS.escape(scrollTargetId)}"]`,
    );
    if (!el) {
      // Target may be older than the current window — reveal everything and let
      // this effect re-run (visibleCount/start change) to find and scroll to it.
      if (start > 0) setVisibleCount(total);
      return;
    }
    if (handledScrollReqRef.current === scrollTargetRequestedAt) return;
    handledScrollReqRef.current = scrollTargetRequestedAt;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setPinnedToBottom(false);
    el.classList.add('ring-2', 'ring-warning', 'ring-offset-2', 'ring-offset-background');
    const timer = setTimeout(() => {
      el.classList.remove('ring-2', 'ring-warning', 'ring-offset-2', 'ring-offset-background');
    }, 1500);
    return () => clearTimeout(timer);
  }, [scrollTargetId, scrollTargetRequestedAt, start, total]);

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={scrollerRef}
        onScroll={handleChatScroll}
        // `contain: content` makes this scroller an independent layout/paint
        // boundary so the composer's per-keystroke textarea auto-resize doesn't
        // force a reflow of the timeline's subtree.
        style={{ contain: 'content' }}
        className={
          'h-full overflow-y-auto px-4 py-3 ' +
          (terminalActive ? 'pointer-events-none invisible' : '')
        }
      >
        <div className="flex flex-col gap-3">
          {/* Terminal mode covers the timeline; skip rendering chat bubbles
              entirely so live PTY output (each chunk = an events change) doesn't
              re-invoke every item render and reconcile the chat DOM underneath. */}
          {!terminalActive && start > 0 && (
            <button
              type="button"
              onClick={() => setVisibleCount((c) => c + LOAD_EARLIER_STEP)}
              className="self-center rounded border border-border bg-card px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Load earlier messages ({start} hidden)
            </button>
          )}
          {!terminalActive && windowed.map((item, i) => renderItem(item, start + i))}
          {!terminalActive && empty && emptyState && (
            <div className="text-center text-xs text-muted-foreground">{emptyState}</div>
          )}
          {!terminalActive && thinkingIndicator}
        </div>
      </div>
      {!pinnedToBottom && (!terminalEligible || !terminalActive) && (
        <button
          onClick={jumpToBottom}
          className="absolute bottom-3 right-4 z-30 rounded-full px-3.5 py-1.5 text-xs font-bold opacity-100"
          style={{
            backgroundColor: '#f0d080',
            color: '#080604',
            border: '2px solid #080604',
            boxShadow: '0 0 0 1px #f5e8c8, 0 10px 30px rgba(0, 0, 0, 0.7)',
          }}
          title="Scroll to the latest messages"
        >
          ↓ Jump to present
        </button>
      )}
      {terminalPane}
    </div>
  );
}
