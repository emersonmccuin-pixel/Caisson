// Integration-branch resolver — the ONE writer of settings.integrationBranch.
//
// explicit-wins / configured-missing-throws / detect-persists-once /
// nothing-detectable-throws. Pure unit: fake persist + detect + refResolves,
// no git, no DB.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Project } from '@pc/domain';

import { makeIntegrationBranchResolver } from '../src/services/integration-branch.ts';

function fakeProject(integrationBranch: string | null): Project {
  return {
    id: 'p1',
    slug: 'demo',
    name: 'Demo',
    stages: [],
    folderPath: 'C:/fake/repo',
    gitRemote: null,
    settings: { cancelledVisibility: 'use-global', remoteControl: 'use-global', integrationBranch },
    callsignSeq: 0,
    notes: null,
    focusedAt: null,
  } as unknown as Project;
}

test('explicit setting wins — verified, no detect, no persist', async () => {
  let detectCalls = 0;
  let persistCalls = 0;
  const resolver = makeIntegrationBranchResolver({
    getProject: () => fakeProject('reporting-rebuild-phase2'),
    workspaceDir: 'C:/fake/repo',
    refResolves: async (_ws, name) => name === 'reporting-rebuild-phase2',
    detect: async () => ((detectCalls += 1), 'dev'),
    persist: () => ((persistCalls += 1), null),
  });

  assert.equal(await resolver(), 'reporting-rebuild-phase2');
  assert.equal(detectCalls, 0, 'no detection when explicitly configured');
  assert.equal(persistCalls, 0, 'no persist when explicitly configured');
});

test('configured branch that does not exist in the repo throws loudly — never falls back', async () => {
  let detectCalls = 0;
  const resolver = makeIntegrationBranchResolver({
    getProject: () => fakeProject('gone-branch'),
    workspaceDir: 'C:/fake/repo',
    refResolves: async () => false,
    detect: async () => ((detectCalls += 1), 'dev'),
    persist: () => null,
  });

  await assert.rejects(() => resolver(), /"gone-branch".*does not exist/s);
  assert.equal(detectCalls, 0, 'a misconfigured branch must NOT silently fall back to detection');
});

test('no setting → detect once, persist, and return the detected branch', async () => {
  const persisted: Array<{ id: string; branch: string }> = [];
  const refreshed: Project[] = [];
  let project = fakeProject(null);
  const resolver = makeIntegrationBranchResolver({
    getProject: () => project,
    workspaceDir: 'C:/fake/repo',
    detect: async () => 'main',
    persist: (id, branch) => {
      persisted.push({ id, branch });
      project = fakeProject(branch); // simulate the DB write landing
      return project;
    },
    onPersisted: (p) => refreshed.push(p),
  });

  assert.equal(await resolver(), 'main');
  assert.deepEqual(persisted, [{ id: 'p1', branch: 'main' }]);
  assert.equal(refreshed.length, 1, 'updated row pushed back into the runtime cache');

  // Second call: the setting is now explicit — no second detect/persist.
  let secondDetect = false;
  const resolver2 = makeIntegrationBranchResolver({
    getProject: () => project,
    workspaceDir: 'C:/fake/repo',
    refResolves: async () => true,
    detect: async () => ((secondDetect = true), 'main'),
    persist: () => null,
  });
  assert.equal(await resolver2(), 'main');
  assert.equal(secondDetect, false, 'persisted setting short-circuits detection');
});

test('nothing detectable throws loudly with a fix-it pointer', async () => {
  const resolver = makeIntegrationBranchResolver({
    getProject: () => fakeProject(null),
    workspaceDir: 'C:/fake/repo',
    detect: async () => null,
    persist: () => null,
  });

  await assert.rejects(() => resolver(), /cannot detect an integration branch.*Project Settings/s);
});

test('configured value failing the ref-name shape throws (defense vs hand-edited DB)', async () => {
  const resolver = makeIntegrationBranchResolver({
    getProject: () => fakeProject('-bad-name'),
    workspaceDir: 'C:/fake/repo',
    refResolves: async () => true,
    detect: async () => 'dev',
    persist: () => null,
  });

  await assert.rejects(() => resolver(), /not a valid ref name/);
});
