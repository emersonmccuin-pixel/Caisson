# Verification Soundness — Decision & Design (2026-06-10)

> **Status:** decision locked, build pending
> **Owner:** Emerson + orchestrator
> **Amends:** `Sub-Systems/2-brain/asks-deliverables-review.md` (§4 tier-1 verification, §3 deliverable submission)
> **Code anchors:** `packages/domain/src/ac-derivation.ts` · `packages/domain/src/ac-evaluator.ts` · `packages/domain/src/contract.ts` · `apps/server/src/services/agent-verification.ts` · `apps/server/src/services/agent-run-terminal-effects.ts` · `apps/server/src/services/agent-event-header.ts` · `packages/mcp/src/tools/agent-runs.ts`

---

## Why this exists (plain English)

In one working session, four agent dispatches that did correct, complete work were reported as
"failed" or had their output lost. Three distinct defects ([pc-pty-chat-371](pc://work-item/pc-pty-chat-371),
[pc-pty-chat-372](pc://work-item/pc-pty-chat-372), [pc-pty-chat-373](pc://work-item/pc-pty-chat-373)) —
but ONE underlying fault. This doc names the fault, states the invariant that kills the whole
*class*, and locks the design so the type can't recur.

## The one fault: a trust-bearing decision made against a PROXY, not the real artifact

| Defect | The real thing the system should judge | The proxy it actually judged |
|---|---|---|
| A (371) | "did the answer address this topic?" — a **judgment** | "does the deliverable text literally contain this topic sentence?" — a substring |
| B (372) | the agent's check, in the agent's environment, with its output | a re-run in the **server's** env, reduced to a bare exit code |
| C (373) | the typed `Deliverable` (the contract's declared source of truth) | the turn-end free-text one-liner |

A substring match is a fake judgment. An exit code with no captured output is a fake diagnostic.
A turn-end summary is a fake deliverable. Each is **confidently wrong**, which is strictly worse
than "don't know" — that is why trust in the verification tier eroded.

## The invariant (the law)

> **In any path that decides or reports on agent work, operate on the authoritative artifact or a
> SOUND check of it — never a proxy.**

A check is *sound* when a PASS actually implies the criterion is met and a FAIL actually implies it
is not. `report_contains(topic_description)` is unsound in both directions (guaranteed false
negatives; possible false positives). Soundness is the bar every derived predicate must clear.

---

## Three principles (each forbids the fault in one of its forms)

### Principle 1 — Predicate soundness: a machine check may exist ONLY where the machine can know the truth

Every `AcceptancePredicate` kind is classified:

- **Decidable** (machine can know): `files_exist`, `bash_exit_zero`, `schema_valid`,
  `git_diff_nonempty`, `tool_called`, `pending_ask_created`, `external_handle_present`,
  `attachments_present`, `fields_populated`, `field_matches`, `child_work_items_done`,
  `min_length`. Also the *syntactic* matchers `body_contains` / `report_contains` — but ONLY when
  the orchestrator authored them deliberately as a literal/regex assertion, NOT when they were
  auto-derived from a semantic intent field.
- **Judgment** (requires a competent reader): "did this prose address topic X", "is this answer
  good". There is **no decidable predicate** for these.

**Rule:** the derivation layer (`ac-derivation.ts`) must NEVER emit a decidable syntactic predicate
to stand in for a judgment criterion. Concretely:

- `answer.must_address[]` and `prose.sections[]` **no longer compile to `report_contains`.** They
  are agent *guidance* (already inlined into the dispatch prompt), not machine predicates.
- An `answer`/`prose` contract that carries `must_address`/`sections` and wants them *enforced*
  has exactly two honest fates:
  1. **trust** the agent's end-turn (`trust_end_turn: true`, empty decidable set → accept), or
  2. **route to a real judge** — `verification_tier: 'orchestrator-review'` / `'human-review'`,
     or (future, optional) an LLM-as-judge predicate `coverage_addressed` that is *explicitly*
     a judgment predicate evaluated by a model, never a substring.
- `min_chars` continues to derive `min_length` (decidable — measures the deliverable). Unaffected.

**Guardrail that prevents recurrence:** a unit test enumerates every `ExpectedOutput` field that
carries semantic intent and asserts it derives **zero** syntactic-match predicates. The next person
who wires "just substring-match the intent" fails CI.

### Principle 2 — Verification reproduces the producer's context and preserves its evidence

A decidable verdict is trustworthy only if it (a) ran where the producer ran and (b) kept the
evidence that produced it.

- **Same environment.** `createWorktreeExecutors.runBash` currently does
  `spawn(command, { shell: true, cwd })` with **no `env`** — it inherits the *server* process env
  (PATH, node version, scrubbed `CLAUDE_CONFIG_DIR`, etc.), so `npx tsc` can resolve differently
  than the agent saw. Fix: run the check in the agent's captured spawn environment (the env used to
  launch the run), or at minimum a faithfully-reconstructed one.
- **After writes flush.** Verification is dispatched from a fire-and-forget tail immediately after
  the terminal commit. There must be a barrier ensuring the agent's final file writes are flushed
  (and, for repo work, committed) before a `bash_exit_zero` / `files_exist` check runs.
- **Evidence retained.** `runBash` captures only `exitCode` + `timedOut`; stdout/stderr are
  discarded, so a failure note is just `bash command exited 1: npx tsc` — undiagnosable. Fix:
  capture a stdout/stderr tail and persist it with the verdict on the contract.

**Invariant:** *no verdict without captured evidence, run in the producer's environment.* A
decidable FAIL with empty evidence is itself a defect (and should be surfaced as "verification
inconclusive," not "work failed").

**Stretch (preferred end state):** the agent already ran its checks green before submitting. The
verifier should consume the agent's **captured proof** (a structured check result the agent
reports) or re-run in a byte-identical sandbox — not a divergent one. This makes "passes for the
agent, fails for the verifier" structurally impossible.

### Principle 3 — One authoritative deliverable, addressable and readable by every party

FD-5 already declares the `Deliverable` on the contract is the source of truth. The leak is in the
*feedback loop*, not the storage:

- **No shadowing.** `captureDeliverable` (`agent-run-terminal-effects.ts`) returns the agent's
  free-text turn `result` when it is non-empty, surfacing it in the completion envelope INSTEAD of
  the submitted `Deliverable.text`. A typed deliverable must never be shadowed by an incidental
  turn message. Fix: when a deliverable exists, the envelope surfaces `deliverable.text` (via
  `contractDeliverableText`) as the authoritative output; the free-text `result` is at most a
  secondary note.
- **Symmetric read door.** `pc_get_contract` is worker-side only (hard-requires `PC_AGENT_RUN_ID`).
  The orchestrator has no way to read a contract-only deliverable after the fact, forcing a wasted
  `pc_continue_agent` round-trip. Fix: an orchestrator-readable `pc_get_deliverable`
  (contract id or work-item/callsign → typed deliverable + report), so producer, verifier, and
  orchestrator all read the SAME object.

**Invariant:** the completion path carries/references the authoritative deliverable — never a
re-derived summary — and any party in the loop can read it on demand.

---

## What changes, by file (anchors for the build plan)

1. `packages/domain/src/contract.ts` — add a `PREDICATE_DECIDABILITY` classification (or a
   `isDecidablePredicate` guard) over `AcceptancePredicateKind`. Optionally introduce a
   `coverage_addressed` judgment-predicate kind (deferred — only if we build LLM-as-judge).
2. `packages/domain/src/ac-derivation.ts` — `deriveAnswerV2` / `deriveProseV2` STOP emitting
   `report_contains` from `must_address` / `sections`. Keep `min_length` from `min_chars`. A
   contract whose only criteria were semantic now derives an empty decidable set → falls into the
   existing `answer`-without-`trust_end_turn` → escalate-to-review branch (already in
   `agent-verification.ts`), which is the *honest* outcome.
3. `apps/server/src/services/agent-verification.ts` — `createWorktreeExecutors.runBash`: pass the
   producer's env; capture stdout/stderr tail; thread it into `PredicateFailure.reason` /
   contract notes. Add the write-flush barrier before side-effecting predicates.
4. `apps/server/src/services/agent-run-terminal-effects.ts` — `captureDeliverable` /
   `finishTerminalEffects`: surface `deliverable.text` as the authoritative envelope body; demote
   the free-text `result` to a secondary note.
5. `apps/server/src/services/agent-event-header.ts` — `buildAgentCompletedBody` renders a
   `Deliverable:` section from the authoritative deliverable.
6. `packages/mcp/src/tools/agent-runs.ts` (+ tool catalog/registry) — add orchestrator-readable
   `pc_get_deliverable`.

## Guardrail tests (authored FIRST in each slice — this is what fences the *type*)

- **Soundness test:** for every semantic-intent field, derivation emits zero syntactic predicates.
- **No-shadow test:** a submitted deliverable + a non-empty turn `result` ⇒ envelope surfaces the
  deliverable text, not the turn message.
- **Evidence test:** a `bash_exit_zero` failure carries a non-empty stderr/stdout tail in the notes.
- **Read-door test:** `pc_get_deliverable` returns the typed deliverable for a contract-only
  dispatch from an orchestrator session.
- **Env test:** `runBash` executes with the producer's env (PATH parity assertion).

## Non-goals / explicitly deferred

- LLM-as-judge (`coverage_addressed`) is OUT of the first build — it's the *optional* honest path
  for enforced semantic criteria, but routing to `orchestrator-review` already removes the false
  negative. Build it only if we find we want machine-graded coverage without a human/orchestrator.
- Reworking review-tier UX is out of scope (covered by the Human Inbox workstream).

---

Filed here because: this is a cross-cutting design decision on the verification core that multiple
build slices and future authors must honor; it is domain truth beyond any single task.
