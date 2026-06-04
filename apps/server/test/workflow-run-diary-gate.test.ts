// M3a — DIARY-DOOR gate (FD-11/FD-12/FD-13). The workflow run diary
// (`workflow_run_events`) has exactly ONE writer: WorkflowRunMutationGateway.
// appendRunEvent, which pairs the event row with its `workflow.run.event`
// outbox fact in one transaction. A direct `workflowRunsV2Repo.appendEvent`
// call anywhere else is the resurrected FD-12 bypass #2 (a silent diary write
// the UI/orchestrator never sees).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..', '..');

// The ONE door. (The repo definition itself lives in @pc/db and is not a call.)
const DOOR = 'packages/app-services/src/workflows/run-gateway.ts';

const SCAN_ROOTS = [
  'apps/server/src',
  'apps/web/src',
  'packages/app-services/src',
  'packages/workflows/src',
].map((p) => join(repoRoot, ...p.split('/')));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'test') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

test('DIARY-DOOR: workflowRunsV2Repo.appendEvent is callable only from the run gateway', () => {
  const offenders: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(root)) {
      const rel = toPosix(relative(repoRoot, file));
      if (rel === DOOR) continue;
      const content = readFileSync(file, 'utf8');
      // Comment-stripped, line-granular probe (matches the no-bypass scanner's
      // tolerance level — a mention in comments is documentation, not a call).
      for (const [i, raw] of content.split(/\r?\n/).entries()) {
        const line = raw.replace(/\/\/.*$/, '');
        if (line.includes('workflowRunsV2Repo.appendEvent')) {
          offenders.push(`${rel}:L${i + 1}`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `direct diary writes bypass the gateway (use WorkflowRunMutationGateway.appendRunEvent):\n${offenders.join('\n')}`,
  );
});

test('DIARY-DOOR: the door itself still exists and binds the repo writer', () => {
  const content = readFileSync(join(repoRoot, ...DOOR.split('/')), 'utf8');
  assert.ok(
    content.includes('appendRunEvent('),
    'run-gateway.ts must keep the appendRunEvent door',
  );
  assert.ok(
    content.includes('workflowRunsV2Repo.appendEvent'),
    'the door must bind the repo writer (the default seam)',
  );
});
