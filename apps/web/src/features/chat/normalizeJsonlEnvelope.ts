import type {
  JsonlEvent,
  SystemEvent,
  TodoItem,
  TodosEvent,
  WsEnvelope,
} from '@/features/runtime/ws-types';

/** Derive todos snapshots from JSONL tool-calls. */
export function injectTodoSnapshots(events: WsEnvelope[]): WsEnvelope[] {
  type Row = {
    id: string;
    subject: string;
    description: string;
    activeForm: string;
    status: TodoItem['status'];
  };
  const state = new Map<string, Row>();
  const out: WsEnvelope[] = [];

  const snapshot = (): TodoItem[] =>
    Array.from(state.values())
      .sort((a, b) => {
        const an = Number(a.id);
        const bn = Number(b.id);
        if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
        return a.id.localeCompare(b.id);
      })
      .map((r) => ({
        content: r.subject,
        activeForm: r.activeForm,
        status: r.status,
      }));

  for (const env of events) {
    out.push(env);
    if (env.type !== 'jsonl') continue;
    const ev = env.event as JsonlEvent | undefined;
    if (!ev || ev.kind !== 'jsonl-tool-call') continue;
    const input = (ev.input ?? {}) as Record<string, unknown>;
    const name = ev.name;
    let changed = false;
    if (name === 'TodoWrite' && Array.isArray(input.todos)) {
      state.clear();
      const todos = input.todos as Array<Record<string, unknown>>;
      for (let i = 0; i < todos.length; i++) {
        const t = todos[i] ?? {};
        const id = String(t.id ?? i + 1);
        state.set(id, {
          id,
          subject: String(t.content ?? ''),
          description: '',
          activeForm: String(t.activeForm ?? ''),
          status: (t.status as TodoItem['status']) ?? 'pending',
        });
      }
      changed = true;
    } else if (name === 'TaskCreate') {
      const id = String(input.id ?? ev.toolUseId);
      state.set(id, {
        id,
        subject: String(input.subject ?? ''),
        description: String(input.description ?? ''),
        activeForm: String(input.activeForm ?? ''),
        status: 'pending',
      });
      changed = true;
    } else if (name === 'TaskUpdate') {
      const id = String(input.taskId ?? '');
      if (id) {
        const existing = state.get(id) ?? {
          id,
          subject: '',
          description: '',
          activeForm: '',
          status: 'pending' as const,
        };
        state.set(id, {
          ...existing,
          subject: typeof input.subject === 'string' ? input.subject : existing.subject,
          description:
            typeof input.description === 'string'
              ? input.description
              : existing.description,
          activeForm:
            typeof input.activeForm === 'string'
              ? input.activeForm
              : existing.activeForm,
          status: (input.status as TodoItem['status']) ?? existing.status,
        });
        changed = true;
      }
    }
    if (changed) {
      out.push({
        projectId: env.projectId,
        type: 'event',
        event: { kind: 'todos', todos: snapshot() } satisfies TodosEvent,
      });
    }
  }
  return out;
}

