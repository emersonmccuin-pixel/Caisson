// Slice 019 (Decision 4) — the deterministic "does this output need a work-item
// home?" policy. The orchestrator decides WHICH work item; this decides WHETHER
// one is required. The dispatch reject guard consults it: a required home with
// no work item supplied/creatable ⇒ reject the dispatch loudly.
//
// Locked cells + leaned-open forks (flip a lean = a one-line edit here):
//   answer   → no     (lives on the contract)
//   payload  → no     (lives on the contract)
//   prose    → depends on `store`: 'contract' / unset (defaults to contract,
//              FD-5/M5) → no; attachment / repo_file → yes
//              (☠ work_item_body — body = brief only)
//   action   → no     (the act is the deliverable; no home to persist)
//   repo     → yes    (OPEN FORK, lean: persists outside the contract, like a
//              doc on disk)
//   external → no     (OPEN FORK, lean: the returned handle is the record)
//   binary   → no     (OPEN FORK, lean: an attachment may live on the contract)
//
// Browser-safe: zero runtime deps.

import type { ExpectedOutput } from './contract.ts';

/** True when an `expectedOutput` must land in a work item — i.e. the dispatch
 *  needs a work-item link (attach an existing one or create one). */
export function expectedOutputRequiresWorkItem(spec: ExpectedOutput): boolean {
  switch (spec.kind) {
    case 'answer':
    case 'payload':
    case 'action':
    case 'external': // OPEN FORK — lean: no
    case 'binary': // OPEN FORK — lean: no
      return false;
    case 'repo': // OPEN FORK — lean: yes
      return true;
    case 'prose':
      // The default home is the contract (FD-5/M5) — no work item needed.
      // Only explicitly WI-/disk-targeted stores require one.
      return spec.store === 'attachment' || spec.store === 'repo_file';
  }
}
