// Section 19.10 — "+ New workflow" modal (v2-aware).
//
// Mirror of CreateWorkflowModal but for the v2 workflow-builder pod and
// WorkflowGraphV2 visualizer. Two-pane split: chat on the left (~40%), live
// authoring graph on the right (~60%). User can drag nodes + wire edges in the
// visualizer; those edits push back into the server-side draft store so the
// agent picks them up on its next turn (sync-model-A, Section 19 lock 8).
//
// WS envelope contract:
//   workflow-builder-state  — session lifecycle
//   workflow-builder-jsonl  — chat envelopes (consumed by WorkflowBuilderChat)
//   workflow-builder-exit   — session ended
//   workflow-builder-draft  — { sessionId, def } — pushed by the server when
//                             the model calls pc_save_workflow_draft
//   live-event (workflow-definition) — DB-backed `/api/workflows` mutation,
//                             delivered by the slice-015a relay draining the
//                             in-txn `live_outbox` row (slice 015b; replaces the
//                             legacy `workflow-changed` envelope). Close the modal
//                             on the definition `created` (new mode) OR `updated`
//                             matching the slug we're editing (edit mode).
//
// Edit mode: when `editingWorkflow` is supplied, the modal opens with the
// existing def pre-loaded into the visualizer + fires a `[edit-mode
// workflowId="…"]` handoff to the agent once the session reaches `ready`.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { WorkflowV2 } from '@pc/domain';
import { isWorkflowDefinitionChangedLiveEventFrame } from '@pc/contracts';

import type { OrchestratorSurfacePreference } from '@/features/settings/client';
import { transientSessionsApi } from '@/features/transient-sessions/client';
import {
  isTransientSessionState,
  mergeTransientSessionState,
} from '@/features/transient-sessions/events';
import type { WsEnvelope, WsOutbound } from '@/features/runtime/ws-types';
import { WorkflowBuilderChat, type WorkflowBuilderState } from './WorkflowBuilderChat';
import { WorkflowGraphV2 } from './WorkflowGraphV2';

interface EditingWorkflowV2 {
  id: string;
  def: WorkflowV2.Workflow;
  yamlText?: string;
}

interface WorkflowBuilderModalProps {
  projectId: string;
  events: WsEnvelope[];
  send: (msg: WsOutbound) => boolean;
  onClose: () => void;
  /** When set, the modal opens in edit mode — pre-populated draft + edit-mode
   *  handoff sent on boot. */
  editingWorkflow?: EditingWorkflowV2;
}

type SessionState = WorkflowBuilderState;

function buildEditHandoff(editing: EditingWorkflowV2): string {
  return [
    `[edit-mode workflowId="${editing.id}"]`,
    '',
    'Here is the current definition of the v2 workflow the user wants to edit:',
    '',
    '```json',
    JSON.stringify(editing.def, null, 2),
    '```',
    '',
    "Acknowledge in one short line that you've loaded it, then wait for the user to describe what they want to change. Don't restart the interview from scratch — they already authored this. Publish via pc_publish_workflow.",
  ].join('\n');
}

