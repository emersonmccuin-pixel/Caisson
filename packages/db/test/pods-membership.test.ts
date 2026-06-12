// pc-pty-chat-410 - Membership-aware visibility (Phase 2 repo layer).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-pods-membership-'));
process.env.PC_DATA_DIR = tmpDir;

const db = await import('../src/index.ts');

before(() => db.runMigrations());
after(() => { db.closeDb(); rmSync(tmpDir, { recursive: true, force: true }); });

const stages = [{ id: 'todo', name: 'Todo', order: 0 }];
const audit = { actor: 'user' as const };

let _projSeq = 0;
function seedProject(prefix: string) {
  const slug = prefix + '-' + (++_projSeq);
  return db.createProject({ slug, name: slug, stages, folderPath: '' });
}

function seedAgent(name: string, projectId: string) {
  return db.createAgent(
    { name, scope: 'project', projectId: projectId as any, origin: 'user-created' },
    audit,
  );
}

test('cloneAgentToProject is not exported from @pc/db', () => {
  assert.equal((db as any).cloneAgentToProject, undefined, 'must not be exported');
});

test('stock agents appear in every project visible set', () => {
  const p1 = seedProject('stock-p1');
  const p2 = seedProject('stock-p2');
  const allStock = db.listAgents({ scope: 'global' }).filter((a) => a.origin === 'stock');
  const v1 = db.listProjectVisibleAgents(p1.id as any);
  const v2 = db.listProjectVisibleAgents(p2.id as any);
  const vNull = db.listProjectVisibleAgents(null);
  for (const s of allStock) {
    assert.ok(v1.some((a) => a.id === s.id), 'stock ' + s.name + ' missing from p1');
    assert.ok(v2.some((a) => a.id === s.id), 'stock ' + s.name + ' missing from p2');
    assert.ok(vNull.some((a) => a.id === s.id), 'stock ' + s.name + ' missing from null');
  }
});

test('createAgent (scope=project) auto-adds membership row', () => {
  const home = seedProject('auto-mbr-home');
  const agent = seedAgent('auto-mbr-agent', home.id);
  const visible = db.listProjectVisibleAgents(home.id as any);
  assert.ok(visible.some((a) => a.id === agent.id), 'auto-visible in home project');
});

test('addAgentToProject makes agent visible in another project', () => {
  const home = seedProject('add-home');
  const other = seedProject('add-other');
  const agent = seedAgent('add-shared-agent', home.id);
  assert.ok(!db.listProjectVisibleAgents(other.id as any).some((a) => a.id === agent.id), 'not yet in other');
  db.addAgentToProject(agent.id, other.id as any, audit);
  assert.ok(db.listProjectVisibleAgents(other.id as any).some((a) => a.id === agent.id), 'visible in other after add');
  assert.ok(db.listProjectVisibleAgents(home.id as any).some((a) => a.id === agent.id), 'still visible in home');
});

test('addAgentToProject is idempotent', () => {
  const home = seedProject('idem-home');
  const other = seedProject('idem-other');
  const agent = seedAgent('idem-agent', home.id);
  assert.doesNotThrow(() => {
    db.addAgentToProject(agent.id, other.id as any, audit);
    db.addAgentToProject(agent.id, other.id as any, audit);
  });
  assert.equal(db.listProjectVisibleAgents(other.id as any).filter((a) => a.id === agent.id).length, 1);
});

test('removeAgentFromProject hides agent from that project', () => {
  const home = seedProject('rm-home');
  const other = seedProject('rm-other');
  const agent = seedAgent('rm-agent', home.id);
  db.addAgentToProject(agent.id, other.id as any, audit);
  assert.ok(db.listProjectVisibleAgents(other.id as any).some((a) => a.id === agent.id), 'visible before remove');
  db.removeAgentFromProject(agent.id, other.id as any, audit);
  assert.ok(!db.listProjectVisibleAgents(other.id as any).some((a) => a.id === agent.id), 'hidden after remove');
  assert.ok(db.listProjectVisibleAgents(home.id as any).some((a) => a.id === agent.id), 'still in home');
});

