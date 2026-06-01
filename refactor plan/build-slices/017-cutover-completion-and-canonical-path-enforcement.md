# 017 Cutover Completion + Canonical-Path Enforcement (flip → test → delete)

## 1. Baseline and Decision

| Field | Value |
|---|---|
| Date | 2026-06-01 |
| Branch | `refactor/auto-pathway` |
| Artifact status | Planned build slice (NEXT priority — ahead of 013/014) |
| Owning roadmap phase | Phase 9 delivery cutover completion + the deferred slice-012 "compatibility cleanup" (folded out of 015c) |
| Slice subject | Finish the cutover the refactor never completed: **flip every delivery flow + live path onto the new system by default, verify everything live, then delete the old paths and the leftover legacy guards.** This is the close-out that makes the new work the ONLY work. |
| Implementation target | This repo. Do not create a parallel app. |
| Scope rule | Build plan only. Do not implement until the user explicitly asks to build. |

### The core finding that motivates this slice

The refactor built a complete new system — mailbox delivery, the live-event/outbox spine, the relay — **alongside** the legacy Channel path, defaulting to the old path for safety during cutover (slice 008's "reversible, fallback-preserving" design). The step that was supposed to flip the defaults on and delete the old path was slice 012, which got folded into 015c — **and the actual flip never happened.**

Consequence: the user has been dogfooding the OLD Channel path the entire time. Every `agent-completed` still arrives via `<channel source="webhook">`, not the mailbox. The new system is finished, tested, and audited-clean — but switched off behind env flags that default to "off" with no UI surface revealing which path is live. "Nothing feels live" because, for the running app, it isn't — yet.

### Decision

Three ordered phases, gated on user sign-off between each:

- **Phase A — Flip + make-it-actually-fire.** Default the new path on (delivery gates → `mailbox`) AND fix the bugs that keep the new live paths from firing even when on (the agent-run announce guard, the unannounced `queued` insert, the attachment durable-write gap, the unwired workflow boot-reconcile). Old paths stay present but dormant.
- **Phase B — Test everything live.** Gated relaunch with the new defaults; run the full cross-subsystem live-propagation + mailbox-delivery checklist (§8). Confirm every panel updates with no refresh and every delivery rides the new path.
- **Phase C — Delete the old paths + enforce one door.** Only after Phase B is green: rip the delivery gates + Channel fallback, fix the host-not-aware kill/cancel family, tighten the no-bypass gate to catch this bug class, consolidate the duplicate send-queue drainers, fix the stray NUL byte. End state: exactly one path per subsystem, structurally enforced.

Rationale: the "verify before deleting" precondition slice 008 set is now MET — the four-cluster canonical-path audit (this session) verified the new paths are clean. So deletion is no longer premature; it's overdue.

## 2. Problem Statement — the issues, with evidence

All file:line references gathered in the 2026-06-01 investigation + the four-cluster canonical-path audit (Cluster A/B/C/D reports attached to their agent work items).

### Group 1 — The new system is switched off by default (the headline)

- **Delivery gates default to Channel.** `readDeliveryMode` (`apps/server/src/services/delivery-routing.ts:27-30`) resolves any absent/unknown env value to `'channel'`. Three independent flows: `PC_DELIVERY_AGENT`, `PC_DELIVERY_WORKFLOW_REVIEW`, `PC_DELIVERY_WEBHOOK` (`:20-24`). Mirror default in `agent-delivery.ts` `readTransportMode()`. With no env set (the normal launch), agent completions, workflow-review prompts, and webhook events ALL ride the legacy Channel path.
- **No surface tells you which path is live.** The only signal is the `<channel source="webhook">` envelope shape. The running dev stack was not launched with the mailbox env set, so it's entirely on Channel.

### Group 2 — Live paths that don't fire even when the system is "on"

These are independent of the delivery gate — they break live UI propagation regardless.

- **Agent-run durable write is gated behind the legacy broadcast hook (HIGH).** In `apps/server/src/services/agent-run-factory.ts`, both `broadcastAgentRunChanged` (line **826**) and `broadcastStateChanged` (line **949**) begin with `if (!args.deps.broadcast) return;` — and `announceAgentRunChange` (which writes the `live_outbox` row) sits AFTER that guard. So any agent-run transition on a path without a broadcast hook writes NO outbox row → no relay frame → the agent never appears live. The initial `queued` insert (`agent-run-factory.ts:344`) is a raw repo write with NO announce at all — the first emit depends entirely on a later gated transition firing. Contrast the correct shape: `applyAgentHostEvent` (`agent-host-reattach.ts:259`) calls `announce` UNCONDITIONALLY (broadcast is just an optional extra arg). This is the exact anti-pattern slice 015 set out to kill: the durable fact must never depend on the in-memory broadcast.
- **Attachments never propagate live (HIGH — Cluster D, finding D1).** `attachment-changed` (`apps/server/src/services/attachment.ts:77,88`) is a DB-owned fact delivered only via a bare `broadcast` dep param — NO `live_outbox` write, despite `attachment` being a registered entity/type. No live propagation, no reconnect replay. Directly hits `pc_attach_to_work_item` — the agent deliverable channel.
- **Workflow boot-reconcile imported but never called (MED — Cluster B, finding 1).** `reconcileWorkflowRunsOnBoot` is imported at `apps/server/src/index.ts:35` but never invoked. Interrupted `running`/`pending` workflow runs never fail-closed after a crash. The slice-004 plan §18 note claiming it's "wired" is stale/false.

### Group 3 — Old paths that lie or leak (delete/repair in Phase C)

- **`/kill` not host-aware (MED-HIGH — Cluster B, finding 2).** `hardKillAgentRun` (`apps/server/src/services/agent-run-control.ts:69`) force-kills the local `row.pid` + finalizes the DB row, but never issues a host stop command. In host mode the host-side run can survive while the DB says cancelled.
- **`/cancel` bypasses the durable door (MED — Cluster B, finding 3).** `apps/server/src/features/agent-runs/routes.ts:202` is registry-only (`entry.run.cancel()`), 404s with no handle; not phantom/host-orphan safe. (Groups 2+3 here = the slice-009-deferred "host-not-aware kill family.")
- **No-bypass gate is blind to this bug class (MED — Cluster D, finding D2).** `apps/server/test/no-bypass-gate.test.ts` (self-admitted at L105-108) cannot see bare `broadcast(...)` dep-param fact fanout — only the literal `broadcast`/`fanoutMessage` strings. That's WHY the attachment + agent-run gaps slipped past 015c. It catches hand-fanout, not durable-write OMISSION.
- **Send-queue has two coexisting drain orchestrators (LOW-MED — Cluster C).** The legacy `orchestrator-send-queue-delivery.ts` (live PTY-handler path + jsonl correlation) vs the `ConversationSendService` facade (user/mailbox turns), with separate non-spanning single-flight locks + an unconditional `markOrchestratorSendDelivering`. Latent double-delivery race.
- **`deliverAgentEnvelope` silently falls back to Channel even at gate=mailbox if the port is unwired (LOW — Cluster C).** Latent; all live sites currently wired, but it masks misconfiguration.
- **Stray NUL byte in `apps/server/src/index.ts` (trivial — Cluster B).** Around offset ~27086; makes ripgrep treat the file as binary. Edit surgically.

### What is already CLEAN (confirmed by the audit — do not touch)

- Projects / work-items / areas: single mutation-gateway door, no bypassers (Cluster A).
- Mailbox platform itself: clean single-tx write-door + worker lease/retry/dead-letter, zero bypassers (Cluster C, slice 007).
- The delivery gate funnels all three flows correctly; Channel is an intentional fallback, no boot-handler race anymore (Cluster C; the MEMORY "boot handlers carry no mailbox port" note is STALE — slice 009 relocated the bindings, `index.ts:438/482/514`).
- MCP typed client: `ctx.client` is the single path; `packages/mcp` has zero `@pc/db`/`broadcast`/`live_outbox` (Cluster D). `TOOLS` is the sole source of truth; `CAPABILITIES` is parity-guarded.
- Relay + WS subscribe/`catchUp`/`live-reset` reconnect path correctly wired (`live-relay.ts`, `use-project-ws.ts`); the relay drains every 250ms (`index.ts:669`) and is generic across entities (Cluster D).

## 3. Scope and Non-Goals

In scope: the three phases above — flip defaults, fix the Group 2 live-fire bugs, verify live, then delete Group 1 gates + repair Group 3.

Non-goals: slice 013/014 work (agent contracts as first-class entity, reliable deliverables) — those resume after 017. No new features. No DB migration expected (every table already exists). No new delivery primitive.

## 4. Files Likely Affected

- `apps/server/src/services/delivery-routing.ts` — flip defaults (Phase A) → delete gate entirely (Phase C).
- `apps/server/src/services/agent-delivery.ts` — `readTransportMode` mirror default; Channel fallback removal (Phase C).
- `apps/server/src/services/agent-run-factory.ts` — remove the `!args.deps.broadcast` guards (826, 949); announce the `queued` insert (344).
- `apps/server/src/services/attachment.ts` — add a gateway `live_outbox` write + relay delivery (77, 88).
- `apps/server/src/index.ts` — wire `reconcileWorkflowRunsOnBoot` (imported :35); fix NUL byte.
- `apps/server/src/services/agent-run-control.ts` — host-aware `/kill` (issue host stop command).
- `apps/server/src/features/agent-runs/routes.ts` — route `/cancel` through the durable gateway (phantom/host-safe) (:202).
- `apps/server/test/no-bypass-gate.test.ts` — tighten to flag bare-`broadcast` fact fanout / durable-write omission.
- `apps/server/src/services/orchestrator-send-queue-delivery.ts` + the `ConversationSendService` facade — consolidate to one drainer (Phase C, needs a small design decision).

## 5. Migration / Build Steps (ordered)

**Phase A — flip + make-it-fire (one commit per fix, all behind the relaunch):**
1. Flip `readDeliveryMode` + `readTransportMode` defaults `channel` → `mailbox` (keep the env override working — flipping back is still possible until Phase C).
2. Remove the `if (!args.deps.broadcast) return;` guards in `agent-run-factory.ts` (826, 949) so the durable announce always writes; add an announce immediately after the `queued` insert (344).
3. Give attachments a gateway `live_outbox` write (mirror the work-item gateway pattern) + relay delivery; drop the bare-broadcast-only emit.
4. Wire `reconcileWorkflowRunsOnBoot` at boot (mirror the agent-run reconcile call).

**Phase B — verify live (no code; gated relaunch + checklist §8).**

**Phase C — delete + enforce (only after B green):**
5. Delete the three delivery gates + the Channel fallback (`delivery-routing.ts`, `agent-delivery.ts` Channel branch, `agent_inbox`/`postChannel`/`enqueueAndPush` legacy senders for flows A/B; keep external webhook INGEST `/channel/:slug/:source` since that's the inbound transport, but route it to mailbox unconditionally).
6. Host-aware `/kill` + durable-door `/cancel`.
7. Tighten the no-bypass gate to catch bare-broadcast fact fanout.
8. Consolidate the send-queue drainers (pick one).
9. Fix the NUL byte.

## 6. Rollback

- Phase A is reversible per-fix (env can still flip delivery back until Phase C; the announce/attachment/reconcile fixes are additive — worst case they over-announce, which the client dedupes by `id`+`version`).
- Phase C is the point of no return for the Channel path — do NOT start it until Phase B signs off. After C, reverting means a git revert, not an env flip.

## 7. Stop Conditions

- If Phase B surfaces ANY subsystem that doesn't propagate live on the new default, STOP — fix the fire-path before any deletion.
- If deleting a Channel sender would break the external per-CC bridge (`channel-server/server.js`) ingest, STOP and confirm scope (the inbound `/channel` listener stays; only the outbound agent/workflow Channel emits are deleted).
- Adding a new contract DTO / new emit primitive is out of scope — STOP and confirm.

## 8. Tests + Manual Verification (Phase B checklist)

Relaunch gated: `PC_DELIVERY_AGENT=mailbox PC_DELIVERY_WORKFLOW_REVIEW=mailbox PC_DELIVERY_WEBHOOK=mailbox pnpm dev:app`. Two tabs A/B for propagation.

1. **Agent appears live:** dispatch an agent → it shows in the Activity Panel "Running agents" with NO refresh (the Group 2 bug); completes → drops from the running list live.
2. **Agent-done via mailbox, not Channel:** the completion arrives as ONE orchestrator turn via the mailbox (delivery `accepted`), and there is NO `<channel source="webhook">` agent envelope.
3. **Attachment appears live:** `pc_attach_to_work_item` → the attachment shows in the work-item modal with no refresh, and survives a tab reconnect (replay).
4. **Workflow-review via mailbox:** an orchestrator-review prompt arrives via mailbox; approve/reject works.
5. **Webhook via mailbox:** external `POST :8788/channel/<slug>/<source>` to a child-less project → lands durably in the inbox (no silent drop).
6. **Workflow crash recovery:** an interrupted running workflow run fails-closed on boot (the now-wired reconcile).
7. **No regression:** projects / work-items / areas still propagate live (the already-clean paths).
8. **Gates green:** full `pnpm typecheck` exit 0; `@pc/server` suite incl. the tightened no-bypass gate; client dedupe holds (no double-render).

## 9. Tracker Update

Add session rows for 017 (Phase A build → Phase B human review → Phase C build → final review). 017 is the NEXT priority, ahead of 013/014. The deferred slice-012 "compatibility cleanup" is subsumed by 017 Phase C.
