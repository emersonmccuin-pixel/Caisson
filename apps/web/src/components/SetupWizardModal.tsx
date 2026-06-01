// 5.6 / D82 — Conversational setup wizard modal.
//
// Uses the same shared chat + xterm surface as the orchestrator and the other
// transient agent modals. The only setup-wizard-specific work here is adapting
// `setup-wizard-*` WS envelopes into ChatSurface's standard event/raw shapes.

import { useEffect, useMemo, useRef, useState } from 'react';

import { useLiveEntitySignature } from '@/store/live-store';

import { transientInputCapabilities } from '@/features/chat/runtimeState';
import { transientSessionsApi } from '@/features/transient-sessions/client';
import {
  adaptTransientEvents,
  belongsToTransientSession,
  isTransientSessionState,
  mergeTransientSessionState,
  type TransientSessionState,
} from '@/features/transient-sessions/events';
import { TransientAgentConversation } from '@/components/TransientAgentConversation';
import type { WsEnvelope } from '@/features/runtime/ws-types';

interface SetupWizardModalProps {
  projectId: string;
  events: WsEnvelope[];
  onClose: () => void;
}

type SessionState = TransientSessionState;

export function SetupWizardModal({ projectId, events, onClose }: SetupWizardModalProps) {
  const [state, setState] = useState<SessionState>('spawning');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const processedRef = useRef(0);
  const eventsRef = useRef(events);
  eventsRef.current = events;

  useEffect(() => {
    let cancelled = false;
    setState('spawning');
    setSessionId(null);
    setError(null);
    processedRef.current = eventsRef.current.length;
    transientSessionsApi.startSetupWizard(projectId)
      .then((r) => {
        if (cancelled) return;
        setSessionId(r.sessionId);
        const nextState = r.state;
        if (isTransientSessionState(nextState)) {
          setState((prev) => mergeTransientSessionState(prev, nextState));
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
      void transientSessionsApi.stopSetupWizard(projectId).catch(() => {
        /* best-effort cleanup */
      });
    };
  }, [projectId]);

  // Transient setup-wizard envelopes (state / exit) STAY on the events scan —
  // they are not relay live-event facts (T3.2b keeps these; full removal is T3.3).
  useEffect(() => {
    const start = events.length >= processedRef.current ? processedRef.current : 0;
    const end = events.length;
    processedRef.current = end;
    for (let i = start; i < end; i++) {
      const env = events[i];
      if (!env) continue;
      if (env.type === 'setup-wizard-state') {
        if (!belongsToTransientSession(env, sessionId)) continue;
        const s = (env as { state?: string }).state;
        if (isTransientSessionState(s)) {
          setState(s);
        }
      } else if (env.type === 'setup-wizard-exit') {
        if (!belongsToTransientSession(env, sessionId)) continue;
        setState('exited');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, sessionId]);

  // T3.2b — auto-close when CLAUDE.md gets written, off the identity-keyed live
  // store signature. Q2: capture the baseline at mount so a pre-existing frame
  // doesn't close the wizard immediately; only close when the signature CHANGES.
  const claudeMdSig = useLiveEntitySignature('project-claude-md', projectId);
  const claudeMdBaselineRef = useRef<string | null>(null);
  if (claudeMdBaselineRef.current === null) claudeMdBaselineRef.current = claudeMdSig;
  useEffect(() => {
    if (claudeMdBaselineRef.current === null) {
      claudeMdBaselineRef.current = claudeMdSig;
      return;
    }
    if (claudeMdSig !== claudeMdBaselineRef.current) {
      closeRef.current();
    }
  }, [claudeMdSig]);

  const adapted = useMemo(
    () =>
      adaptTransientEvents({
        events,
        projectId,
        sessionId,
        initialState: state,
        prefix: 'setup-wizard',
        includeSessionIdOnJsonl: true,
      }),
    [events, projectId, sessionId, state],
  );

  const statusLabel = useMemo<string>(() => {
    if (error) return error;
    if (adapted.state === 'spawning') return 'Starting...';
    if (adapted.state === 'thinking') return 'Thinking...';
    if (adapted.state === 'exited') return 'Session ended';
    return 'Ready';
  }, [adapted.state, error]);

  const emptyState =
    adapted.state === 'spawning'
      ? 'Starting setup-wizard...'
      : adapted.state === 'exited'
        ? 'Session ended.'
        : "Ready. Type below to answer the setup wizard.";

  const composerPlaceholder =
    adapted.state === 'spawning'
      ? 'Waiting for session to start...'
      : adapted.state === 'exited'
        ? 'Session ended. Close to dismiss.'
        : 'Answer the wizard. Enter sends, Shift+Enter for a newline.';

  return (
    <div
      role="dialog"
      aria-modal
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="flex h-[92vh] w-[96vw] max-w-[1600px] flex-col border border-border bg-card text-sm shadow-xl">
        <TransientAgentConversation
          events={adapted.envelopes}
          projectId={projectId}
          sessionId={sessionId}
          title={<span className="text-foreground">Project setup</span>}
          titleText="Project setup"
          subtitle="Quick interview that writes your project's CLAUDE.md. Close to cancel."
          statusLabel={statusLabel}
          onClose={() => closeRef.current()}
          onSend={(text) => {
            void transientSessionsApi.sendSetupWizard(projectId, text).catch(() => {
              /* surfaced by state/error paths when available */
            });
            return true;
          }}
          onInterrupt={() => {
            void transientSessionsApi.interruptSetupWizard(projectId).catch(() => {
              /* best-effort */
            });
            return true;
          }}
          onTerminalInput={(data) => {
            void transientSessionsApi.sendSetupWizardTerminalInput(projectId, data).catch(() => {
              /* best-effort */
            });
            return true;
          }}
          onTerminalResize={(cols, rows) => {
            void transientSessionsApi.resizeSetupWizard(projectId, cols, rows).catch(() => {
              /* best-effort */
            });
            return true;
          }}
          composerHistoryKey={`setup-wizard:${projectId}`}
          inputCapabilities={transientInputCapabilities(adapted.state)}
          composerPlaceholder={composerPlaceholder}
          emptyState={emptyState}
        />
      </div>
    </div>
  );
}
