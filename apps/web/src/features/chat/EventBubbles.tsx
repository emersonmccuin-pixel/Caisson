import { useMemo, useState, type ReactNode } from 'react';
import { Copy as CopyIcon } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import { ExternalLink } from '@/components/ExternalLink';
import { LiveRichLink } from '@/components/LiveRichLink';
import type {
  ApprovalRequiredEvent,
  AssistantEvent,
  ChatEvent,
  SubagentFailureEvent,
  SystemEvent,
  TaskEndEvent,
  TaskStartEvent,
  ThinkingEvent,
  TodosEvent,
  UserEvent,
} from '@/features/runtime/ws-types';
import { parseUserText, type UserPart } from '@/lib/parse-chat-text';
import {
  FailureBubble,
  TaskEndBubble,
  TaskStartBubble,
  TodosBubble,
} from '@/features/chat/AgentWorkflowBubbles';
import { ApprovalBubble } from '@/features/chat/approvals';
import {
  CompactBoundaryRule,
  MicrocompactDivider,
  NotificationRow,
  SystemBubble,
  TurnFooterChips,
} from '@/features/chat/SystemBubbles';
import type { PendingPromptStatus, PendingUserEvent } from '@/features/chat/types';

export const SUPPRESSED_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  'bridge_status',
  'init',
  'session_state_changed',
  'stop_hook_summary',
  'compact_boundary',
  'microcompact_boundary',
  'turn_duration',
  'post_turn_summary',
]);

// CC's `Notification` hook fires for idle prompts, OS-toast messages, and
// other non-actionable noise. Suppress the ones that have a dedicated UI
// elsewhere (the prompt-waiting indicator lives in the input footer) — they
// stay in JSONL for telemetry / OS-level notification routing.
const SUPPRESSED_NOTIFICATION_PATTERNS: readonly RegExp[] = [
  /is waiting for your input/i,
  /is no longer responding to user input/i,
];

