// SLICE-009 OBJ-2 — host-backed resume-send result handling.
//
// Answering a paused host-backed run AWAITS the host command and reports a
// `not-resumable` reply (the host run was not actually paused, so the answer
// was dropped). On that result `answerPendingAsk` must FINALIZE the run to a
// terminal state via `cause:'resume-failed'` instead of stranding it `running`
// for the idle sweep. A resumable run threads the answer and stays non-terminal.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ULID } from '@pc/domain';
import type {
  ActiveRunHandle,
  ResumeWithAnswerResult,
} from '../src/services/agent-active-runs.ts';

const tmpDir = mkdtempSync(join(tmpdir(), 'pc-resume-result-'));
process.env.PC_DATA_DIR = tmpDir;
delete process.env.PC_DELIVERY_TRANSPORT;

const {
  closeDb,
  runMigrations,
  createProject,
  createPendingAsk,
  getAgentRunRow,
  insertAgentRunRow,
  newId,
} = await import('@pc/db');
const { ActiveRunRegistry } = await import('../src/services/agent-active-runs.ts');
const { answerPendingAsk } = await import('../src/services/pause-resume.ts');

const stages = [{ id: 'backlog', name: 'Backlog', order: 0 }];

let projectId: ULID;

before(() => {
  runMigrations();
  const folder = join(tmpDir, 'proj');
  mkdirSync(folder, { recursive: true });
  const p = createProject({ slug: 'resume-result', name: 'Resume Result', stages, folderPath: folder });
  projectId = p.id as ULID;
});

after(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Minimal active-run handle whose resumeWithAnswer returns a scripted result —
 *  mirrors a HostBackedActiveRunHandle reporting the host command outcome. */
class FakeHostHandle extends EventEmitter implements ActiveRunHandle {
  resumeCalls: string[] = [];
  constructor(
    private readonly runId: ULID,
    private readonly result: ResumeWithAnswerResult,
  ) {
    super();
  }
  getRecord() {
    return { agentRunId: this.runId };
  }
  getState() {
    return 'paused' as const;
  }
  cancel() {}
  notifyMcpHandshake() {}
  markPaused() {}
  async resumeWithAnswer(answer: string): Promise<ResumeWithAnswerResult> {
    this.resumeCalls.push(answer);
    return this.result;
  }
  onTerminal(listener: () => void) {
    this.once('terminal', listener);
  }
}

function seedPausedRun(reg: InstanceType<typeof ActiveRunRegistry>, result: ResumeWithAnswerResult) {
  const runId = newId();
  const ccSessionId = `cc-${runId}`;
  insertAgentRunRow({
    id: runId,
    projectId,
    podName: 'builder',
    dispatcherSessionId: 'disp-1',
    ccSessionId,
    status: 'paused',
    input: 'go',
    queuedAt: Date.now(),
  });
  const askId = newId();
  createPendingAsk({
    id: askId,
    agentRunId: runId,
    ccSessionId,
    projectId,
    kind: 'orchestrator',
    promptBody: 'need input?',
    now: Date.now(),
  });
  const handle = new FakeHostHandle(runId, result);
  reg.register({
    run: handle,
    projectId,
    dispatcherSessionId: 'disp-1',
    ccSessionId,
    podName: 'builder',
  });
  return { runId, askId, handle };
}

test('host not-resumable resume → answerPendingAsk maps to resume-failed and FINALIZES the run', async () => {
  const reg = new ActiveRunRegistry();
  const { runId, askId, handle } = seedPausedRun(reg, {
    ok: false,
    cause: 'not-resumable',
    error: 'run was not resumable (state running)',
  });

  const result = await answerPendingAsk(
    { pendingAskId: askId, answer: 'do X', answeredBy: 'orchestrator' },
    {
      registry: reg,
      broadcast: () => {},
      channelServer: { emitToSession: () => true } as never,
      slug: 'resume-result',
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.cause, 'resume-failed');
  assert.deepEqual(handle.resumeCalls, ['do X'], 'the answer was sent to the host once');
  const row = getAgentRunRow(runId)!;
  assert.equal(row.status, 'failed', 'a non-resumable resume must NOT strand the run running');
});

test('resumable host resume → answerPendingAsk succeeds and does NOT finalize', async () => {
  const reg = new ActiveRunRegistry();
  const { runId, askId } = seedPausedRun(reg, { ok: true });

  const result = await answerPendingAsk(
    { pendingAskId: askId, answer: 'continue', answeredBy: 'orchestrator' },
    {
      registry: reg,
      broadcast: () => {},
      channelServer: { emitToSession: () => true } as never,
      slug: 'resume-result',
    },
  );

  assert.equal(result.ok, true);
  const row = getAgentRunRow(runId)!;
  assert.notEqual(row.status, 'failed', 'a resumable run is not finalized by the answer');
});
