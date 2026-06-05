// Rich renderer for an agent run's transcript — reuses the SAME canonical chat
// pipeline the orchestrator chat uses (markdown bodies + grouped tool calls +
// collapsible bubbles) instead of the bare per-event TranscriptRow. One
// renderer everywhere: an agent transcript looks exactly like the main chat.
//
// The agent run's JSONL events are wrapped as `type: 'jsonl'` WS envelopes and
// fed through useChatRenderItems → useChatTimelineRenderer → ChatTimeline — the
// same three pieces ChatSurface composes, minus the composer/terminal/runtime
// machinery a read-only transcript doesn't need.
//
// The agent's FIRST user turn is its contract (the dispatch task), so we render
// that one row with a labeled header instead of an anonymous user bubble.

import { useCallback, useMemo, type ReactNode } from 'react';

import { ChatTimeline } from '@/features/chat/ChatTimeline';
import { EventBubble } from '@/features/chat/EventBubbles';
import { useChatRenderItems } from '@/features/chat/useChatRenderItems';
import { useChatTimelineRenderer } from '@/features/chat/useChatTimelineRenderer';
import type { RenderItem } from '@/features/chat/types';
import type { ChatEvent, WsEnvelope } from '@/features/runtime/ws-types';

/** The event carried by an `env`-kind RenderItem after normalization. */
function envEvent(item: RenderItem): { kind?: string; text?: string } | null {
  if (item.kind !== 'env') return null;
  return (item.env as WsEnvelope & { event?: { kind?: string; text?: string } }).event ?? null;
}

export function RichAgentTranscript({
  projectId,
  sessionId,
  items,
  emptyState,
}: {
  projectId: string;
  /** The agent run's CC session id — scopes `ask` rows (none expected here) and
   *  keys the timeline's scroll reset. */
  sessionId: string | null;
  /** Ordered, deduped transcript events (mergeAgentTranscriptEvents output). */
  items: { key: string; event: unknown }[];
  emptyState?: ReactNode;
}) {
  // Wrap each event as a jsonl envelope — the exact shape buildCanonicalChat-
  // Envelopes consumes (it renders ALL jsonl rows; only `ask` rows are
  // session-scoped, and agents don't emit those here).
  const envelopes = useMemo<WsEnvelope[]>(
    () => items.map((it) => ({ projectId, type: 'jsonl', event: it.event })),
    [items, projectId],
  );

  const { chatEnvelopes, renderItems } = useChatRenderItems({
    events: envelopes,
    currentSessionId: sessionId,
    projectId,
    visiblePendingPrompts: [],
  });

  const baseRender = useChatTimelineRenderer({
    projectId,
    renderItems,
    wsEvents: envelopes,
  });

  // The first visible user turn is the agent's contract (the dispatch task).
  const contractKey = useMemo(() => {
    for (const it of renderItems) {
      if (envEvent(it)?.kind === 'user') return it.key;
    }
    return null;
  }, [renderItems]);

  const renderItem = useCallback(
    (item: RenderItem, idx: number): ReactNode => {
      if (item.key === contractKey) {
        const text = envEvent(item)?.text ?? '';
        return (
          <div key={item.key} className="border border-primary/30 bg-primary/5 px-3 py-2">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
              Agent contract · the task this agent was given
            </div>
            <div className="text-sm text-foreground">
              <EventBubble event={{ kind: 'user', text } as ChatEvent} projectId={projectId} />
            </div>
          </div>
        );
      }
      return baseRender(item, idx);
    },
    [baseRender, contractKey, projectId],
  );

  return (
    <ChatTimeline
      renderItems={renderItems}
      autoFollowKey={chatEnvelopes.length}
      resetKey={sessionId}
      empty={chatEnvelopes.length === 0}
      terminalEligible={false}
      terminalActive={false}
      emptyState={emptyState}
      renderItem={renderItem}
    />
  );
}
