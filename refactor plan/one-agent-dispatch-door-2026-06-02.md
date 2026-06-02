# One agent-dispatch door — orchestrator + workflows as callers (2026-06-02)

Product principle (user): workflows, agents, contracts, work items must share the SAME surrounding systems. A workflow must "call" an agent the same way the orchestrator does — through a contract, expected_output required. No separate systems to maintain.

## Root finding
"Run an agent" is ~10 steps. The orchestrator does all 10 through one path (`apps/server/src/services/agent-run-factory.ts` → `dispatchFreshAgent`). The workflow engine (`apps/server/src/services/dag-run-service.ts` → `dispatchAgent`) is a hand-built parallel copy that shares contract *birth* and forks everything about *running* the agent. Every fork is a bug we've hit or a missing capability.

| Step | Orchestrator (real path) | Workflow (forked copy) | Consequence |
|---|---|---|---|
| Make contract | `resolveContractForDispatch` — always creates/links a contract | `createAgentWorkItem` + ContractService directly | expected_output required-ness drifts → the "no default expected_output" failure |
| Bookkeeping + index | insert row + register in `activeRunRegistry` + host `start-run` | insert row but NOT registered; host `start-workflow-subagent` | reconciler can't match → **host-lost** kill |
| Spawn | `AgentRun` / host `start-run` | `spawnSubagent` / `hostBackedWorkflowSpawner` | 2nd spawn engine |
| Detect done | `AgentRun.isTurnEnd` / host `run-terminal` | subagent-spawner's own `isTurnEnd` | 2 copies of the fragile bit |
| Verify / deliver | `applyAgentRunTerminalEffects` (verify + mailbox + contract deliverable) | inline verify + broadcast | forked |
| Cancel/pause/resume, restart-reattach, retry | yes | none | missing in workflow |

## The door
`dispatchFreshAgent` is already the real door (requires contract, registers in active-runs, canonical spawn, unified terminal effects + verification, reattach, authoritative jsonlPath). Only gap for workflow use: orchestrator dispatches fire-and-forget; a workflow must AWAIT terminal. One shape change:
`dispatchAgent(spec) -> { runId, ccSessionId, done: Promise<TerminalOutcome> }` — orchestrator ignores `done`; workflow awaits it, maps to NodeOutcome.

Workflow KEEPS: the DAG (which agents, order, $node.output carry, gates, reject/loop, moves, bash). STOPS owning: spawn, lifecycle, completion, verify, bookkeeping.
Original fork reasons (separate cap, Activity-Panel visibility) → a flag + a tag on the one path, not a parallel system.

Payoff (all at once): expected_output required everywhere · host-lost gone · completion fragility gone · restart durability · cancel/pause/resume/retry inherited.

Migration (incremental, never breaks live orchestrator): (1) add `done` to the door (non-breaking); (2) swap dag-run-service.dispatchAgent to call door + await; (3) delete the fork (subagent-spawner, hostBackedWorkflowSpawner, workflow-subagent-handshake, host start-workflow-subagent).

## Progress (2026-06-02)
SHIPPED + verified live:
- **Workflow save-time feasibility gate** — `validateWorkflowFeasibility` in workflow-routes.ts, wired into POST + PUT. Checks: (1) every agent node resolves expected_output (node → pod column → stock map); (2) move-work-item to_stage + stage-on-entry stage are real project stages; (3) `$node.output` refs point at real nodes. Broken → 400 listing all problems; valid → saves. "Saved ⇒ runnable." (UNCOMMITTED tracked-file edit — protect via commit.)
- **Pod contract backfill** — `agents.expected_output` column was unwired (null for all 32 pods; stock used the name-keyed pod-defaults map; custom names fell through to throw). Backfilled all 18 dispatchable custom pods (no map entry) with `{kind:'answer'}` directly in the DB. Zero dispatchable pods left contract-less. Verified: jira-story node with NO override now publishes.

STILL OPEN:
- **The door unification itself** (this doc's core) — workflow still uses the forked spawn. Higher risk (dispatch hot path). Dev server is NOT hot-reload (plain `tsx`; restart per change).
- **Pod CRUD wiring** (task #6) — create/edit can't set expected_output; updateAgent needs a new `expected_output` PodAuditField. Wire + default user-created + UI. Gate/door catch contract-less pods meanwhile.
- **Agent host native crash** (task #7) — host crashed `code=4294967295` (node-pty/heap class) under spawn load this session, auto-respawned. Compounds host-lost.

Related: agent-lifecycle-live-test-2026-06-02.md (host/server CLAUDE_CONFIG_DIR fix), [[project_agent_stall_root_cause]].
