// Rich renderer for an agent run's transcript — reuses the SAME canonical chat
// pipeline the orchestrator chat uses (markdown bodies + grouped tool calls +
// collapsible bubbles) instead of the bare per-event TranscriptRow. One
// renderer everywhere: an agent transcript looks exactly like the main chat.
//
// The agent run's JSONL events are wrapped as `type: 'jsonl'` WS envelopes and
// fed through useChatRenderItems → useChatTimelineRenderer → ChatTimeline — the
// same three pieces ChatSurface composes, minus the composer/terminal/runtime
// machinery a read-only transcript doesn't need.

import { useMemo, type ReactNode } from 'react';

import { ChatTimeline } from '@/features/chat/ChatTimeline';
import { useChatRenderItems } from '@/features/chat/useChatRenderItems';
import { useChatTimelineRenderer } from '@/features/chat/useChatTimelineRenderer';
import type { WsEnvelope } from '@/features/runtime/ws-types';

import type { AgentTranscriptItem } from './transcript';

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
  items: AgentTranscriptItem[];
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

  const renderItem = useChatTimelineRenderer({
    projectId,
    renderItems,
    wsEvents: envelopes,
  });

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
