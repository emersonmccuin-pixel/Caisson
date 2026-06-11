// Vendored from the legacy chat rig @ legacy/app.js (MIT)
// Source: apps/web/legacy/app.js
// Adapted for Caisson: thin wrapper around <ChatSurface> that owns
// session metadata (title / + New session / Resume / past-session view /
// session-ended banner) and the StatusBar. All chat rendering + composer +
// thinking-indicator + scroll machinery lives in ChatSurface.

import { useEffect, useMemo, useState } from 'react';

import { useLiveEvents } from '@/store/live-store';

import type { Project } from '@/features/projects/client';
import type { OrchestratorSurfacePreference } from '@/features/settings/client';
import { settingsApi } from '@/features/settings/client';
import { runtimeApi, type OrchestratorRuntimeHealth, type OrchestratorRuntimeSnapshot, type OrchestratorSession, type SessionTransitionResponse } from '@/features/runtime/client';
import { latestSessionFromTitleEvents } from '@/features/runtime/session-title-live-events';
import {
  latestTerminalInputFailure,
  orchestratorInputCapabilities,
} from '@/features/chat/runtimeState';
import type {
  WsDiagnostics,
  WsEnvelope,
  WsOutbound,
  WsStatus,
} from '@/features/runtime/ws-types';
import type { ChatSessionAggregates } from '@/hooks/chat-session-reducer';
import { useOrchestratorTelemetry } from '@/store/orchestrator-telemetry';
import { useViewingSession } from '@/store/viewing-session';
import { useChatOpen } from '@/store/chat-open';
import { ChatSurface } from '@/features/chat/ChatSurface';
import {
  ConversationHeader,
  ConversationHeaderButton,
} from '@/components/ConversationHeader';
import { OrchestratorLauncher } from '@/components/OrchestratorLauncher';
import type { ULID } from '@/features/projects/types';

interface OrchestratorProps {
  project: Project;
  events: WsEnvelope[];
  /** Stable imperative subscription for raw PTY batches. Passed directly to
   *  TerminalModePanel so that terminal output causes zero React re-renders in
   *  the Orchestrator/ChatSurface subtree. See pc-pty-chat-244. */
  subscribeRawTerminal: (cb: (envs: WsEnvelope[]) => void) => () => void;
  aggregates: ChatSessionAggregates;
  send: (msg: WsOutbound) => boolean;
  wsStatus: WsStatus;
  wsDiagnostics: WsDiagnostics;
  applySessionTransition: (transition: SessionTransitionResponse) => void;
  defaultOrchestratorSurface: OrchestratorSurfacePreference;
}

/** Section 31.3 — pick a composer placeholder hint from CC's latest
 *  `session_state_changed` value. Null = no signal seen yet → ChatSurface
 *  uses its default placeholder. */
function composerPlaceholderForSessionState(state: string | null): string | undefined {
  switch (state) {
    case 'requires_action':
      return 'Awaiting your answer…';
    case 'running':
      return 'Orchestrator thinking… type to queue';
    default:
      return undefined;
  }
}

type ComposerAvailability =
  | { mode: 'live'; sendLabel: 'Send ↵'; placeholder?: string }
  | {
      mode: 'queueing';
      sendLabel: 'Queue ↵';
      reason: 'busy' | 'spawning' | 'respawning' | 'queue' | 'jsonl';
      placeholder: string;
    }
  | { mode: 'reconnecting'; disabled: true; reason: string; placeholder: string }
  | { mode: 'inaccessible'; disabled: true; reason: string; placeholder: string };

function legacyHealthFromPtyState(state: string | null): OrchestratorRuntimeHealth | null {
  switch (state) {
    case 'spawning':
      return 'spawning';
    case 'ready':
      return 'ready';
    case 'busy':
    case 'thinking':
      return 'busy';
    case 'exited':
      return 'exited';
    default:
      return null;
  }
}

