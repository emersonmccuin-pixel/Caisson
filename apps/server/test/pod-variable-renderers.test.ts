// Section 36 — caisson's live {{AGENT_ROSTER}} variable. The explainer roster
// must group agents by where they live (built-in / this project / global
// custom) from live DB state, so caisson never recites a stale hardcoded list.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-pod-vars-'));
process.env.PC_DATA_DIR = tmpDir;

const { closeDb, createAgent, runMigrations } = await import('@pc/db');
const { renderAgentRosterForCaisson } = await import('../src/services/pod-variable-renderers.ts');

const PROJECT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV' as ULID;
const OTHER_PROJECT = '01ARZ3NDEKTSV4RRFFQ69G5FAW' as ULID;
const audit = { actor: 'user' as const, reason: 'test' };

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('roster groups agents by built-in / this project / global custom', () => {
  const builtIn = createAgent(
    {
      name: 'stock-explained',
      scope: 'global',
      origin: 'stock',
      description: 'a built-in specialist',
      dispatchGuidance: 'when you need the stock thing',
    },
    audit,
  );
  const projectPod = createAgent(
    {
      name: 'proj-only',
      scope: 'project',
      projectId: PROJECT_ID,
      description: 'a project-scoped custom pod',
    },
    audit,
  );
  const globalCustom = createAgent(
    { name: 'glob-custom', scope: 'global', description: 'a user-created global pod' },
    audit,
  );
  // A pod scoped to a DIFFERENT project must NOT appear in this project's view.
  createAgent(
    { name: 'elsewhere', scope: 'project', projectId: OTHER_PROJECT, description: 'other project' },
    audit,
  );

  const out = renderAgentRosterForCaisson(PROJECT_ID);

  assert.match(out, /\*\*Built-in agents\*\*/);
  assert.match(out, /\*\*This project's agents\*\*/);
  assert.match(out, /\*\*The user's global agents\*\*/);

  assert.match(out, /stock-explained/);
  assert.match(out, /when you need the stock thing/, 'dispatch guidance rendered');
  assert.match(out, /proj-only/);
  assert.match(out, /glob-custom/);
  assert.doesNotMatch(out, /elsewhere/, 'other-project pod excluded');

  // built-in section comes before project section comes before global custom.
  assert.ok(out.indexOf('Built-in agents') < out.indexOf("This project's agents"));
  assert.ok(out.indexOf("This project's agents") < out.indexOf("user's global agents"));

  void builtIn;
  void projectPod;
  void globalCustom;
});
