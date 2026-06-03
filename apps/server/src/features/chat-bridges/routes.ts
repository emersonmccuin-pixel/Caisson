import type { Hono } from 'hono';
import type { ULID } from '@pc/domain';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

export interface PendingAskStore {
  set(toolUseId: string, resolveAnswer: (answer: string) => void): void;
  has(toolUseId: string): boolean;
  delete(toolUseId: string): boolean;
  resolve(toolUseId: string, answer: string): boolean;
}

class InMemoryPendingAskStore implements PendingAskStore {
  private readonly resolvers = new Map<string, (answer: string) => void>();

  set(toolUseId: string, resolveAnswer: (answer: string) => void): void {
    this.resolvers.set(toolUseId, resolveAnswer);
  }

  has(toolUseId: string): boolean {
    return this.resolvers.has(toolUseId);
  }

  delete(toolUseId: string): boolean {
    return this.resolvers.delete(toolUseId);
  }

  resolve(toolUseId: string, answer: string): boolean {
    const resolveAnswer = this.resolvers.get(toolUseId);
    if (!resolveAnswer) return false;
    this.resolvers.delete(toolUseId);
    resolveAnswer(answer);
    return true;
  }
}

export function createPendingAskStore(): PendingAskStore {
  return new InMemoryPendingAskStore();
}

/** Slice 007 — durable ask-shadow seam. A SIDE write around the UNCHANGED
 *  in-memory resolver: the shadow `pending_interactions` row is inspectable, NOT
 *  the answer authority. `onAsk` is called when /api/ask arrives (creates the
 *  open shadow); `onResolved`/`onTimedOut` terminalize it (answered/expired).
 *  All three are best-effort no-ops if the seam is absent — the exact current
 *  /api/ask behavior is preserved when no shadow is injected. */
export interface AskShadowPort {
  onAsk(input: { projectId: ULID; toolUseId: string; toolName: string; prompt: string }): void;
  onTimedOut(toolUseId: string): void;
}

export interface ChatBridgeRouteDeps {
  broadcastTo(projectId: ULID, msg: unknown): void;
  pendingAsks: PendingAskStore;
  askTimeoutMs?: number;
  scheduleAskTimeout?: (callback: () => void, delayMs: number) => unknown;
  claudeProjectsDir?: string;
  fileExists?: (path: string) => boolean;
  readFileText?: (path: string) => Promise<string>;
  askShadow?: AskShadowPort;
}

async function defaultReadFileText(path: string): Promise<string> {
  return await readFile(path, 'utf-8');
}

/** Best-effort prompt text from a tool input for the shadow row. */
function derivePrompt(toolInput: unknown): string {
  if (toolInput && typeof toolInput === 'object') {
    const obj = toolInput as Record<string, unknown>;
    for (const key of ['question', 'prompt', 'message', 'text']) {
      if (typeof obj[key] === 'string') return obj[key] as string;
    }
    try {
      return JSON.stringify(toolInput);
    } catch {
      return '';
    }
  }
  return typeof toolInput === 'string' ? toolInput : '';
}

export function registerChatBridgeRoutes(app: Hono, deps: ChatBridgeRouteDeps): void {
  const services = {
    askTimeoutMs: deps.askTimeoutMs ?? 10 * 60 * 1000,
    scheduleAskTimeout: deps.scheduleAskTimeout ?? setTimeout,
    allowedTranscriptRoot:
      deps.claudeProjectsDir ?? resolve(homedir(), '.claude', 'projects'),
    fileExists: deps.fileExists ?? existsSync,
    readFileText: deps.readFileText ?? defaultReadFileText,
  };

  /**
   * Ask intercept. Hook scripts POST { projectId, sessionId?, toolName, toolUseId, toolInput }.
   * We broadcast the ask only to the originating project's WS subscribers, then
   * block until the user answers (or the 10-minute timeout fires). `sessionId`
   * lets transient-session modals filter asks originating from their own spawn.
   */
  app.post('/api/ask', async (c) => {
    const body = await c.req.json<{
      projectId?: string;
      sessionId?: string | null;
      toolName: string;
      toolUseId: string;
      toolInput: unknown;
    }>();
    const { toolName, toolUseId, toolInput } = body;
    const projectId = typeof body.projectId === 'string' ? (body.projectId as ULID) : null;
    if (!projectId) return c.json({ answer: '(no projectId on ask payload)' });
    const sessionId =
      typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null;

    deps.broadcastTo(projectId, { type: 'ask', sessionId, toolName, toolUseId, toolInput });

    // Slice 007 — durable ask-shadow: a SIDE write. The in-memory resolver below
    // stays the authoritative blocking answer path; the shadow row is only an
    // inspectable durable record (terminalized on resolve via the index.ts
    // resolvePendingAsk wrapper, or on timeout here).
    deps.askShadow?.onAsk({
      projectId,
      toolUseId,
      toolName,
      prompt: derivePrompt(toolInput),
    });

    const answer = await new Promise<string>((resolveAnswer) => {
      deps.pendingAsks.set(toolUseId, resolveAnswer);
      services.scheduleAskTimeout(() => {
        if (deps.pendingAsks.has(toolUseId)) {
          deps.pendingAsks.delete(toolUseId);
          deps.askShadow?.onTimedOut(toolUseId);
          resolveAnswer('(timeout — no user response)');
        }
      }, services.askTimeoutMs);
    });

    return c.json({ answer });
  });

  /** Read a subagent transcript JSONL file, parse it, and return per-line events. */
  app.get('/api/subagent-transcript', async (c) => {
    const rawPath = c.req.query('path');
    if (!rawPath || !isAbsolute(rawPath)) {
      return c.json({ ok: false, error: 'absolute path query param required' }, 400);
    }
    const allowedRoot = resolve(services.allowedTranscriptRoot);
    const requested = resolve(rawPath);
    const rel = relative(allowedRoot, requested);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return c.json({ ok: false, error: 'path must live under ~/.claude/projects/' }, 403);
    }
    if (!services.fileExists(requested)) {
      return c.json({ ok: false, error: 'transcript not found' }, 404);
    }
    try {
      const text = await services.readFileText(requested);
      const events: unknown[] = [];
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          events.push(JSON.parse(trimmed));
        } catch {
          // Skip malformed lines -- JSONL tolerates partial writes mid-tail.
        }
      }
      return c.json({ ok: true, path: requested, relPath: rel, events });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 500);
    }
  });

  // ☠ FD-3: the `/channel-send` test-proxy route is gone with the channel server.
}