function composerAvailabilityFor(input: {
  wsStatus: WsStatus;
  health: OrchestratorRuntimeHealth | null;
  waitPoint: OrchestratorRuntimeSnapshot['waitPoint'] | null;
  queueDepth: number;
  latestSessionState: string | null;
  failureReason: string | null;
}): ComposerAvailability {
  if (input.wsStatus !== 'open') {
    return {
      mode: 'reconnecting',
      disabled: true,
      reason: input.wsStatus === 'connecting'
        ? 'Reconnecting to local app'
        : 'Local app connection unavailable',
      placeholder: 'Reconnecting to the local app...',
    };
  }

  if (input.waitPoint === 'queue') {
    const count = Math.max(1, input.queueDepth);
    return {
      mode: 'queueing',
      reason: 'queue',
      sendLabel: 'Queue ↵',
      placeholder: `${count} queued prompt${count === 1 ? '' : 's'}... type to queue`,
    };
  }

  if (input.waitPoint === 'jsonl') {
    return {
      mode: 'queueing',
      reason: 'jsonl',
      sendLabel: 'Queue ↵',
      placeholder: 'Waiting for transcript... type to queue',
    };
  }

  switch (input.health) {
    case 'busy':
      return {
        mode: 'queueing',
        reason: 'busy',
        sendLabel: 'Queue ↵',
        placeholder:
          composerPlaceholderForSessionState(input.latestSessionState) ??
          'Orchestrator thinking... type to queue',
      };
    case 'spawning':
      return {
        mode: 'queueing',
        reason: 'spawning',
        sendLabel: 'Queue ↵',
        placeholder: 'Claude is starting... type to queue',
      };
    case 'respawning':
      return {
        mode: 'queueing',
        reason: 'respawning',
        sendLabel: 'Queue ↵',
        placeholder: 'Claude is restarting... type to queue',
      };
    case 'failed_resume':
      return {
        mode: 'inaccessible',
        disabled: true,
        reason: input.failureReason ?? 'Claude resume failed',
        placeholder: 'Claude resume failed',
      };
    case 'provider_missing':
      return {
        mode: 'inaccessible',
        disabled: true,
        reason: input.failureReason ?? 'History available; Claude resume transcript missing',
        placeholder: 'Claude resume transcript unavailable',
      };
    case 'exited':
      return {
        mode: 'live',
        sendLabel: 'Send ↵',
        placeholder: 'Claude disconnected... send to restart',
      };
    case 'not_spawned':
      return {
        mode: 'live',
        sendLabel: 'Send ↵',
        placeholder: 'Message the orchestrator to start Claude...',
      };
    case 'ready':
    case null:
      return {
        mode: 'live',
        sendLabel: 'Send ↵',
        placeholder: composerPlaceholderForSessionState(input.latestSessionState),
      };
  }
}

function composerStatusMessageFor(
  reason: 'busy' | 'spawning' | 'respawning' | 'queue' | 'jsonl',
  runtimeSnapshot: OrchestratorRuntimeSnapshot | null,
): string {
  switch (reason) {
    case 'busy':
      return runtimeSnapshot?.waitPoint === 'ready_state'
        ? 'Waiting on Claude turn; new messages will queue.'
        : 'Claude is working; new messages will queue.';
    case 'spawning':
      return runtimeSnapshot?.spawnAttempt
        ? `Waiting on Claude spawn attempt ${runtimeSnapshot.spawnAttempt}; you can queue a message.`
        : 'Claude is starting; you can type and queue a message.';
    case 'respawning':
      return runtimeSnapshot?.spawnAttempt
        ? `Waiting on Claude respawn attempt ${runtimeSnapshot.spawnAttempt}; you can queue a message.`
        : 'Claude is restarting; you can type and queue a message.';
    case 'queue':
      return `Waiting on queue: ${Math.max(1, runtimeSnapshot?.queueDepth ?? 1)} prompt${
        (runtimeSnapshot?.queueDepth ?? 1) === 1 ? '' : 's'
      } pending.`;
    case 'jsonl':
      return 'Waiting for Claude transcript JSONL; new messages will queue.';
  }
}

