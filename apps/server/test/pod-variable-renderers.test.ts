// Section 36 — caisson's live {{AGENT_ROSTER}} variable. The explainer roster
// must group agents by membership tier (Built-in / In this project / In the
// shared library, not in this project) from live DB state, so caisson never
// recites a stale hardcoded list.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ULID } from '@pc/domain';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-pod-vars-'));
process.env.PC_DATA_DIR = tmpDir;

const { addAgentToProject, closeDb, createAgent, createProject, runMigrations } =
  await import('@pc/db');
const { renderAgentRosterForCaisson } = await import('../src/services/pod-variable-renderers.ts');

const audit = { actor: 'user' as const, reason: 'test' };

before(() => runMigrations());
after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

test('roster groups agents by Built-in / In this project / In the shared library', () => {
  const project = createProject({
    slug: 'pod-vars-test-proj',
    name: 'Pod Vars Test',
    stages: [{ id: 'todo', name: 'Todo', order: 0 }],
    folderPath: join(tmpDir, 'pod-vars-test-proj'),
  });
  const otherProject = createProject({
    slug: 'pod-vars-test-other',
    name: 'Other Project',
    stages: [{ id: 'todo', name: 'Todo', order: 0 }],
    folderPath: join(tmpDir, 'pod-vars-test-other'),
  });
  const PROJECT_ID = project.id as ULID;
  const OTHER_PROJECT_ID = otherProject.id as ULID;

  // Built-in: origin=stock — always visible in every project.
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

  // In this project: private project agent (gets a membership row automatically).
  const privatePod = createAgent(
    {
      name: 'proj-only',
      scope: 'project',
      projectId: PROJECT_ID,
      description: 'a private project agent',
    },
    audit,
  );

  // In this project: shared agent added to this project via addAgentToProject.
  const sharedMember = createAgent(
    {
      name: 'shared-member',
      scope: 'global',
      shareable: true,
      description: 'a shared agent added to this project',
    },
    audit,
  );
  addAgentToProject(sharedMember.id as ULID, PROJECT_ID, audit);

  // In the shared library, not in this project: shareable but not added here.
  const sharedNotHere = createAgent(
    {
      name: 'shared-not-here',
      scope: 'global',
      shareable: true,
      description: 'a shared agent NOT added to this project',
    },
    audit,
  );

  // A private agent from a DIFFERENT project must NOT appear at all.
  createAgent(
    { name: 'elsewhere', scope: 'project', projectId: OTHER_PROJECT_ID, description: 'other' },
    audit,
  );

  const out = renderAgentRosterForCaisson(PROJECT_ID);

  // Correct section headers (new membership model labels).
  assert.match(out, /\*\*Built-in\*\*/);
  assert.match(out, /\*\*In this project\*\*/);
  assert.match(out, /\*\*In the shared library, not in this project\*\*/);

  // Stale labels must be gone.
  assert.doesNotMatch(out, /Built-in agents/, 'old header gone');
  assert.doesNotMatch(out, /This project's agents/, 'old header gone');
  assert.doesNotMatch(out, /global agents/, 'old header gone');
  assert.doesNotMatch(out, /copy|clone/, 'no clone/copy language');

  // Built-in section contains the stock agent.
  assert.match(out, /stock-explained/);
  assert.match(out, /when you need the stock thing/, 'dispatch guidance rendered');

  // "In this project" section contains both the private pod AND the shared member.
  assert.match(out, /proj-only/, 'private project pod in this project');
  assert.match(out, /shared-member/, 'shared member in this project');

  // Shared library section contains the non-member shareable agent.
  assert.match(out, /shared-not-here/, 'non-member shareable in library section');

  // Other-project private pod must not appear.
  assert.doesNotMatch(out, /elsewhere/, 'other-project pod excluded');

  // Section order: Built-in < In this project < shared library.
  assert.ok(out.indexOf('**Built-in**') < out.indexOf('**In this project**'));
  assert.ok(out.indexOf('**In this project**') < out.indexOf('**In the shared library'));

  // shared-member must be in the "In this project" section, not the library section.
  const inProjectIdx = out.indexOf('**In this project**');
  const libraryIdx = out.indexOf('**In the shared library');
  const sharedMemberIdx = out.indexOf('shared-member');
  assert.ok(
    sharedMemberIdx > inProjectIdx && sharedMemberIdx < libraryIdx,
    'shared-member appears under "In this project", not under the library',
  );

  // shared-not-here must be in the library section (after libraryIdx).
  assert.ok(out.indexOf('shared-not-here') > libraryIdx, 'shared-not-here is in the library');

  void builtIn;
  void privatePod;
  void sharedMember;
  void sharedNotHere;
});
