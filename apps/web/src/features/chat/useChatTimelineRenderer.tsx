import { useCallback, useState, type ReactNode } from 'react';

import { AskCard } from '@/components/AskCard';
import {
  AgentDispatchGroupBubble,
  SidechainGroupBubble,
  WorkflowRunGroupBubble,
} from '@/features/chat/AgentWorkflowBubbles';
import {
  ChatTurnCard,
  type ChatTurnStatus,
  copyTextForEvent,
  EventBubble,
  pendingStatusLabel,
  pendingStatusTone,
  SUPPRESSED_SYSTEM_SUBTYPES,
} from '@/features/chat/EventBubbles';
import { formatElapsed } from '@/features/chat/ThinkingIndicator';
import { EditBubble, ToolGroupBubble } from '@/features/chat/ToolBubbles';
import type {
  ApprovalRequiredEvent,
  ChatEvent,
  SystemEvent,
  TaskEndEvent,
  TaskStartEvent,
  WsEnvelope,
} from '@/features/runtime/ws-types';

import type { PendingPromptStatus, RenderItem } from './types';
import { isPendingUserEvent } from './usePendingPrompts';

export function useChatTimelineRenderer({
  projectId,
  renderItems,
  onAskReply,
}: {
  projectId: string;
  renderItems: RenderItem[];
  onAskReply?: (toolUseId: string, answer: string) => boolean;
}): (item: RenderItem, index: number) => ReactNode {
  const [resolvedApprovals, setResolvedApprovals] = useState<
    Record<string, { approved: boolean; response: string }>
  >({});
  const [answeredAsks, setAnsweredAsks] = useState<Record<string, string>>({});

  const markApprovalResolved = useCallback(
    (
      workflowRunId: string,
      nodeId: string,
      approved: boolean,
      response: string,
    ) => {
      setResolvedApprovals((prev) => ({
        ...prev,
        [`${workflowRunId}:${nodeId}`]: { approved, response },
      }));
    },
    [],
  );

  return useCallback(
    (item: RenderItem, idx: number): ReactNode => {
      if (item.kind === 'tool-group') {
        return (
          <ChatTurnCard key={item.key} kind="pm" variant="child">
            <ToolGroupBubble calls={item.calls} />
          </ChatTurnCard>
        );
      }
      if (item.kind === 'edit') {
        return (
          <ChatTurnCard key={item.key} kind="pm" variant="child">
            <EditBubble call={item.call} />
          </ChatTurnCard>
        );
      }
      if (item.kind === 'workflow-run-group') {
        return (
          <ChatTurnCard key={item.key} kind="pm" variant="child">
            <WorkflowRunGroupBubble
              workflowRunId={item.workflowRunId}
              events={item.events}
            />
          </ChatTurnCard>
        );
      }
      if (item.kind === 'agent-dispatch-group') {
        return (
          <ChatTurnCard key={item.key} kind="pm" variant="child">
            <AgentDispatchGroupBubble
              agentRunId={item.agentRunId}
              agentName={item.agentName}
              events={item.events}
            />
          </ChatTurnCard>
        );
      }
      if (item.kind === 'sidechain-group') {
        return (
          <ChatTurnCard key={item.key} kind="pm" variant="child">
            <SidechainGroupBubble steps={item.steps} />
          </ChatTurnCard>
        );
      }
      const env = item.env;
      let assistantDurationMs: number | undefined;
      if (env.type === 'event') {
        const ev = (env as WsEnvelope & { event: ChatEvent }).event;
        if (ev?.kind === 'assistant') {
          for (let j = idx + 1; j < renderItems.length; j++) {
            const next = renderItems[j]!;
            if (next.kind !== 'env') continue;
            if (next.env.type !== 'event') continue;
            const nev = (next.env as WsEnvelope & { event: ChatEvent }).event;
            if (!nev || typeof nev !== 'object') continue;
            if (nev.kind === 'user' || nev.kind === 'assistant') break;
            if (nev.kind === 'system') {
              const sys = nev as SystemEvent;
              if (sys.subtype === 'turn_duration') {
                const raw = sys.raw as { durationMs?: number } | undefined;
                if (typeof raw?.durationMs === 'number') {
                  assistantDurationMs = raw.durationMs;
                }
                break;
              }
            }
          }
        }
      }
      if (env.type === 'ask') {
        const askEnv = env as WsEnvelope & {
          toolName: string;
          toolUseId: string;
          toolInput: unknown;
          ts?: string;
        };
        const answered = answeredAsks[askEnv.toolUseId];
        return (
          <ChatTurnCard
            key={item.key}
            kind="pm"
            ts={askEnv.ts}
            sub={askEnv.toolName === 'ExitPlanMode' ? 'plan ready' : 'asking'}
            status="info"
          >
            <AskCard
              toolName={askEnv.toolName}
              toolUseId={askEnv.toolUseId}
              toolInput={askEnv.toolInput}
              answered={answered}
              onReply={(answer) => {
                if (!onAskReply) return;
                if (onAskReply(askEnv.toolUseId, answer)) {
                  setAnsweredAsks((prev) => ({
                    ...prev,
                    [askEnv.toolUseId]: answer,
                  }));
                }
              }}
            />
          </ChatTurnCard>
        );
      }
      const ev = (env as WsEnvelope & { event: ChatEvent }).event;
      if (!ev || typeof ev !== 'object') return null;
      if (ev.kind === 'queue-enqueue' || ev.kind === 'queue-dequeue') {
        return (
          <EventBubble
            key={item.key}
            event={ev}
            projectId={projectId}
            resolvedApprovals={resolvedApprovals}
            onApprovalResolved={markApprovalResolved}
          />
        );
      }
      // Thinking blocks render as a self-contained collapsed row — no avatar/
      // speaker chrome. The ThinkingBubble handles its own expand/collapse.
      if (ev.kind === 'thinking') {
        return (
          <EventBubble
            key={item.key}
            event={ev}
            projectId={projectId}
            resolvedApprovals={resolvedApprovals}
            onApprovalResolved={markApprovalResolved}
          />
        );
      }
      if (ev.kind === 'system') {
        const sys = ev as SystemEvent;
        if (SUPPRESSED_SYSTEM_SUBTYPES.has(sys.subtype)) {
          return null;
        }
        if (sys.level !== 'error') {
          return (
            <EventBubble
              key={item.key}
              event={ev}
              projectId={projectId}
              resolvedApprovals={resolvedApprovals}
              onApprovalResolved={markApprovalResolved}
            />
          );
        }
      }
      const turnKind: 'user' | 'pm' = ev.kind === 'user' ? 'user' : 'pm';
      let bubbleId: string | undefined;
      if (ev.kind === 'approval-required') {
        const ar = ev as ApprovalRequiredEvent;
        bubbleId = `approval-${ar.workflowRunId}-${ar.nodeId}`;
      }
      let sub: string | undefined;
      let status: ChatTurnStatus | undefined;
      let pendingStatus: PendingPromptStatus | undefined;
      if (isPendingUserEvent(ev)) {
        pendingStatus = ev.pendingStatus;
        sub = pendingStatusLabel(ev);
        status = pendingStatusTone(ev.pendingStatus);
        bubbleId = `pending-${ev.pendingClientMessageId}`;
      } else if (ev.kind === 'assistant' && typeof assistantDurationMs === 'number') {
        sub = formatElapsed(assistantDurationMs);
      } else if (ev.kind === 'approval-required') {
        sub = 'approval required';
        status = 'warning';
      } else if (ev.kind === 'subagent-failure') {
        sub = 'subagent failed';
        status = 'danger';
      } else if (ev.kind === 'todos') {
        sub = 'todos';
      } else if (ev.kind === 'task-start') {
        const t = ev as TaskStartEvent;
        sub = t.subagent ? `${t.subagent} · delegated` : 'delegated';
      } else if (ev.kind === 'task-end') {
        const t = ev as TaskEndEvent;
        sub = t.subagent ? `${t.subagent} · returned` : 'returned';
      } else if (ev.kind === 'system') {
        const sys = ev as SystemEvent;
        sub = sys.subtype.replace(/_/g, ' ');
        if (sys.level === 'error') status = 'danger';
      }
      return (
        <ChatTurnCard
          key={item.key}
          kind={turnKind}
          ts={ev.ts}
          sub={sub}
          bubbleId={bubbleId}
          status={status}
          pendingStatus={pendingStatus}
          copyText={copyTextForEvent(ev)}
        >
          <EventBubble
            event={ev}
            projectId={projectId}
            resolvedApprovals={resolvedApprovals}
            onApprovalResolved={markApprovalResolved}
          />
        </ChatTurnCard>
      );
    },
    [
      answeredAsks,
      markApprovalResolved,
      onAskReply,
      projectId,
      renderItems,
      resolvedApprovals,
    ],
  );
}