export function Orchestrator({
  project,
  events,
  subscribeRawTerminal,
  aggregates,
  send,
  wsStatus,
  applySessionTransition,
  defaultOrchestratorSurface,
}: OrchestratorProps) {
  // Viewing a past session? When set, the chat panel renders that session's
  // events.jsonl in read-only mode (composer hidden, "Return to live" button).
  const viewingSessionId = useViewingSession((s) => s.bySlug[project.slug] ?? null);
  const setViewing = useViewingSession((s) => s.setViewing);

  // Fetched events for the viewing-past-session case. Lives in component
  // state, refetched when viewingSessionId changes.
  const [pastEvents, setPastEvents] = useState<WsEnvelope[]>([]);
  const [pastLoading, setPastLoading] = useState(false);
  const [pastError, setPastError] = useState<string | null>(null);

  useEffect(() => {
    if (!viewingSessionId) {
      setPastEvents([]);
      setPastError(null);
      return;
    }
    let cancelled = false;
    setPastLoading(true);
    setPastError(null);
    runtimeApi.getSessionEvents(project.id, viewingSessionId)
      .then((raw) => {
        if (cancelled) return;
        // Section 23 — server returns envelope-shape items
        // ({type:'jsonl'|'event', event:...}); wrap with projectId only,
        // preserving the type so the chat panel demuxes correctly between
        // live tailer events (jsonl) and legacy pre-23 hook events.
        const wrapped: WsEnvelope[] = raw.map((env) => ({
          projectId: project.id,
          id: env.id,
          sessionId: env.sessionId,
          seq: env.seq,
          type: env.type,
          kind: env.kind,
          event: env.event as Record<string, unknown>,
          source: env.source,
        }));
        setPastEvents(wrapped);
      })
      .catch((err: Error) => {
        if (!cancelled) setPastError(err.message);
      })
      .finally(() => {
        if (!cancelled) setPastLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [viewingSessionId, project.id]);

  // Active session. Fetched once per project, then patched live from WS
  // session-changed (new-session / resume) + session.title.changed relay frame.
  const [session, setSession] = useState<OrchestratorSession | null>(null);
  const [runtimeSnapshot, setRuntimeSnapshot] =
    useState<OrchestratorRuntimeSnapshot | null>(null);

  // Remote-control status for the footer LED. Resolves the per-project override
  // against the global default (mirrors the server's launch-time resolution).
  // Read-only — it reflects whether sessions launch remote-ready; changing it
  // happens in App / Project settings.
  const [globalRemoteControl, setGlobalRemoteControl] = useState(false);
  useEffect(() => {
    let alive = true;
    void settingsApi.getSettings()
      .then((s) => { if (alive) setGlobalRemoteControl(s.remoteControlEnabled === true); })
      .catch(() => { /* leave default off */ });
    return () => { alive = false; };
  }, []);
  const rc = project.settings.remoteControl;
  const remoteControlActive = rc === 'on' ? true : rc === 'off' ? false : globalRemoteControl;
  useEffect(() => {
    let cancelled = false;
    // Reset immediately so no stale session from the previous project bleeds
    // into this render before the new fetch resolves (pc-pty-chat-403 Part B).
    setSession(null);
    runtimeApi.getActiveSession(project.id)
      .then((s) => {
        if (!cancelled) setSession(s);
      })
      .catch((err) => console.error('[pc] getActiveSession', err));
    return () => {
      cancelled = true;
    };
  }, [project.id]);
  useEffect(() => {
    let cancelled = false;
    setRuntimeSnapshot(null);
    runtimeApi.getOrchestratorRuntime(project.id)
      .then((runtime) => {
        if (!cancelled) setRuntimeSnapshot(runtime);
      })
      .catch((err) => console.error('[pc] getOrchestratorRuntime', err));
    return () => {
      cancelled = true;
    };
  }, [project.id]);
  // `session-changed` is a chat-LIFECYCLE envelope (not a relay fact) — keep it
  // on the events scan.
  useEffect(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === 'session-changed') {
        setSession((e as WsEnvelope & { session: OrchestratorSession }).session);
        break;
      }
    }
  }, [events]);
  // T3.2b — session title (a relay fact) off the identity-keyed live store;
  // latest-by-cursor wins. Separate from the session-changed lifecycle above.
  const titleEvents = useLiveEvents('session-title', project.id);
  useEffect(() => {
    const session = latestSessionFromTitleEvents(titleEvents);
    if (session) setSession(session);
  }, [titleEvents]);
  useEffect(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === 'runtime-state') {
        setRuntimeSnapshot(e as WsEnvelope & OrchestratorRuntimeSnapshot);
        break;
      }
    }
  }, [events]);

  const sourceEvents = viewingSessionId ? pastEvents : events;
  const isViewingPast = viewingSessionId !== null;

  // Session token usage + live model — maintained incrementally in the reducer
  // (O(1) per appended event), handed in as referentially-stable `aggregates`.
  // Preserve the `session?.model` fallback the old liveModel memo had.
  const liveModel = aggregates.latestModel ?? session?.model ?? null;

  // Section 32.4 — publish telemetry into a shared store so App.tsx's
  // slim header can render the same model + token roll-up the StatusBar
  // shows. Section 32.5 adds session id + label so the breadcrumb can
  // host the session-switcher dropdown. Clear on unmount so the header
  // doesn't show stale data when the user switches to a tab without a
  // chat panel.
  const setTelemetry = useOrchestratorTelemetry((s) => s.set);
  const setSessionMeta = useOrchestratorTelemetry((s) => s.setSession);
  const setRuntime = useOrchestratorTelemetry((s) => s.setRuntime);
  const clearTelemetry = useOrchestratorTelemetry((s) => s.clear);
  useEffect(() => {
    setTelemetry({ model: liveModel, usage: aggregates.usage });
  }, [liveModel, aggregates.usage, setTelemetry]);
  useEffect(() => {
    setSessionMeta({
      sessionId: session?.id ?? null,
      sessionLabel: session?.title?.trim() || (session ? 'Untitled session' : null),
    });
  }, [session?.id, session?.title, setSessionMeta]);
  useEffect(() => () => clearTelemetry(), [clearTelemetry]);

  // Section 31.3 — most-recent CC `session_state_changed` value seen in
  // JSONL. States: `idle` / `running` / `requires_action`. Drives the composer
  // placeholder hint when the user needs to act. Maintained incrementally in
  // the reducer; null until the first session-state envelope lands.
  const latestSessionState = aggregates.latestSessionState;

  const latestRuntimeState = useMemo<string | null>(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const env = events[i]!;
      if (env.type === 'state') {
        const state = (env as WsEnvelope & { state?: unknown }).state;
        return typeof state === 'string' ? state : null;
      }
    }
    return null;
  }, [events]);

  // Section 31.8 — latest `jsonl-turn-duration` durationMs. Maintained
  // incrementally in the reducer; null until the first turn lands.
  const lastTurnDurationMs = aggregates.lastTurnDurationMs;

  useEffect(() => {
    setRuntime({ sessionState: aggregates.latestSessionState, lastTurnDurationMs });
  }, [aggregates.latestSessionState, aggregates.lastTurnDurationMs, setRuntime]);

  // Process lifecycle is not chat lifecycle. Hook-level session-end events can
  // be replayed from old claude.exe exits; they should not close an active PC
  // chat. Only the persisted session row decides whether this conversation is
  // structurally ended.
  const sessionEnded = !viewingSessionId && session?.status === 'ended';

  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [startingNewSession, setStartingNewSession] = useState(false);
  // The chat is "open" only after the user explicitly starts or resumes one.
  // Lives in a per-project store (sessionStorage) so it survives tab navigation
  // and renderer reloads within the app session — switching to work-items/etc.
  // unmounts this component, and local state would snap back to the launcher.
  // Clears on app (window) close → fresh launch lands on the launcher.
  const chatOpen = useChatOpen((s) => s.bySlug[project.slug] ?? false);
  const setChatOpenForSlug = useChatOpen((s) => s.setOpen);
  const setChatOpen = (open: boolean) => setChatOpenForSlug(project.slug, open);
  const [resumingHistoryId, setResumingHistoryId] = useState<string | null>(null);

  useEffect(() => {
    setStartingNewSession(false);
    setResumeError(null);
    setResumingHistoryId(null);
  }, [project.id]);

  async function onResume() {
    if (!session?.id || resuming) return;
    setResuming(true);
    setResumeError(null);
    try {
      const transition = await runtimeApi.resumeSession(project.id, session.id);
      applySessionTransition(transition);
      setSession(transition.session);
      setPastEvents([]);
      setViewing(project.slug, null);
      setChatOpen(true);
    } catch (err) {
      setResumeError((err as Error).message);
    } finally {
      setResuming(false);
    }
  }

  async function onNewSession(opts?: { skipConfirm?: boolean }) {
    if (startingNewSession) return;
    if (!opts?.skipConfirm &&
        !confirm('Start a new chat session? Current chat history will be cleared.')) {
      return;
    }
    setStartingNewSession(true);
    try {
      const transition = await runtimeApi.startNewSession(project.id);
      applySessionTransition(transition);
      setSession(transition.session);
      setPastEvents([]);
      setViewing(project.slug, null);
      setChatOpen(true);
      try {
        setRuntimeSnapshot(await runtimeApi.getOrchestratorRuntime(project.id));
      } catch (err) {
        console.error('[pc] getOrchestratorRuntime after new session', err);
      }
    } catch (err) {
      alert(`Couldn't start a new session: ${(err as Error).message}`);
    } finally {
      setStartingNewSession(false);
    }
  }

  /** Resume a specific past session from the launcher history cutout. */
  async function onResumeFromHistory(sessionId: ULID) {
    if (resumingHistoryId) return;
    setResumingHistoryId(sessionId);
    try {
      const transition = await runtimeApi.resumeSession(project.id, sessionId);
      applySessionTransition(transition);
      setSession(transition.session);
      setPastEvents([]);
      setViewing(project.slug, null);
      setChatOpen(true);
    } catch (err) {
      alert(`Couldn't resume: ${(err as Error).message}`);
    } finally {
      setResumingHistoryId(null);
    }
  }

  /** Close the live chat back to the launcher: ends the session + kills the PTY
   *  server-side, then drops this view to the Start-Chat screen. */
  async function onCloseChat() {
    try {
      await runtimeApi.closeSession(project.id);
    } catch (err) {
      console.error('[pc] closeSession', err);
    }
    setSession(null);
    setChatOpen(false);
  }

  const runtimeHealth =
    runtimeSnapshot?.health ?? legacyHealthFromPtyState(latestRuntimeState);
  useEffect(() => {
    if (isViewingPast) return;
    if (runtimeHealth !== 'spawning' && runtimeHealth !== 'respawning') return;

    let cancelled = false;
    const refresh = async () => {
      try {
        const runtime = await runtimeApi.getOrchestratorRuntime(project.id);
        if (!cancelled) setRuntimeSnapshot(runtime);
      } catch (err) {
        console.error('[pc] getOrchestratorRuntime poll', err);
      }
    };

    void refresh();
    const id = setInterval(refresh, 1500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isViewingPast, project.id, runtimeHealth]);
  const runtimeStarting =
    !isViewingPast &&
    !startingNewSession &&
    (runtimeHealth === 'spawning' || runtimeHealth === 'respawning');
  const composerHidden = isViewingPast || sessionEnded;
  const composerAvailability = composerAvailabilityFor({
    wsStatus,
    health: runtimeHealth,
    waitPoint: runtimeSnapshot?.waitPoint ?? null,
    queueDepth: runtimeSnapshot?.queueDepth ?? 0,
    latestSessionState,
    failureReason: runtimeSnapshot?.failureReason ?? null,
  });
  const composerDisabled =
    !composerHidden &&
    (composerAvailability.mode === 'reconnecting' ||
      composerAvailability.mode === 'inaccessible');
  const composerDisabledReason =
    composerAvailability.mode === 'reconnecting' ||
    composerAvailability.mode === 'inaccessible'
      ? composerAvailability.reason
      : undefined;
  const composerPlaceholder = startingNewSession
    ? 'Starting a new chat... type while Claude starts'
    : composerAvailability.placeholder;
  const composerQueueing = composerAvailability.mode === 'queueing';
  const composerSendLabel =
    composerAvailability.mode === 'live' || composerAvailability.mode === 'queueing'
      ? composerAvailability.sendLabel
      : 'Send ↵';
  const composerStatusMessage =
    startingNewSession
      ? 'Starting a new chat; send will unlock when the session is ready.'
      : composerAvailability.mode === 'queueing'
      ? composerStatusMessageFor(composerAvailability.reason, runtimeSnapshot)
      : undefined;
  const inputCapabilities = orchestratorInputCapabilities({
    composerHidden,
    composerDisabled,
    startingNewSession,
    wsStatus,
    runtimeHealth,
    latestRuntimeState,
  });
  const terminalInputFailure = useMemo(
    () => latestTerminalInputFailure(events),
    [events],
  );

  const headerSlot = (
    <ConversationHeader
      title={
        isViewingPast ? (
          <span className="text-muted-foreground">
            Viewing past session <span className="text-foreground/80">(read-only)</span>
          </span>
        ) : session?.title ? (
          <span className="text-foreground">{session.title}</span>
        ) : (
          <span className="italic text-muted-foreground">Untitled session</span>
        )
      }
      titleText={session?.title ?? undefined}
      actions={
        isViewingPast ? (
          <ConversationHeaderButton
            onClick={() => setViewing(project.slug, null)}
            title="Stop viewing this past session and return to the live chat"
          >
            ← Return to live
          </ConversationHeaderButton>
        ) : (
          <>
            <ConversationHeaderButton
              onClick={onCloseChat}
              title="Close this chat and return to the launcher (ends the session; resumable from history)"
            >
              Close Chat
            </ConversationHeaderButton>
            <ConversationHeaderButton
              onClick={() => onNewSession()}
              disabled={startingNewSession}
              title="End the current chat session and start a fresh one"
            >
              {startingNewSession ? 'Starting...' : '+ New session'}
            </ConversationHeaderButton>
          </>
        )
      }
    />
  );

  const startupBannerSlot = startingNewSession ? (
    <div
      className="flex items-center justify-between gap-3 border-t border-border bg-warning/10 px-4 py-2 text-xs text-warning"
      data-testid="session-starting-banner"
      aria-live="polite"
    >
      <span>Starting a new chat session. Clearing the old view and launching Claude.</span>
    </div>
  ) : runtimeStarting ? (
    <div
      className="flex items-center justify-between gap-3 border-t border-border bg-warning/10 px-4 py-2 text-xs text-warning"
      data-testid="session-starting-banner"
      aria-live="polite"
    >
      <span>
        {runtimeHealth === 'respawning'
          ? 'Claude is restarting. You can type now; the message will queue until it is ready.'
          : 'Claude is starting. You can type now; the message will queue until it is ready.'}
      </span>
    </div>
  ) : null;

  const sessionEndedBannerSlot = !isViewingPast && sessionEnded ? (
    <div className="flex items-center justify-between gap-3 border-t border-border bg-warning/10 px-4 py-2 text-xs text-warning">
      <span>
        This session ended. Resume it, or click{' '}
        <span className="font-semibold">+ New session</span> above for a fresh chat.
      </span>
      <div className="flex items-center gap-2">
        {resumeError && (
          <span className="text-red-400">Couldn't resume: {resumeError}</span>
        )}
        <button
          onClick={onResume}
          disabled={resuming || !session?.id}
          title="Resume this conversation as the live chat"
          className="rounded border border-warning/40 bg-card px-3 py-1 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
        >
          {resuming ? 'Resuming…' : 'Resume session'}
        </button>
      </div>
    </div>
  ) : null;

  const terminalInputFailureSlot = !isViewingPast && terminalInputFailure ? (
    <div
      className="flex items-center justify-between gap-3 border-t border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive"
      data-testid="terminal-input-error-banner"
      aria-live="polite"
    >
      <span>Terminal input failed: {terminalInputFailure.message}</span>
    </div>
  ) : null;

  const bannerSlot = startupBannerSlot ?? sessionEndedBannerSlot ?? terminalInputFailureSlot;

  const emptyState = pastLoading ? (
    'Loading session…'
  ) : pastError ? (
    <span className="text-red-400">Error loading session: {pastError}</span>
  ) : isViewingPast ? (
    'This session has no events on disk.'
  ) : startingNewSession ? (
    'Starting a new chat session…'
  ) : runtimeStarting ? (
    'Claude is starting for this session. You can type below; messages will queue until it is ready.'
  ) : (
    'No chat events yet. Send a message below to wake the orchestrator.'
  );

  // Launcher: no chat open in this view (boot/refresh or after Close Chat) and
  // not viewing a past session read-only. Nothing has spawned; the user picks
  // Start Chat (fresh) or resumes from history here.
  if (!isViewingPast && !chatOpen) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1">
          <OrchestratorLauncher
            projectId={project.id}
            projectName={project.name}
            starting={startingNewSession}
            resumingId={resumingHistoryId}
            onStartChat={() => onNewSession({ skipConfirm: true })}
            onResumeSession={onResumeFromHistory}
          />
        </div>
      </div>
    );
  }

  return (
    <ChatSurface
      events={sourceEvents}
      subscribeRawTerminal={subscribeRawTerminal}
      projectId={project.id}
      currentSessionId={session?.projectId === project.id ? session.id : null}
      onSend={(text, clientMessageId) => send({ type: 'send', text, clientMessageId })}
      onInterrupt={() => send({ type: 'interrupt' })}
      onTerminalInput={(data) => send({ type: 'terminal-input', data })}
      onTerminalResize={(cols, rows) => send({ type: 'resize', cols, rows })}
      onAskReply={(toolUseId, answer) =>
        send({ type: 'ask-reply', toolUseId, answer })
      }
      defaultOrchestratorSurface={defaultOrchestratorSurface}
      composerHistoryKey={project.slug}
      composerHidden={composerHidden}
      composerDisabled={composerDisabled}
      composerSendDisabled={startingNewSession}
      composerPlaceholder={composerPlaceholder}
      composerDisabledReason={composerDisabledReason}
      composerQueueing={composerQueueing}
      composerSendLabel={composerSendLabel}
      inputCapabilities={inputCapabilities}
      composerStatusMessage={composerStatusMessage}
      headerSlot={headerSlot}
      bannerSlot={bannerSlot}
      emptyState={emptyState}
      wsStatus={wsStatus}
      remoteControlActive={remoteControlActive}
    />
  );
}
