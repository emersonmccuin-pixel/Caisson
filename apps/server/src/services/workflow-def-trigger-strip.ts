// M6 / FD-10 (2026-06-04) — one-shot data migration for STORED workflow
// definitions: strip the dead `triggers:` key from every row's yaml +
// parsed_definition. The schema-level run columns died in migration 0043;
// this sweep cleans the definition CONTENT (YAML can't be rewritten in SQL).
//
// Idempotent: after the first pass nothing matches and the sweep is a no-op.
// Rows whose definition is invalid for OTHER reasons keep their honest
// `invalid` status — we only remove the triggers key, never repair anything
// else. Runs at boot, before any project runtime loads.

import { workflowsRepo } from '@pc/db';
import { stripTriggersFromWorkflowText } from '@pc/workflows';
import { createHash } from 'node:crypto';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** Marker reason — mirrors the stock-seed convention (actor 'orchestrator' +
 *  a recognizable system reason) so the audit trail shows WHO rewrote the row. */
const STRIP_REASON = 'M6/FD-10 system migration — strip dead triggers key';

export interface TriggerStripResult {
  scanned: number;
  rewritten: number;
  nowInvalid: string[];
}

export function stripTriggersFromStoredWorkflowDefs(): TriggerStripResult {
  const rows = workflowsRepo.listWorkflows();
  let rewritten = 0;
  const nowInvalid: string[] = [];

  for (const row of rows) {
    const result = stripTriggersFromWorkflowText(row.yaml, row.slug);
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
        { actor: 'orchestrator', reason: STRIP_REASON },
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
        { actor: 'orchestrator', reason: STRIP_REASON },
      );
      nowInvalid.push(row.slug);
    }
    rewritten++;
  }

  return { scanned: rows.length, rewritten, nowInvalid };
}
