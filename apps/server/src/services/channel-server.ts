// Channel server. Single multiplexed HTTP listener on :8788 for the INBOUND
// external-webhook entry (`POST /channel/<slug>/<source>`), plus a WS registry
// of per-CC channel-stdio children (kept for bridge registration/supersede).
//
// 017 Phase C — the outbound Channel delivery path (per-CC bridge push) was
// deleted; the mailbox is the sole delivery door. External callers POST a plain
// text body; we resolve the slug → projectId and route the event UNCONDITIONALLY
// to the durable mailbox via `webhookSink` (no silent drop on a missing
// registrant). UI subscribers are notified via the project's WS broadcast.

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer, type WebSocket } from 'ws';
import { getProjectBySlug } from '@pc/db';
import type { ULID } from '@pc/domain';

export interface ChannelServerDeps {
  /** Port for the HTTP listener (locked: 8788). */
  port: number;
  /** Allowlisted X-Sender values. Empty set means everyone is allowed. */
  allowedSenders: Set<string>;
  /** Pushes a UI-side broadcast for a channel event arriving at this project. */
  onEvent: (projectId: ULID, payload: ChannelEvent) => void;
  /** External-webhook sink. Every inbound `/channel/:slug/:source` event is
   *  routed here as a durable mailbox `external-webhook` message — no silent
   *  drop on a missing registrant. The `channel-event` UI broadcast (`onEvent`)
   *  fires alongside it (it is the UI's view, not the delivery). */
  webhookSink: (event: ChannelEvent) => void;
}

export interface ChannelEvent {
  projectId: ULID;
  slug: string;
  source: string;
  body: string;
  sender: string;
  at: number;
}

interface RegisteredChild {
  ws: WebSocket;
  projectId: ULID;
  sessionId: string;
  slug: string;
}

/** Composite Map key built from `(projectId, sessionId)`. */
function registrantKey(projectId: ULID, sessionId: string): string {
  return `${projectId}::${sessionId}`;
}

export class ChannelServer {
  private readonly registrants = new Map<string, RegisteredChild>();
  private httpServer: ReturnType<typeof serve> | null = null;
  private wss: WebSocketServer | null = null;

  constructor(private readonly deps: ChannelServerDeps) {}

  /** Start the HTTP + WS listeners. Returns once bound. */
  start(): void {
    const app = new Hono();

    // POST /channel/:slug/:source — external webhook entry. Looks up the
    // project by slug, validates the sender, fans the body to every
    // registered child for that project, and emits a UI broadcast.
    app.post('/channel/:slug/:source', async (c) => {
      const slug = c.req.param('slug');
      const source = c.req.param('source');
      const sender = c.req.header('x-sender') ?? '';
      if (this.deps.allowedSenders.size > 0 && !this.deps.allowedSenders.has(sender)) {
        return c.text('forbidden', 403);
      }
      const project = getProjectBySlug(slug);
      if (!project) return c.text(`unknown project slug: ${slug}`, 404);

      const body = await c.req.text();
      const event: ChannelEvent = {
        projectId: project.id,
        slug,
        source,
        body,
        sender,
        at: Date.now(),
      };
      // 017 Phase C — route the inbound event to the durable mailbox sink
      // unconditionally; the `channel-event` UI broadcast fires alongside it.
      this.deps.webhookSink(event);
      this.deps.onEvent(project.id, event);
      return c.text('ok', 200);
    });

    app.get('/health', (c) =>
      c.json({
        ok: true,
        registrants: Array.from(this.registrants.values()).map((r) => ({
          projectId: r.projectId,
          sessionId: r.sessionId,
          slug: r.slug,
        })),
      }),
    );

    this.httpServer = serve(
      { fetch: app.fetch, port: this.deps.port, hostname: '127.0.0.1' },
      (info) => {
        console.log(`[channel] http://127.0.0.1:${info.port}`);
      },
    );

    this.wss = new WebSocketServer({ server: this.httpServer as never, path: '/channel-register' });
    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url ?? '/channel-register', 'http://127.0.0.1');
      const projectId = url.searchParams.get('projectId') as ULID | null;
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const slug = url.searchParams.get('slug') ?? '';
      if (!projectId || !sessionId || !slug) {
        try {
          ws.close(1008, 'projectId, sessionId, and slug required');
        } catch {
          /* best effort */
        }
        return;
      }
      const key = registrantKey(projectId, sessionId);
      const prior = this.registrants.get(key);
      if (prior) {
        // Same (projectId, sessionId) re-registering — the prior CC presumably
        // died and a fresh bridge is reconnecting. Same-session collision IS
        // a real supersede; cross-session no longer collides because the key
        // includes sessionId.
        try {
          prior.ws.close(1000, 'superseded by newer registrant');
        } catch {
          /* best effort */
        }
      }
      this.registrants.set(key, { ws, projectId, sessionId, slug });
      console.log(`[channel] registered ${slug} (${projectId} / ${sessionId})`);
      ws.on('close', () => {
        const cur = this.registrants.get(key);
        if (cur && cur.ws === ws) this.registrants.delete(key);
      });
    });
  }

  shutdown(): void {
    for (const r of this.registrants.values()) {
      try {
        r.ws.close(1001, 'channel server shutting down');
      } catch {
        /* best effort */
      }
    }
    this.registrants.clear();
    try {
      this.wss?.close();
    } catch {
      /* best effort */
    }
    try {
      this.httpServer?.close();
    } catch {
      /* best effort */
    }
  }

}
