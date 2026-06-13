# Workflow system review — 2026-06-11

Scope: full pass over the v2 workflow engine (domain model → pure DAG brain →
executor → live deps → routes → UI) and how it composes with the agent
contract/dispatch system. Method: two parallel deep code maps (engine +
contracts/dispatch), every flagged issue hand-verified in code before acting.

**Status: the items under "Shipped" landed on this branch
(`claude/workflow-system-optimization-99v4fj`). The items under
"Recommendations" are design proposals — not built.**

---

## How the workflow system composes with contracts (verified, as-built)

The architecture is sound and genuinely one-path:

- A workflow **agent node** mints a child work item + linked contract
  (`createAgentWorkItem`), then dispatches through the SAME door the
  orchestrator uses (`dispatchFreshAgent`) — contract-required refusal,
  worktree-isolation provisioning, unified terminal + verification all apply.
  There is no second dispatch path for workflows.
- `$nodeId.output` resolves to the **contract deliverable** (not the child WI
  body), so a step that produced no deliverable can never leak its task text
  downstream — the run fails honestly instead.
- Review gates, the loop ceiling escalation, merge conflict gates, and run
  failure notices all flow through the durable mailbox; gate decisions are
  protected by the per-run lock + the not-awaiting / instance-token guards.

## Shipped on this branch

### Feature: the `call` node — engine-executed MCP tool calls (no agent)

The headline gap: external actions (Gmail draft, Snowflake query, any API)
required dispatching a whole agent even when the step was purely mechanical.
The MCP **registry** (`mcp_servers` table, global + project scope, transport
config, tool discovery) already existed; nothing let a workflow use it
directly.

New sixth node kind:

```yaml
- id: fetch-pipeline
  kind: call
  server: snowflake          # a registered MCP server (project scope wins)
  tool: run_query
  args: { sql: "select * from deals where quarter = '{{q}}'" }
  input: { q: "$root.output.quarter" }
  next: [draft-summary]
- id: draft-summary
  kind: agent
  agent: writer
  task: "Summarise for the exec email:\n$fetch-pipeline.output"
  next: [send-draft]
- id: send-draft
  kind: call
  server: gmail
  tool: create_draft
  args: { to: "emerson@haasalert.com", body: "$draft-summary.output" }
```

Mechanics (all positive-receipt):

- Engine connects to the registered server (stdio or streamable HTTP), invokes
  the one tool, captures the result, disconnects. Tool error / transport
  failure / timeout → **typed step failure**, never a silent hang
  (`packages/mcp/src/call.ts`, hard timeout, guaranteed teardown — mirrors the
  probe).
- Output is captured into the node record (`NodeRunRecord.output`, capped at
  32 KB): `$callId.output` reads it whole; `$callId.output.field` reads a key
  when the tool returned a JSON object / structuredContent.
- Args render with the same substitution as agent tasks (`$refs`, `$carry.*`,
  `{{name}}` input ports) at any nesting depth; non-string JSON passes through.
- Save-time validation: `server`/`tool` required; publish fails if the server
  isn't in the registry (mirrors the pod feasibility checks); call args are
  ref-ordering-validated like task bodies; call steps are legal ref sources.
- Diary: a `tool_called` event records server, tool, ok, durationMs (+ error),
  rendered in the run diary UI.
- `when:` guards, `timeout`, `trigger_rule`, loops-over-call-steps all work —
  call nodes ride the existing brain unchanged.
- Surfaces updated: validator, executor, live deps (injectable
  `mcpToolCaller` seam for tests), mermaid (subroutine box), graph UI (kind
  config + detail panel), workflow-builder pod prompt (with guidance: `call`
  for mechanical steps, `agent` where judgment is needed; gate irreversible
  sends behind a review), `pc_publish_workflow`/`pc_create_workflow` tool
  descriptions (+ goldens).
- Tests: 24 new (validation · executor · live-dep integration over a real DB).

### Bug fixes

