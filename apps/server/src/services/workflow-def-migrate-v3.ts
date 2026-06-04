// M6 (2026-06-04) — one-shot boot migration for STORED workflow definitions
// to the v3 step model. Idempotent transforms via migrateWorkflowTextToV3:
//   FD-10 (slice A): strip the dead `triggers:` key.
//   FD-9  (slice B): node.move → inserted `move` step · review reject object →
//                    minted `loop` step (`reject.move` dropped whole) · dead
//                    `retry:` keys dropped.
// The schema-level run columns died in migration 0043; this sweep rewrites the
// definition CONTENT (YAML can't be rewritten in SQL).
//
// Idempotent: after the first pass nothing matches and the sweep is a no-op.
// Rows whose definition is invalid for OTHER reasons keep their honest
// `invalid` status — the sweep migrates, it never repairs. Runs at boot,
// before any project runtime loads.

import { workflowsRepo } from '@pc/db';
import { migrateWorkflowTextToV3 } from '@pc/workflows';
import { createHash } from 'node:crypto';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** Marker reason — mirrors the stock-seed convention (actor 'orchestrator' +
 *  a recognizable system reason) so the audit trail shows WHO rewrote the row. */
const MIGRATE_REASON = 'M6 system migration — v3 step model (strip triggers · move/loop steps)';

export interface DefMigrateResult {
  scanned: number;
  rewritten: number;
  nowInvalid: string[];
}

export function migrateStoredWorkflowDefsToV3(): DefMigrateResult {
  const rows = workflowsRepo.listWorkflows();
  let rewritten = 0;
  const nowInvalid: string[] = [];

  for (const row of rows) {
    const result = migrateWorkflowTextToV3(row.yaml, row.slug);
    if (!result.changed) continue;

    if (result.workflow) {
      workflowsRepo.updateWorkflow(
        row.id,
        {
          yaml: result.yaml,
          yamlHash: sha256(result.yaml),
          parsedDefinition: result.workflow,
          status: 'active',
          parseError: null,
        },
        { actor: 'orchestrator', reason: MIGRATE_REASON },
      );
    } else {
      workflowsRepo.updateWorkflow(
        row.id,
        {
          yaml: result.yaml,
          yamlHash: sha256(result.yaml),
          parsedDefinition: null,
          status: 'invalid',
          parseError: result.errors.join('; '),
        },
        { actor: 'orchestrator', reason: MIGRATE_REASON },
      );
      nowInvalid.push(row.slug);
    }
    rewritten++;
  }

  return { scanned: rows.length, rewritten, nowInvalid };
}
