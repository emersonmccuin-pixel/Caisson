// Channel server. Single multiplexed HTTP listener on :8788 plus a WS registry
// of per-CC channel-stdio children. Replaces the rig-era per-process model
// where each channel-server.js bound its own port — see the multi-tenancy design
// §3 for the locked routing.
//
// External callers POST to `/channel/<slug>/<source>` with a plain text body.
// We resolve the slug → projectId via the registry, fan the event to every
// registered child of that project (external webhooks have no sessionId, so
// fan-to-all preserves the "every orchestrator sees external traffic" intent).
// UI subscribers are notified separately via the project's WS broadcast envelope.
//
// Section 18.5a re-keyed `registrants` by `(projectId, sessionId)`. Multi-CC
// scenarios used to silently route to whichever CC registered most recently
// (project-only key — newer kicks older). Now each CC's bridge registers with
// its CC's deterministic sessionId; programmatic emits target a specific
// recipient session via `emitToSession`.

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer, type WebSocket } from 'ws';
import { getProjectBySlug } from '@pc/db';
import type { Project, ULID } from '@pc/domain';

export interface ChannelServerDeps {
  /** Port for the HTTP listener (locked: 8788). */
  port: number;
  /** Allowlisted X-Sender values. Empty set means everyone is allowed. */
  allowedSenders: Set<string>;
  /** Pushes a UI-side broadcast for a channel event arriving at this project. */
  onEvent: (projectId: ULID, payload: ChannelEvent) => void;
  /** Section 18.3 — Fires after a fresh WS registrant is accepted. Used to
   *  drain pending inbox rows for the (projectId, sessionId) pair so a
   *  post-restart / post-respawn bridge catches up autonomously without
   *  waiting on a user prompt. Best-effort: handler must not throw. */
  onRegister?: (args: { projectId: ULID; sessionId: string; slug: string }) => void;
  /** Slice 008 — external-webhook cutover sink. When wired AND the webhook gate
   *  = `mailbox`, the handler routes the inbound event to this sink (a durable
   *  mailbox `external-webhook` message) INSTEAD of fanning to the per-CC bridge
   *  children — no silent drop on a missing registrant. Return true when the
   *  sink owned delivery (skip the bridge fan-out); false ⟹ unchanged Channel
   *  fan-out. The `channel-event` UI broadcast (`onEvent`) still fires in BOTH
   *  positions (it is the UI's view, not the gated delivery). */
  webhookSink?: (event: ChannelEvent) => boolean;
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
      // Slice 008 — gated webhook delivery. When the sink owns it (gate =
      // `mailbox`), route to the durable mailbox inbox and SKIP the per-CC
      // bridge fan-out; otherwise the unchanged fan-to-all-children runs. The
      // `channel-event` UI broadcast fires in BOTH positions.
      const sunkToMailbox = this.deps.webhookSink?.(event) ?? false;
      if (!sunkToMailbox) {
        this.forwardToProjectChildren(project, event);
      }
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
      // 18.3 — auto-flush hook. Defer to next tick so the drain (which uses
      // `emitToSession` against the map we just wrote to) runs after the
      // current register handler unwinds. Any throw is logged + swallowed
      // so a bad drain can't break registration.
      const onRegister = this.deps.onRegister;
      if (onRegister) {
        setImmediate(() => {
          try {
            onRegister({ projectId, sessionId, slug });
          } catch (err) {
            console.error(
              `[channel] onRegister handler threw for ${projectId} / ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        });
      }
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

  /** Section 16b / 18.5a — Programmatic emit. Server-side code (agent comms,
   *  workflow runtime) calls this to deliver a synthesised event to a
   *  specific recipient CC session, without round-tripping through the HTTP
   *  listener. Returns true if the matching registrant received the forward;
   *  false if no registrant is currently bound for that (projectId, sessionId)
   *  pair (event still propagates to UI subscribers via `onEvent`). */
  emitToSession(args: {
    projectId: ULID;
    recipientSessionId: string;
    slug: string;
    source: string;
    body: string;
    sender?: string;
  }): boolean {
    const event: ChannelEvent = {
      projectId: args.projectId,
      slug: args.slug,
      source: args.source,
      body: args.body,
      sender: args.sender ?? 'pc',
      at: Date.now(),
    };
    const child = this.registrants.get(registrantKey(args.projectId, args.recipientSessionId));
    const delivered = !!(child && child.ws.readyState === child.ws.OPEN);
    if (delivered) {
      this.sendEnvelope(child!, event);
    } else {
      console.warn(
        `[channel] emitToSession: no registered child for ${args.projectId} / ${args.recipientSessionId}; UI broadcast only`,
      );
    }
    this.deps.onEvent(args.projectId, event);
    return delivered;
  }

  /** Fan an event to every registered child for a project. Used by the
   *  external webhook HTTP path — external callers don't know about
   *  per-session routing; "deliver to every orchestrator in the project"
   *  is the documented intent. Returns the number of children that received
   *  the forward. */
  private forwardToProjectChildren(project: Project, event: ChannelEvent): number {
    let delivered = 0;
    for (const child of this.registrants.values()) {
      if (child.projectId !== project.id) continue;
      if (child.ws.readyState !== child.ws.OPEN) continue;
      this.sendEnvelope(child, event);
      delivered += 1;
    }
    if (delivered === 0) {
      console.warn(
        `[channel] no registered child for ${project.id} (${project.name}); dropping event from ${event.source}`,
      );
    }
    return delivered;
  }

  private sendEnvelope(child: RegisteredChild, event: ChannelEvent): void {
    child.ws.send(
      JSON.stringify({
        type: 'channel-event',
        content: event.body,
        path: `/channel/${event.slug}/${event.source}`,
        method: 'POST',
        source: event.source,
      }),
    );
  }
}