/** Convert a jsonl envelope into a hook-shape envelope for chat rendering. */
export function normalizeJsonlEnvelope(env: WsEnvelope): WsEnvelope | null {
  if (env.type !== 'jsonl') return env;
  const ev = env.event as JsonlEvent | undefined;
  if (!ev || typeof ev !== 'object') return null;
  switch (ev.kind) {
    case 'jsonl-user':
      return {
        projectId: env.projectId,
        type: 'event',
        event: { kind: 'user', text: ev.text },
      };
    case 'jsonl-turn-end':
      if (!ev.text) return null;
      return {
        projectId: env.projectId,
        type: 'event',
        event: { kind: 'assistant', text: ev.text },
      };
    case 'jsonl-assistant-text':
      if (!ev.text) return null;
      return {
        projectId: env.projectId,
        type: 'event',
        event: { kind: 'assistant', text: ev.text, midLoop: ev.midLoop },
      };
    case 'jsonl-tool-call':
      return {
        projectId: env.projectId,
        type: 'event',
        event: {
          kind: 'tool-start',
          tool: ev.name,
          toolUseId: ev.toolUseId,
          input: ev.input,
        },
      };
    case 'jsonl-tool-result':
      return {
        projectId: env.projectId,
        type: 'event',
        event: {
          kind: 'tool-end',
          tool: '',
          toolUseId: ev.toolUseId,
          result: ev.result,
        },
      };
    case 'jsonl-system':
      return {
        projectId: env.projectId,
        type: 'event',
        event: {
          kind: 'system',
          subtype: ev.subtype,
          level: ev.level,
          message: ev.message,
          raw: ev.raw,
          ts: ev.timestamp ?? undefined,
        } satisfies SystemEvent,
      };
    case 'jsonl-queue-enqueue':
    case 'jsonl-queue-dequeue':
      return null;
    case 'jsonl-session-state':
      return {
        projectId: env.projectId,
        type: 'event',
        event: {
          kind: 'session-state',
          state: ev.state,
          permissionMode: ev.permissionMode,
          ts: ev.timestamp ?? undefined,
        },
      };
    case 'jsonl-compact':
      return {
        projectId: env.projectId,
        type: 'event',
        event: {
          kind: 'compact-boundary',
          trigger: ev.trigger,
          preTokens: ev.preTokens,
          messagesSummarized: ev.messagesSummarized,
          ts: ev.timestamp ?? undefined,
        },
      };
    case 'jsonl-microcompact':
      return {
        projectId: env.projectId,
        type: 'event',
        event: {
          kind: 'microcompact',
          trigger: ev.trigger,
          preTokens: ev.preTokens,
          tokensSaved: ev.tokensSaved,
          ts: ev.timestamp ?? undefined,
        },
      };
    case 'jsonl-usage':
      if ((!ev.speed || ev.speed === 'standard') && !ev.cacheMissReason) {
        return null;
      }
      return {
        projectId: env.projectId,
        type: 'event',
        event: {
          kind: 'turn-footer',
          speed: ev.speed,
          cacheMissReason: ev.cacheMissReason,
          model: ev.model,
        },
      };
    case 'jsonl-tool-progress':
      return {
        projectId: env.projectId,
        type: 'event',
        event: {
          kind: 'tool-progress',
          toolUseId: ev.toolUseId,
          toolName: ev.toolName,
          elapsedSeconds: ev.elapsedSeconds,
          taskId: ev.taskId,
        },
      };
    case 'jsonl-sidechain': {
      // Sub-agent turn row. Parse the raw entry into a compact step; the
      // grouping layer coalesces consecutive ones into one collapsed block.
      const step = parseSidechainStep(ev.raw);
      return {
        projectId: env.projectId,
        type: 'event',
        event: { kind: 'sidechain', role: step.role, text: step.text },
      };
    }
    case 'jsonl-thinking':
      if (!ev.text) return null;
      return {
        projectId: env.projectId,
        type: 'event',
        event: { kind: 'thinking', text: ev.text },
      };
    case 'jsonl-ai-title':
    case 'jsonl-last-prompt':
    case 'jsonl-file-history':
    case 'jsonl-bridge-session':
    case 'jsonl-turn-duration':
    case 'jsonl-post-turn-summary':
    case 'jsonl-stream-event':
      return null;
    default:
      return null;
  }
}

/** Parse one raw `jsonl-sidechain` row (a Claude transcript line) into a
 *  compact { role, text } step for the collapsed sub-agent block. */
function parseSidechainStep(raw: unknown): {
  role: 'user' | 'assistant' | 'tool';
  text: string;
} {
  const row = (raw ?? {}) as Record<string, unknown>;
  const msg = (row.message ?? {}) as Record<string, unknown>;
  const content = msg.content;
  const baseRole: 'user' | 'assistant' = row.type === 'assistant' ? 'assistant' : 'user';

  if (typeof content === 'string') {
    return { role: baseRole, text: content || '(no text)' };
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    let sawToolResult = false;
    for (const p of content as Array<Record<string, unknown>>) {
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'text' && typeof p.text === 'string') parts.push(p.text);
      else if (p.type === 'tool_use') {
        parts.push(`🔧 ${typeof p.name === 'string' ? p.name : 'tool'}`);
      } else if (p.type === 'tool_result') {
        sawToolResult = true;
        parts.push(`↳ ${extractToolResultText(p.content)}`);
      }
    }
    const role: 'user' | 'assistant' | 'tool' =
      baseRole === 'assistant' ? 'assistant' : sawToolResult ? 'tool' : 'user';
    return { role, text: parts.join('\n').trim() || '(no text)' };
  }
  return { role: baseRole, text: '(no content)' };
}

function extractToolResultText(content: unknown): string {
  let text: string;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = (content as Array<Record<string, unknown>>)
      .map((p) => (p && p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
      .join('')
      .trim();
  } else text = '';
  if (!text) return 'tool result';
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
