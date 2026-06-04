// Slice 014c — the `store` EXECUTOR. Submission-gated completion (014/014b)
// validated the deliverable SHAPE but never acted on `expectedOutput.store`, so
// a `prose` contract declaring `store: work_item_body` had its text written only
// onto the contract row while verification read the (never-written) work-item
// body — structurally un-passable. This applies the deliverable to its declared
// home AT SUBMIT, atomically, before verification runs at terminal.
//
// `store` is a prose-only directive. Every other deliverable kind lands its
// evidence in its real home natively (repo → git, external → the outside system,
// binary → an attachment, action → the run transcript) or is read straight off
// the contract (answer/payload). Those kinds are a no-op here.
//
// Path-write parity with the verifier: `repo_file` resolves against the
// worktree (or project root) + rejects paths that escape it — same guard the
// `files_exist` predicate enforces (see [[startsWith-path-containment]]).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { createAttachment, getWorkItem, updateWorkItemFields } from '@pc/db';
import type { Contract, Deliverable } from '@pc/contracts';
import type { ULID } from '@pc/domain';
import { ContractV2, proseAttachmentName } from '@pc/domain';
import { WorkItemMutationGateway } from '@pc/app-services';

/** FD-12 — the one write door (repo write + outbox receipt in one txn). The
 *  body write was previously SILENT (no work-item.changed receipt) — the UI
 *  only saw the deliverable land on a lucky refetch. */
const workItemGateway = new WorkItemMutationGateway();

export type StoreApplyOutcome =
  | 'none' // not a prose/store deliverable — nothing to place
  | 'contract' // text stays on the contract row (verification reads it via report fallback)
  | 'work_item_body'
  | 'attachment'
  | 'repo_file';

export type StoreApplyResult =
  | { ok: true; applied: StoreApplyOutcome }
  | {
      ok: false;
      /** `store-target-missing`: the declared home (work item) is gone/archived.
       *  `store-path-invalid`: a repo_file path is absent or escapes the base.
       *  `store-write-failed`: the write threw. All are retryable in-band so the
       *  agent gets a real error instead of a misleading later verify failure. */
      cause: 'store-target-missing' | 'store-path-invalid' | 'store-write-failed';
      error: string;
    };

export interface ApplyDeliverableStoreInput {
  contract: Contract;
  deliverable: Deliverable;
  /** Producing run id — stamped on a created attachment for provenance. */
  runId?: ULID | null;
  /** Producing agent name — stamped on a created attachment. */
  agentName?: string | null;
  /** Project root on disk — the fallback base for an in-place `repo_file`. */
  projectFolderPath: string;
}

/** Apply a submitted deliverable to the destination its contract declares. */
export function applyDeliverableStore(input: ApplyDeliverableStoreInput): StoreApplyResult {
  const { contract, deliverable } = input;
  const expected = contract.expectedOutput;

  // Only prose carries `store`, and only the text variant has something to
  // place (the attachmentId/ref variants mean the agent already persisted it).
  if (
    !expected ||
    expected.kind !== 'prose' ||
    deliverable.kind !== 'prose' ||
    typeof deliverable.text !== 'string' ||
    deliverable.text.trim() === ''
  ) {
    return { ok: true, applied: 'none' };
  }

  const text = deliverable.text;
  const store = resolveStore(expected, contract.workItemId);

  switch (store) {
    case 'contract':
      // No external write — the contract row IS the home. Verification reads
      // the text via the report fallback in agent-verification.ts.
      return { ok: true, applied: 'contract' };

    case 'work_item_body': {
      const wi = requireLiveWorkItem(contract.workItemId, 'work_item_body');
      if (!wi.ok) return wi;
      try {
        workItemGateway.tryCommitWorkItemChange({
          projectId: wi.projectId,
          mutate: () => {
            const row = updateWorkItemFields(wi.id, { body: text });
            return row ? { row, reason: 'patched' } : null;
          },
        });
      } catch (err) {
        return writeFailed('work item body', err);
      }
      return { ok: true, applied: 'work_item_body' };
    }

    case 'attachment': {
      const wi = requireLiveWorkItem(contract.workItemId, 'attachment');
      if (!wi.ok) return wi;
      try {
        createAttachment({
          workItemId: wi.id,
          kind: 'document',
          name: proseAttachmentName(expected),
          content: text,
          contentType: 'text/markdown',
          runId: input.runId ?? null,
          source: 'agent',
          agentName: input.agentName ?? null,
        });
      } catch (err) {
        return writeFailed('attachment', err);
      }
      return { ok: true, applied: 'attachment' };
    }

    case 'repo_file': {
      const rel = expected.path;
      if (!rel || rel.trim() === '') {
        return {
          ok: false,
          cause: 'store-path-invalid',
          error: 'prose store "repo_file" requires expectedOutput.path',
        };
      }
      const base = contract.worktreePath ?? input.projectFolderPath;
      const abs = resolve(base, rel);
      if (!isInside(abs, base)) {
        return {
          ok: false,
          cause: 'store-path-invalid',
          error: `repo_file path "${rel}" escapes the project root`,
        };
      }
      try {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, text, 'utf8');
      } catch (err) {
        return writeFailed(`repo file ${rel}`, err);
      }
      return { ok: true, applied: 'repo_file' };
    }
  }
}

/** Default store: `work_item_body` when a WI is linked, else `attachment` —
 *  mirrors the contract doc's documented default. */
function resolveStore(
  expected: Extract<ContractV2.ExpectedOutput, { kind: 'prose' }>,
  workItemId: string | null,
): ContractV2.ProseStore {
  return expected.store ?? (workItemId ? 'work_item_body' : 'attachment');
}

function requireLiveWorkItem(
  workItemId: string | null,
  store: string,
):
  | { ok: true; id: ULID; projectId: ULID }
  | { ok: false; cause: 'store-target-missing'; error: string } {
  if (!workItemId) {
    return {
      ok: false,
      cause: 'store-target-missing',
      error: `prose store "${store}" requires a linked work item`,
    };
  }
  const id = workItemId as ULID;
  // getWorkItem returns null for archived/soft-deleted rows — treat as missing.
  const row = getWorkItem(id);
  if (!row) {
    return {
      ok: false,
      cause: 'store-target-missing',
      error: `work item ${workItemId} not found or archived`,
    };
  }
  return { ok: true, id, projectId: row.projectId };
}

function writeFailed(
  what: string,
  err: unknown,
): { ok: false; cause: 'store-write-failed'; error: string } {
  return {
    ok: false,
    cause: 'store-write-failed',
    error: `failed to write deliverable to ${what}: ${err instanceof Error ? err.message : String(err)}`,
  };
}

/** Path-containment guard — parity with the verifier's `fileSize` executor.
 *  Rejects '' (the base itself), '..' escapes, and absolute relatives. */
function isInside(abs: string, root: string): boolean {
  const rel = relative(root, abs);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