1. **`moveCard` fake success** (`dag-run-service.ts`) — the gateway commit
   result was discarded: a move that didn't commit still returned `ok: true`
   and the step completed. Violated FD-9 ("a failed move fails the step
   honestly") + positive receipt. Now returns a typed failure when the commit
   didn't happen; the stale "best-effort" comment (contradicting the
   executor's contract) is gone.
2. **`resumeCompatErrors` missing kind check** (`dag/step.ts`) — the doc
   comment promised "must still exist with the SAME kind" but only existence
   was checked; a settled agent node redefined as a move node would carry its
   kept `completed` into a different kind of work. Now compares against the
   run's frozen snapshot (threaded from `resumeFailedDagRun`).
3. **`loop.carry` never validated** (`dag/validate.ts`) — a typo'd carry ref
   (`$nope.output`) silently substituted `''` into the re-run at kick-back
   time. Now validated at save: shape (identifier → string) + ref integrity
   (known node, output-producing kind; `$self`/`$root` allowed).
4. **Tick-safety exhaustion silently finalized** (`dag-executor.ts`) — if
   `advance()` ever hit the 1000-tick guard it fell through to `finalize()`,
   which can persist a still-`running` status: a silent hang. Now a typed run
   failure (`workflow_failed` diary line + `notifyRunFailed`).
5. **Field-form refs on captured-output nodes resolved to ''** — now parse a
   JSON-object output and read the key (needed for call results; benign for
   the legacy path).

Verification: `pnpm -r typecheck` green; server suite 543/549 (the 6 failures
are container git-commit-signing environment issues in `verification-git-diff`
/ `attach-to-git` setup, pre-existing and unrelated); domain 111, db 108,
app-services 85, contracts 116, mcp 104, web 51 — all green; web build smoke
green.

---

## Recommendations (not built — proposals, roughly in priority order)

### 1. Credentials for connectors: secret-ref indirection in transports

Registry transport configs (`headers` for HTTP, `env` for stdio) will carry
API tokens for Gmail/Snowflake-class servers and are stored in plaintext in
SQLite today. Pods already have a secrets facility; the registry should join
it: allow `headers: { Authorization: "$secret:gmail-oauth" }` resolved at
connect time from the secrets store, never persisted resolved, scrubbed from
probe/call error text. This is the main hardening needed before putting real
credentials through `call` nodes.

### 2. Idempotency for `call` steps that perform irreversible actions

A loop kick-back or resume re-runs a call node; "create draft" is safe to
repeat, "send email" is not. The `external` contract kind already models
`idempotency_key` — call nodes should grow an optional
`idempotency: "key-template"` arg the engine renders and passes through (for
servers whose tools accept one), and the builder guidance already steers
irreversible sends behind review gates. Until then the convention is:
draft-creating tools + a review gate before any send.

### 3. Narrow retry for `call` nodes only

`RetryPolicy` was deliberately deleted because it was dead schema and agents
shouldn't blind-retry. Call steps are different: deterministic, cheap, and
prone to transient API failures. A bounded `retries: N` (default 0) with
backoff on *transport* failures only (never on tool-level `isError`) is
consistent with the one-retry-construct principle — the loop remains the only
*judgment* retry.

### 4. `pc_list_mcp_servers` read tool

Neither the orchestrator nor the workflow-builder can see what's registered;
the builder learns only via publish failure. A read-only registry list tool
(name, scope, discoveryStatus, discoveredTools) closes the loop and lets the
orchestrator propose `call` steps from real data.

### 5. Clear stale `rejectFeedback` when a loop's gate finally approves

Reviewer notes stashed in `rejectFeedback[reviewId]` survive the subtree reset
(by design, to feed `$carry.feedback`) but are never cleared. A later resume
that re-runs the subtree re-injects feedback that was already addressed.
Small: clear the entry on the owning review's approve.

### 6. Worktree lifecycle for terminal runs

`fireDagWorkflow` provisions `wf-<id>` worktrees; cancel/fail/complete never
release them. Disk + `git worktree list` grow on the daily driver. Add a
sweep (or release on terminal with a grace window), mirroring the agent-host
terminal-run eviction shipped in the June-10 audit.

### 7. One run per root card

Nothing prevents two in-flight runs sharing a `work_item_id` (fire twice on
the same card) — two runs then fight over the same worktree branch and card
moves. A fire-time guard ("a run is already in flight on this card") is
cheap; an index makes it structural.

### 8. `dag-merge-run-service.test.ts` duplicates the closure it tests

The test file re-implements `makeMergeToDev` by hand ("mirrors the closure"),
so the real `mergeToDev` can drift from what's tested — exactly the dual-path
pattern the project forbids, in test form. Export the closure (or a factory)
from `dag-run-service.ts` and test the real one. (The new call-node tests
test the real dep via `makeExecutorDeps`, deliberately.)

### 9. Diary polish

`git_merged` / `git_conflict` fall through to the raw-type default line in the
run diary renderer (`WorkflowsList.tsx diaryLine`); give them friendly lines
like the rest. (`tool_called` shipped with one.)

### 10. Roadmap fit

The `call` node is also the natural substrate for two existing backlog items:
the build workflow's deploy/notify conveniences, and — once pc-pty-chat-270's
verified-git engine work lands — keeping *judgment-free side-effects as engine
steps, agents only where judgment lives*, which is the same principle 270
articulates for git.