export function WorkflowBuilderModal({
  projectId,
  events,
  send,
  onClose,
  editingWorkflow,
}: WorkflowBuilderModalProps) {
  const isEditMode = Boolean(editingWorkflow);
  const [state, setState] = useState<SessionState>('spawning');
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [draftDef, setDraftDef] = useState<WorkflowV2.Workflow | null>(
    editingWorkflow?.def ?? null,
  );
  const [conversationSurface, setConversationSurface] =
    useState<OrchestratorSurfacePreference>('chat');

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const processedRef = useRef(0);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const handoffSentRef = useRef(false);
  const editingRef = useRef(editingWorkflow);
  editingRef.current = editingWorkflow;

  useEffect(() => {
    let cancelled = false;
    setState('spawning');
    setError(null);
    setSessionId(null);
    setDraftDef(editingRef.current?.def ?? null);
    handoffSentRef.current = false;
    processedRef.current = eventsRef.current.length;
    transientSessionsApi.startWorkflowBuilder(projectId)
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
      void transientSessionsApi.stopWorkflowBuilder(projectId).catch(() => {
        /* best-effort cleanup */
      });
    };
  }, [projectId]);

  // Edit-mode handoff: fire once after the session reaches `ready`.
  useEffect(() => {
    if (!isEditMode) return;
    if (handoffSentRef.current) return;
    if (state !== 'ready') return;
    const editing = editingRef.current;
    if (!editing) return;
    handoffSentRef.current = true;
    const handoff = buildEditHandoff(editing);
    void transientSessionsApi.sendWorkflowBuilder(projectId, handoff).catch((e: unknown) => {
      setError(`failed to send edit-mode handoff: ${(e as Error).message}`);
      handoffSentRef.current = false;
    });
  }, [state, isEditMode, projectId]);

  // Walk new envelopes since last render for the modal-owned concerns: session
  // state, the live draft (visualizer), and the publish signal (close).
  useEffect(() => {
    const start = events.length >= processedRef.current ? processedRef.current : 0;
    const end = events.length;
    processedRef.current = end;
    for (let i = start; i < end; i++) {
      const env = events[i];
      if (!env) continue;
      if (env.type === 'workflow-builder-state') {
        const s = (env as { state?: string }).state;
        if (isTransientSessionState(s)) setState(s);
      } else if (env.type === 'workflow-builder-exit') {
        setState('exited');
      } else if (env.type === 'workflow-builder-draft') {
        const d = env as { sessionId?: string; def?: WorkflowV2.Workflow };
        if (sessionId && d.sessionId && d.sessionId !== sessionId) continue;
        if (d.def && typeof d.def === 'object') {
          setDraftDef(d.def);
        }
      } else if (isWorkflowDefinitionChangedLiveEventFrame(env)) {
        const { change, definition } = env.event.payload;
        if (change === 'deleted') continue;
        const changedSlug = definition?.slug;
        if (isEditMode && editingRef.current) {
          // In edit mode, only the row we're editing closes the modal.
          if (changedSlug && changedSlug !== editingRef.current.id) continue;
          if (change !== 'updated' && change !== 'created') continue;
        } else {
          // In new mode, close on the create.
          if (change !== 'created') continue;
        }
        closeRef.current();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, sessionId]);

  // Push user drags / wires back into the server-side draft store so the
  // agent's next turn sees them. The WS broadcast that follows will re-set
  // `draftDef` to the same value (idempotent) — no infinite loop.
  function handleGraphChange(next: WorkflowV2.Workflow): void {
    setDraftDef(next);
    if (!sessionId) return;
    void transientSessionsApi.saveWorkflowBuilderDraft(projectId, sessionId, next)
      .catch(() => {
        /* best-effort — agent picks up on next read */
      });
  }

  function replyToAsk(toolUseId: string, answer: string): boolean {
    return send({ type: 'ask-reply', toolUseId, answer });
  }

  const statusLabel = useMemo<string>(() => {
    if (error) return error;
    if (state === 'spawning') return 'Starting…';
    if (state === 'thinking') return 'Thinking…';
    if (state === 'exited') return 'Session ended';
    return 'Ready';
  }, [state, error]);

  const title = isEditMode ? `Edit workflow — ${editingWorkflow!.id}` : 'New workflow';
  const subtitle = isEditMode
    ? 'Tell the model what you want to change. Drag nodes to reposition.'
    : 'Interview drives a complete workflow. Drag nodes to reposition; sockets to wire. Close to cancel.';
  const conversation = (
    <WorkflowBuilderChat
      projectId={projectId}
      events={events}
      sessionId={sessionId}
      onAskReply={replyToAsk}
      initialState={state}
      title={title}
      subtitle={subtitle}
      statusLabel={statusLabel}
      onClose={() => closeRef.current()}
      onSurfaceModeChange={setConversationSurface}
    />
  );

  return (
    <div
      role="dialog"
      aria-modal
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="flex h-[92vh] w-[96vw] max-w-[1800px] flex-col border border-border bg-card text-sm shadow-xl">
        {conversationSurface === 'terminal' ? (
          <div className="min-h-0 flex-1 overflow-hidden">{conversation}</div>
        ) : (
          <Group
            orientation="horizontal"
            id="pc-workflow-builder-split"
            className="min-h-0 flex-1 overflow-hidden"
          >
            <Panel id="chat" defaultSize="64%" minSize="50%" className="min-h-0 overflow-hidden">
              {conversation}
            </Panel>
            <Separator className="w-px bg-border transition-colors hover:bg-primary" />
            <Panel id="graph" defaultSize="36%" minSize="24%" className="min-h-0 overflow-hidden">
              <div className="relative h-full min-h-0 w-full">
                <WorkflowGraphV2
                  workflow={draftDef}
                  authoring
                  onChange={handleGraphChange}
                />
              </div>
            </Panel>
          </Group>
        )}
      </div>
    </div>
  );
}
