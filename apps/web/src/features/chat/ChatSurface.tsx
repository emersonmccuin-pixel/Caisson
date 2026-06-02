// Extracted from Orchestrator.tsx — the per-project chat surface that
// renders a live PTY/jsonl event stream as the chat panel the user sees.
// Both <Orchestrator> (live project session) and <AgentDesignerChat>
// (transient agent-designer session) consume this. Wrappers own
// session lifecycle / past-session fetching / status bar; ChatSurface
// owns the top-level rendering and chat coordination.

import { useCallback, useState } from 'react';

import { Composer } from '@/features/chat/ChatComposer';
import type { ChatSurfaceProps } from '@/features/chat/ChatSurfaceProps';
import { ChatTimeline } from '@/features/chat/ChatTimeline';
import { RawModeToggle, TerminalModeToggle, TerminalPane } from '@/features/chat/TerminalPane';
import { SendBatchTray } from '@/features/chat/SendBatchTray';
import { ThinkingIndicator } from '@/features/chat/ThinkingIndicator';
import { useChatComposerActions } from '@/features/chat/useChatComposerActions';
import { useChatInputControls } from '@/features/chat/useChatInputControls';
import { useChatRuntimeThinking } from '@/features/chat/useChatRuntimeThinking';
import { useChatSurfaceMode } from '@/features/chat/useChatSurfaceMode';
import { usePendingPrompts } from '@/features/chat/usePendingPrompts';
import { useChatRenderItems } from '@/features/chat/useChatRenderItems';
import {
  isJsonlCanonicalChat,
  isRevealHiddenChatRows,
  setRevealHiddenChatRows,
} from '@/features/chat/chatRendererFlag';
import { useChatTimelineRenderer } from '@/features/chat/useChatTimelineRenderer';

// ── ChatSurface ──────────────────────────────────────────────────────────

export function ChatSurface({
  events,
  projectId,
  currentSessionId,
  onSend,
  onInterrupt,
  onTerminalInput,
  onTerminalResize,
  onAskReply,
  composerHistoryKey,
  defaultOrchestratorSurface = 'chat',
  composerHidden,
  composerDisabled,
  composerSendDisabled,
  composerPlaceholder,
  composerDisabledReason,
  composerQueueing,
  composerSendLabel,
  inputCapabilities,
  composerStatusMessage,
  headerSlot,
  bannerSlot,
  footerSlot,
  emptyState,
  wsStatus,
  onSurfaceModeChange,
}: ChatSurfaceProps) {
  const { visiblePendingPrompts, recordPendingPrompt } = usePendingPrompts({
    events,
    currentSessionId,
  });
  const terminalEligible = Boolean(
    onTerminalInput &&
      onTerminalResize &&
      currentSessionId &&
      !composerHidden,
  );

  // Raw/diagnostic mode — live (no reload). Seeds from the persisted flag so it
  // stays in sync with the DevControls `reveal` button, and writes back on every
  // flip so a later reload restores the user's choice.
  const [revealHidden, setRevealHidden] = useState<boolean>(() =>
    isRevealHiddenChatRows(),
  );
  const toggleRawMode = useCallback(() => {
    setRevealHidden((prev) => {
      const next = !prev;
      setRevealHiddenChatRows(next);
      return next;
    });
  }, []);

  const { chatEnvelopes, renderItems } = useChatRenderItems({
    events,
    currentSessionId,
    projectId,
    visiblePendingPrompts,
    canonical: isJsonlCanonicalChat(),
    revealHidden,
  });

  const renderTimelineItem = useChatTimelineRenderer({
    projectId,
    renderItems,
    onAskReply,
  });

  const {
    isThinking,
    activity,
    thinkingStartedAt,
    interruptedAt,
    lastEnvelopeAt,
    markInterrupted,
  } = useChatRuntimeThinking(events);

  const { terminalActive, setTerminalMode } = useChatSurfaceMode({
    projectId,
    currentSessionId,
    terminalEligible,
    defaultOrchestratorSurface,
    onSurfaceModeChange,
  });

  const {
    resolvedComposerDisabled,
    resolvedComposerSendDisabled,
    resolvedInterruptDisabled,
    resolvedTerminalWritable,
    handleTerminalResize,
  } = useChatInputControls({
    inputCapabilities,
    composerDisabled,
    composerSendDisabled,
    terminalActive,
    wsStatus,
    onTerminalResize,
  });

  const {
    handleSend,
    handleInterrupt,
    resolvedComposerSendLabel,
    batchChunks,
    cancelLastChunk,
    cancelBatch,
  } = useChatComposerActions({
    events,
    currentSessionId,
    inputCapabilities,
    onSend,
    onInterrupt,
    composerQueueing,
    composerSendLabel,
    isThinking,
    hasPendingInFlight: visiblePendingPrompts.length > 0,
    wsStatus,
    recordPendingPrompt,
    markInterrupted,
  });

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {headerSlot}
      <ChatTimeline
        renderItems={renderItems}
        autoFollowKey={`${chatEnvelopes.length}:${isThinking ? 1 : 0}`}
        resetKey={currentSessionId}
        empty={chatEnvelopes.length === 0}
        terminalEligible={terminalEligible}
        terminalActive={terminalActive}
        emptyState={emptyState}
        thinkingIndicator={
          isThinking ? (
            <ThinkingIndicator
              thinkingStartedAt={thinkingStartedAt}
              interruptedAt={interruptedAt}
              activity={activity}
              lastEnvelopeAt={lastEnvelopeAt}
              wsStatus={wsStatus}
            />
          ) : undefined
        }
        terminalPane={
          <TerminalPane
            eligible={terminalEligible}
            projectId={projectId}
            sessionId={currentSessionId}
            events={events}
            active={terminalActive}
            writable={resolvedTerminalWritable}
            onInput={onTerminalInput}
            onResize={handleTerminalResize}
          />
        }
        renderItem={renderTimelineItem}
      />
      {bannerSlot}
      {!composerHidden && !terminalActive && (
        <SendBatchTray
          chunks={batchChunks}
          onCancelLast={cancelLastChunk}
          onCancelAll={cancelBatch}
        />
      )}
      {!composerHidden && !terminalActive && (
        <Composer
          historyKey={composerHistoryKey}
          onSend={handleSend}
          onInterrupt={handleInterrupt}
          disabled={resolvedComposerDisabled}
          sendDisabled={resolvedComposerSendDisabled}
          interruptDisabled={resolvedInterruptDisabled}
          placeholder={composerPlaceholder}
          disabledReason={composerDisabledReason}
          statusMessage={composerStatusMessage}
          sendLabel={resolvedComposerSendLabel}
        />
      )}
      {!composerHidden && (
        <div className="shrink-0 border-t border-border bg-card px-3 py-1.5">
          <div className="flex items-center justify-between gap-2">
            <RawModeToggle active={revealHidden} onToggle={toggleRawMode} />
            <TerminalModeToggle
              eligible={terminalEligible}
              active={terminalActive}
              onModeChange={setTerminalMode}
            />
          </div>
        </div>
      )}
      {footerSlot}
    </div>
  );
}
