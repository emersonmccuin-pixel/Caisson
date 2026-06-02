// Slice 013 — agent-contract route adapters. Read-only this slice:
//   - GET /api/contracts/:id                  → contract detail
//   - GET /api/work-items/:id/contracts       → the work-log timeline (ordered)
//
// Contracts carry their own `projectId`, and ids are globally-unique ULIDs, so
// these are resolved directly through the ContractService (no project param in
// the path). Reads only → no live_outbox writes here (mutations ride the
// ContractService door elsewhere). ZERO broadcast/fanout (no-bypass gate).

import type { Hono } from 'hono';
import type { ULID } from '@pc/domain';
import { ContractService } from '@pc/app-services';

export interface ContractRoutesDeps {
  /** Defaults to a fresh ContractService (live DB). Tests may inject one. */
  contractService?: ContractService;
}

export function registerContractRoutes(app: Hono, deps: ContractRoutesDeps = {}): void {
  const service = deps.contractService ?? new ContractService();

  // Detail — the single first-class contract.
  app.get('/api/contracts/:id', (c) => {
    const id = c.req.param('id') as ULID;
    const contract = service.get(id);
    if (!contract) return c.json({ ok: false, error: `unknown contract: ${id}` }, 404);
    return c.json({ ok: true, contract });
  });

  // Work-log — every contract that rolled up to this work item, oldest-first.
  // Empty array (not 404) when the WI has no contracts — the inspector renders
  // an empty state.
  app.get('/api/work-items/:id/contracts', (c) => {
    const workItemId = c.req.param('id') as ULID;
    const contracts = service.listByWorkItem(workItemId);
    return c.json({ ok: true, contracts });
  });

  // Slice 022 — project-scoped, WI-optional contract list (newest-first).
  // Surfaces contract-only dispatches (workItemId === null) the per-WI work-log
  // can't reach. Empty array (not 404) when the project has no contracts.
  app.get('/api/projects/:id/contracts', (c) => {
    const projectId = c.req.param('id') as ULID;
    const contracts = service.listByProject(projectId);
    return c.json({ ok: true, contracts });
  });
}
