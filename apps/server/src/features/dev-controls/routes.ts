import type { Hono } from 'hono';

import { getActiveRunRegistry } from '../../services/agent-active-runs.ts';
import { DEV_RESTART_EXIT_CODE, isDevControlsEnabled } from './constants.ts';

export interface DevControlDeps {
  gracefulShutdown(): void;
  activeRunCount?: () => number;
  scheduleRestart?: (fn: () => void) => void;
  exitProcess?: (code: number) => void;
}

export function registerDevControlRoutes(app: Hono, deps: DevControlDeps): void {
  if (!isDevControlsEnabled()) return;

  const activeRunCount = deps.activeRunCount ?? (() => getActiveRunRegistry().list().length);
  const scheduleRestart = deps.scheduleRestart ?? ((fn: () => void) => { setTimeout(fn, 50); });
  const exitProcess = deps.exitProcess ?? ((code: number) => { process.exit(code); });

  /** GET /api/dev/status — active-agent count + whether a restart is safe + build info. */
  app.get('/api/dev/status', (c) => {
    const activeAgents = activeRunCount();
    return c.json({
      activeAgents,
      canRestart: activeAgents === 0,
      buildSha: process.env['PC_BUILD_SHA'] ?? null,
      buildBranch: process.env['PC_BUILD_BRANCH'] ?? null,
    });
  });

  /**
   * POST /api/dev/restart — graceful shutdown then exit(75) so the supervisor
   * respawns a fresh tsx child.
   *
   * Returns 409 when agents are live unless `force: true` is in the body.
   */
  app.post('/api/dev/restart', async (c) => {
    let force = false;
    try {
      const body = await c.req.json<{ force?: boolean }>();
      force = body.force === true;
    } catch {
      // empty or malformed body → force stays false
    }

    const activeAgents = activeRunCount();
    if (activeAgents > 0 && !force) {
      return c.json(
        {
          ok: false,
          error: `${activeAgents} agent(s) active — pass force:true to restart anyway`,
        },
        409,
      );
    }

    // Flush the response before exiting. setTimeout gives the HTTP stack one
    // event-loop tick to send the 200 back to the client.
    scheduleRestart(() => {
      deps.gracefulShutdown();
      exitProcess(DEV_RESTART_EXIT_CODE);
    });

    return c.json({ ok: true });
  });
}