test('listAgentProjects returns all project IDs', () => {
  const home = seedProject('lap-home');
  const p2 = seedProject('lap-p2');
  const p3 = seedProject('lap-p3');
  const agent = seedAgent('lap-agent', home.id);
  db.addAgentToProject(agent.id, p2.id as any, audit);
  db.addAgentToProject(agent.id, p3.id as any, audit);
  const projectIds = db.listAgentProjects(agent.id);
  assert.ok(projectIds.includes(home.id as any), 'home project listed');
  assert.ok(projectIds.includes(p2.id as any), 'p2 listed');
  assert.ok(projectIds.includes(p3.id as any), 'p3 listed');
  assert.equal(projectIds.length, 3);
});

test('listProjectMemberAgents returns agents joined to the project', () => {
  const home = seedProject('lpm-home');
  const other = seedProject('lpm-other');
  const a1 = seedAgent('lpm-agent-1', home.id);
  const a2 = seedAgent('lpm-agent-2', home.id);
  db.addAgentToProject(a1.id, other.id as any, audit);
  const members = db.listProjectMemberAgents(other.id as any);
  assert.ok(members.some((a) => a.id === a1.id), 'a1 is a member');
  assert.ok(!members.some((a) => a.id === a2.id), 'a2 is NOT a member');
});

test('resolveAgentForDispatch resolves from a non-home member project', () => {
  const home = seedProject('dispatch-home');
  const other = seedProject('dispatch-other');
  const agent = seedAgent('dispatch-agent', home.id);
  assert.equal(db.resolveAgentForDispatch('dispatch-agent', other.id as any), null, 'no resolution before membership');
  db.addAgentToProject(agent.id, other.id as any, audit);
  const resolved = db.resolveAgentForDispatch('dispatch-agent', other.id as any);
  assert.ok(resolved, 'resolves after membership add');
  assert.equal(resolved!.id, agent.id, 'correct agent');
});

test('getPodForSpawn resolves secrets by agentId regardless of projectId', () => {
  const home = seedProject('secrets-home');
  const other = seedProject('secrets-other');
  const agent = seedAgent('secrets-agent', home.id);
  db.createSecret(
    { agentId: agent.id, scope: 'project', projectId: home.id as any, envVarName: 'MY_SECRET', valuePlaintext: 'supersecret' },
    audit,
  );
  db.addAgentToProject(agent.id, other.id as any, audit);
  const bundle = db.getPodForSpawn('secrets-agent', other.id as any);
  assert.ok(bundle, 'got spawn bundle from other project');
  assert.ok(bundle!.secrets.some((s) => s.envVarName === 'MY_SECRET'), 'secret visible from non-home spawn');
});

test('setAgentShareable flips the shareable flag', () => {
  const home = seedProject('shareable-home');
  const agent = seedAgent('shareable-agent', home.id);
  assert.equal(agent.shareable, false, 'starts not shareable');
  const updated = db.setAgentShareable(agent.id, true, audit);
  assert.ok(updated, 'got updated row');
  assert.equal(updated!.shareable, true, 'flag is now true');
  const reverted = db.setAgentShareable(agent.id, false, audit);
  assert.equal(reverted!.shareable, false, 'flag is now false again');
});

test('setAgentShareable does not drop membership rows', () => {
  const home = seedProject('sas-home');
  const other = seedProject('sas-other');
  const agent = seedAgent('sas-agent', home.id);
  db.addAgentToProject(agent.id, other.id as any, audit);
  db.setAgentShareable(agent.id, true, audit);
  assert.ok(db.listProjectVisibleAgents(home.id as any).some((a) => a.id === agent.id), 'still in home');
  assert.ok(db.listProjectVisibleAgents(other.id as any).some((a) => a.id === agent.id), 'still in other');
  assert.equal(db.listAgentProjects(agent.id).length, 2, 'two membership rows intact');
});

test('setAgentShareable no-ops when flag already matches', () => {
  const home = seedProject('sas-noop-home');
  const agent = seedAgent('sas-noop-agent', home.id);
  const result = db.setAgentShareable(agent.id, false, audit);
  assert.equal(result!.shareable, false, 'still false');
  assert.equal(result!.id, agent.id, 'same agent returned');
});