function formatChatTime(ts?: string): string | undefined {
  if (!ts) return undefined;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export type ChatTurnStatus = 'warning' | 'info' | 'danger';
type ChatTurnVariant = 'turn' | 'child';

export function pendingStatusLabel(event: PendingUserEvent): string {
  const queuedPrefix = event.pendingQueued ? 'queued · ' : '';
  switch (event.pendingStatus) {
    case 'server-received':
      return event.pendingReason ? `${queuedPrefix}sent · ${event.pendingReason}` : `${queuedPrefix}sent`;
    case 'waiting-transcript':
      return event.pendingReason
        ? `${queuedPrefix}waiting for transcript · ${event.pendingReason}`
        : `${queuedPrefix}waiting for transcript`;
    case 'unconfirmed':
      return `${queuedPrefix}send unconfirmed`;
    case 'failed':
      return event.pendingReason ? `${queuedPrefix}not sent · ${event.pendingReason}` : `${queuedPrefix}not sent`;
    case 'sending':
    default:
      return event.pendingQueued ? 'queued' : 'sending';
  }
}

export function pendingStatusTone(status: PendingPromptStatus): ChatTurnStatus {
  if (status === 'failed') return 'danger';
  if (status === 'waiting-transcript' || status === 'unconfirmed') return 'warning';
  return 'info';
}

export function ChatTurnCard({
  kind,
  ts,
  sub,
  children,
  bubbleId,
  status,
  pendingStatus,
  variant = 'turn',
  copyText,
}: {
  kind: 'user' | 'pm';
  ts?: string;
  sub?: string;
  children: ReactNode;
  bubbleId?: string;
  status?: ChatTurnStatus;
  pendingStatus?: PendingPromptStatus;
  variant?: ChatTurnVariant;
  copyText?: string | null;
}) {
  // Child variant: just the smaller card. No avatar / speaker chrome —
  // child renderers (tool group, agent dispatch, workflow run, edit) carry
  // their own header rows.
  if (variant === 'child') {
    return (
      <div className="chat-turn-child" data-bubble-id={bubbleId}>
        {children}
      </div>
    );
  }

  const name = kind === 'user' ? 'You' : 'Claude';
  const avatarText = kind === 'user' ? 'YOU' : 'CC';
  const time = formatChatTime(ts);
  const subParts = [time, sub].filter((x): x is string => Boolean(x));

  const cardClasses = [
    'chat-turn',
    kind === 'user' ? 'chat-turn-user' : '',
    status ? `chat-turn-${status}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className="chat-turn-row"
      data-bubble-id={bubbleId}
      data-role={kind === 'user' ? 'user' : 'assistant'}
      data-pending-status={pendingStatus}
    >
      <div className={`chat-avatar${kind === 'user' ? ' chat-avatar-user' : ''}`}>
        {avatarText}
      </div>
      <div className="chat-turn-col">
        <div className="chat-turn-speaker">
          <span className={`chat-turn-name${kind === 'user' ? ' chat-turn-name-user' : ''}`}>
            {name}
          </span>
          {subParts.length > 0 && (
            <span className="chat-turn-sub">{subParts.join(' · ')}</span>
          )}
          {copyText && <CopyButton text={copyText} />}
        </div>
        <div className={cardClasses}>{children}</div>
      </div>
    </div>
  );
}

interface EventBubbleProps {
  event: ChatEvent;
  projectId: string;
  resolvedApprovals: Record<string, { approved: boolean; response: string }>;
  onApprovalResolved: (
    workflowRunId: string,
    nodeId: string,
    approved: boolean,
    response: string,
  ) => void;
}

export function EventBubble({
  event,
  projectId,
  resolvedApprovals,
  onApprovalResolved,
}: EventBubbleProps) {
  switch (event.kind) {
    case 'user':
      return <UserBubble event={event as UserEvent} projectId={projectId} />;
    case 'assistant':
      return <AssistantBubble event={event as AssistantEvent} projectId={projectId} />;
    case 'thinking':
      return <ThinkingBubble event={event as ThinkingEvent} />;
    case 'tool-start':
    case 'tool-end':
      return null;
    case 'todos':
      return <TodosBubble event={event as TodosEvent} />;
    case 'task-start':
      return <TaskStartBubble event={event as TaskStartEvent} />;
    case 'task-end':
      return <TaskEndBubble event={event as TaskEndEvent} />;
    case 'approval-required':
      return (
        <ApprovalBubble
          event={event as ApprovalRequiredEvent}
          projectId={projectId}
          resolved={
            resolvedApprovals[
              `${(event as ApprovalRequiredEvent).workflowRunId}:${(event as ApprovalRequiredEvent).nodeId}`
            ]
          }
          onResolved={onApprovalResolved}
        />
      );
    case 'subagent-failure':
      return <FailureBubble event={event as SubagentFailureEvent} />;
    case 'system': {
      const sys = event as SystemEvent;
      if (SUPPRESSED_SYSTEM_SUBTYPES.has(sys.subtype)) return null;
      return <SystemBubble event={sys} />;
    }
    case 'queue-enqueue':
      return <QueueIndicator text="queued" />;
    case 'queue-dequeue':
      return <QueueIndicator text="dequeued" />;
    // Section 31 — typed-envelope renderers for the kept JSONL signals that
    // need distinct visual shapes vs. the generic system-row bubble.
    case 'session-state':
      return <SessionStateDivider event={event as { state: string; permissionMode?: string | null }} />;
    case 'compact-boundary':
      return (
        <CompactBoundaryRule
          event={
            event as {
              trigger?: string | null;
              preTokens?: number | null;
              messagesSummarized?: number | null;
            }
          }
        />
      );
    case 'microcompact':
      return (
        <MicrocompactDivider
          event={
            event as {
              tokensSaved?: number | null;
              preTokens?: number | null;
            }
          }
        />
      );
    case 'turn-footer':
      return (
        <TurnFooterChips
          event={
            event as {
              speed?: string | null;
              cacheMissReason?: string | null;
              model?: string | null;
            }
          }
        />
      );
    case 'notification': {
      const note = event as { message: string; title?: string | null };
      if (
        note.message &&
        SUPPRESSED_NOTIFICATION_PATTERNS.some((re) => re.test(note.message))
      ) {
        return null;
      }
      return <NotificationRow event={note} />;
    }
    case 'session-end':
    case 'subagent-stop':
      return null;
    default:
      return null;
  }
}

export function copyTextForEvent(event: ChatEvent): string | null {
  if (event.kind === 'assistant') {
    const text = (event as AssistantEvent).text ?? '';
    return text.trim() ? text : null;
  }
  if (event.kind === 'user') {
    const text = (event as UserEvent).text ?? '';
    const visible = parseUserText(text)
      .filter((p) => p.kind !== 'workflow-event' && p.kind !== 'agent-event')
      .map((p) => p.text)
      .join('');
    return visible.trim() ? visible : null;
  }
  if (event.kind === 'task-end') {
    const text = (event as TaskEndEvent).result ?? '';
    return text.trim() ? text : null;
  }
  return null;
}

export function QueueIndicator({ text }: { text: string }) {
  return (
    <div className="self-center px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/70">
      · {text} ·
    </div>
  );
}

const SESSION_STATE_LABEL: Record<string, string> = {
  idle: 'idle',
  running: 'running',
  requires_action: 'awaiting input',
};

export function SessionStateDivider({
  event,
}: {
  event: { state: string; permissionMode?: string | null };
}) {
  const label = SESSION_STATE_LABEL[event.state] ?? event.state.replace(/_/g, ' ');
  return (
    <div className="self-center flex w-full items-center gap-2 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
      <span className="h-px flex-1 bg-border" />
      <span>· {label} ·</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          })
          .catch(() => {
            /* clipboard unavailable */
          });
      }}
      title={copied ? 'Copied' : 'Copy to clipboard'}
      aria-label={copied ? 'Copied to clipboard' : 'Copy message to clipboard'}
      className="chat-copy-button"
    >
      <CopyIcon className="h-3 w-3" aria-hidden />
      <span>{copied ? 'Copied' : label}</span>
    </button>
  );
}

export function UserBubble({ event, projectId }: { event: UserEvent; projectId: string }) {
  const parts = useMemo(() => {
    const all = parseUserText(event.text ?? '');
    return all.filter((p) => p.kind !== 'workflow-event' && p.kind !== 'agent-event');
  }, [event.text]);
  if (parts.length === 0) return null;
  // Group consecutive non-channel parts (text + rich-link + external-link)
  // into one block so links render inline with their surrounding text.
  const groups: Array<{ kind: 'channel'; part: UserPart } | { kind: 'inline'; parts: UserPart[] }> = [];
  for (const p of parts) {
    if (p.kind === 'channel') {
      groups.push({ kind: 'channel', part: p });
    } else {
      const last = groups[groups.length - 1];
      if (last && last.kind === 'inline') last.parts.push(p);
      else groups.push({ kind: 'inline', parts: [p] });
    }
  }
  return (
    <>
      {groups.map((g, idx) =>
        g.kind === 'channel' ? (
          <div key={idx} className="group relative text-sm">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-warning">
              channel · {g.part.source}
            </div>
            <div className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
              {g.part.text || '(empty body)'}
            </div>
          </div>
        ) : (
          <div key={idx} className="group relative text-sm text-foreground">
            <div className="whitespace-pre-wrap break-words">
              {g.parts.map((part, j) => renderInlinePart(part, j, projectId)) || '(empty prompt)'}
            </div>
          </div>
        ),
      )}
    </>
  );
}

// Factory for react-markdown's anchor renderer. ProjectId is closed-over so
// hover handlers can route to the preview store. Routes pc:// to RichLink,
// http(s):// to ExternalLink, anything else to a bare anchor.
function makeMarkdownAnchor(projectId: string) {
  return function MarkdownAnchor({
    href,
    children,
  }: {
    href?: string;
    children?: ReactNode;
  }) {
    if (!href) return <span>{children}</span>;
    if (href.startsWith('pc://')) {
      const m = href.match(/^pc:\/\/([\w-]+)\/(.+)$/);
      if (m) {
        const kind = m[1] as 'work-item' | 'file' | 'attachment' | 'inbox';
        if (kind === 'work-item' || kind === 'file' || kind === 'attachment' || kind === 'inbox') {
          const ref = decodeURIComponent(m[2] ?? '');
          const text = typeof children === 'string' ? children : '';
          return (
            <LiveRichLink
              kind={kind}
              ref={ref}
              text={text || ref}
              url={href}
              projectId={projectId}
            >
              {children}
            </LiveRichLink>
          );
        }
      }
    }
    if (href.startsWith('http://') || href.startsWith('https://')) {
      return (
        <ExternalLink href={href} insecure={href.startsWith('http://')}>
          {children}
        </ExternalLink>
      );
    }
    return <a href={href}>{children}</a>;
  };
}

function renderInlinePart(part: UserPart, key: number, projectId: string) {
  if (part.kind === 'rich-link' && part.richLinkKind && part.richLinkRef && part.url) {
    return (
      <LiveRichLink
        key={key}
        kind={part.richLinkKind}
        ref={part.richLinkRef}
        text={part.linkText ?? part.text}
        url={part.url}
        projectId={projectId}
      />
    );
  }
  if (part.kind === 'external-link' && part.url) {
    return (
      <ExternalLink
        key={key}
        href={part.url}
        text={part.linkText ?? part.text}
        insecure={part.externalInsecure}
      />
    );
  }
  return <span key={key}>{part.text}</span>;
}

export function ThinkingBubble({ event }: { event: ThinkingEvent }) {
  const [expanded, setExpanded] = useState(false);
  const text = event.text ?? '';
  const preview = text.replace(/\s+/g, ' ').trim();
  return (
    <button
      type="button"
      onClick={() => setExpanded((e) => !e)}
      title={expanded ? 'Collapse thinking' : 'Expand thinking'}
      className="w-full text-left text-[11px] italic text-muted-foreground/55 hover:text-muted-foreground/80 transition-colors"
    >
      {expanded ? (
        <div className="whitespace-pre-wrap font-mono text-muted-foreground/75">
          <span className="mr-1 not-italic opacity-60">💭</span>
          {text}
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 not-italic opacity-60">💭</span>
          <span className="truncate">{preview || 'Thinking'}</span>
        </div>
      )}
    </button>
  );
}

export function AssistantBubble({ event, projectId }: { event: AssistantEvent; projectId: string }) {
  const text = event.text ?? '';
  if (!text) {
    return (
      <div className="text-sm italic text-muted-foreground">
        {event.transcriptPath
          ? `(no assistant text — transcript empty or missing at ${event.transcriptPath})`
          : '(no transcript path provided by Stop hook)'}
      </div>
    );
  }
  const Anchor = useMemo(() => makeMarkdownAnchor(projectId), [projectId]);
  return (
    <div className="group relative text-sm text-foreground">
      {event.midLoop && (
        <div className="mb-1.5 inline-block border border-border/40 bg-muted/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/60">
          preamble
        </div>
      )}
      <div className="markdown-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkBreaks]}
          // react-markdown v10's default urlTransform drops unknown schemes
          // (http / https / mailto / tel only). pc:// gets stripped, so the
          // custom anchor renderer below never sees the href and the rich-
          // link never materialises. Pass through any pc:// + the safe
          // defaults; everything else falls back to react-markdown's behavior.
          urlTransform={passthroughPcUrlTransform}
          components={{ a: Anchor }}
        >
          {text}
        </ReactMarkdown>
      </div>
    </div>
  );
}

/** react-markdown's default `urlTransform` drops unknown schemes. We need
 *  pc:// links to reach the custom anchor renderer; defer the rest to the
 *  default behavior (which strips javascript: and similar XSS vectors). */
function passthroughPcUrlTransform(url: string): string {
  if (url.startsWith('pc://')) return url;
  return defaultUrlTransform(url);
}

// react-markdown v10's exported default urlTransform — re-implemented inline
// so we don't depend on it. Mirrors the upstream behavior: allow http(s),
// mailto, tel, irc(s), and a few other safe schemes; strip everything else.
const SAFE_PROTOCOL = /^(?:https?|mailto|tel|ircs?|news|gopher|nntp|feed|fax|ldap[is]?):/i;
function defaultUrlTransform(url: string): string {
  const colon = url.indexOf(':');
  if (colon === -1) return url;
  const question = url.indexOf('?');
  const hash = url.indexOf('#');
  const slash = url.indexOf('/');
  if (
    (slash !== -1 && colon > slash) ||
    (question !== -1 && colon > question) ||
    (hash !== -1 && colon > hash)
  ) {
    return url;
  }
  if (SAFE_PROTOCOL.test(url)) return url;
  return '';
}
