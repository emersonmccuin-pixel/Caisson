# 008 Channel Cutover (gated, fallback-preserving)

## 1. Baseline and Decision

| Field | Value |
|---|---|
| Date | 2026-05-31 |
| Branch | `refactor/auto-pathway` |
| Commit | baseline `ef40a6db` (slices 001/002/003 verified; 004/005/006/007 built + fix, human review pending) |
| Artifact status | Planned build slice |
| Owning roadmap phase | Phase 9 delivery cutover off Channel (mailbox spec §10 Phases 6–8) |
| Slice subject | Move the THREE delivery flows (agent delivery, workflow review delivery, external webhook delivery) OFF Channel and ONTO the slice-007 mailbox, **with the Channel path kept as a gated, reversible fallback**. NOT a Channel deletion (that is slice 011). |
| Implementation target | This repo. Do not create a parallel app. |
| Scope rule | This is a build plan only. Do not implement until the user explicitly asks to build. |

Decision:

- **Recommendation (recommendation):** For each of the three delivery flows, add a per-flow **delivery selector** that routes the emit either through the slice-007 `MailboxService.enqueue` (new path) or through the existing Channel call (`enqueueAndPush` / `postChannel` / the `/channel/:slug/:source` fan-out) (legacy fallback). The selector is a config-driven switch with a safe default (Channel) so the cutover is reversible and verifiable per flow before Channel is retired. The mailbox enqueue maps each flow to a typed `MailboxAddress` + `MailboxDeliveryChannel` so the slice-007 worker delivers it (orchestrator-turn → the send-queue facade; ui-inbox → the UI inbox). No new delivery primitive is invented — the cutover only re-points existing call sites at the already-built mailbox platform.
- **Reason (verified + synthesis):** The mailbox PLATFORM shipped in slice 007 (verified: `MailboxService`/`PendingInteractionService` write-doors, `MailboxWorker` lease/ack/retry/dead-letter, the `MailboxOrchestratorTurnAdapter` over the slice-006 send facade, mailbox HTTP routes, the canonical `mailbox.*` live events, and a web inbox) — additively, ALONGSIDE an untouched Channel. The foundation spec (`mailbox-and-pending-interactions.md` §10 Phases 6/7/8) names exactly these three flows as the cutover, each with an explicit "feature flag back to current Channel/inbox" rollback. So slice 008 is the re-pointing of senders + the gate, not a platform build.
- **Compatibility stance (verified + recommendation):** Everything stays reversible. Channel, `agent_inbox`, `/channel/:slug/:source`, `/channel-register`, `channel-event`, `enqueueAndPush`, `postChannel`, the per-CC bridge (`channel-server/server.js`), and the `compat-channel` enum value are NOT deleted (slice 011). The gate defaults to the legacy Channel path so a fresh checkout behaves exactly as today; flipping a flow to mailbox is opt-in and individually revertible. No DB migration (slice 007 already added every table). No legacy WS envelope or route is removed.

## 2. Problem Statement

Verified facts (code-evidence based, this checkout `ef40a6db`):

- **Flow A — Agent delivery rides `enqueueAndPush` at FOUR call sites, all through `ChannelServer`.** `enqueueAndPush` (`apps/server/src/services/agent-delivery.ts:71`) writes an `agent_inbox` row + best-effort `ChannelServer.emitToSession` push (transport modes `hybrid`/`inbox-only`/`channel-only` via `PC_DELIVERY_TRANSPORT`). Call sites:
  - `agent-run-factory.ts:1016` — `agent-queued-started` envelope to the dispatcher session (on the `queued-started` runtime event).
  - `agent-run-terminal-effects.ts:274` (`emitTerminalEnvelope`) — `agent-completed` / `agent-failed` envelope to the dispatcher session.
  - `pause-resume.ts:181` (`recordExplicitPause`) — the `agent-asks-orchestrator` / `agent-asks-user` / `agent-approval-request` envelope to the dispatcher session.
  These all target `pcSessionId = dispatcherSessionId`, `slug`, `source:'agent'`, with a prebuilt body string (`buildAgentCompletedBody`/`buildAgentFailedBody`/`buildPauseEventBody`/`buildAgentQueuedStartedBody`).
- **Flow B — Workflow review delivery rides `postChannel` at TWO call sites.** `postChannel` is an injected `ChannelPoster` (`dag-run-service.ts:134`) whose default (`makeExecutorDeps`, `dag-run-service.ts:370`) is `fetch("http://127.0.0.1:${channelPort}/channel/${slug}/${source}")` — i.e. it loops back through the SAME `/channel/:slug/:source` HTTP listener external webhooks use. Call sites:
  - `dag-run-service.ts:666` (`requestReview`, the live DAG executor's orchestrator-review branch) — `await postChannel(body, 'workflow')`, then emits the durable slice-004 `workflow.review.changed` (pending) fact + the legacy `workflow-v2-review-pending` broadcast.
  - `orchestrator-review-step.ts:53` (`runOrchestratorReviewStep`, the legacy step dispatcher) — `await deps.postChannel(body)`, then broadcasts a local `review-pending` event.
  `human-review` nodes do NOT post to Channel today — they only emit the broadcast (verified: `dag-run-service.ts:665` gates the `postChannel` on `node.kind === 'orchestrator-review'`).
- **Flow C — External webhook delivery is the `/channel/:slug/:source` HTTP listener itself.** `ChannelServer.start()` registers `POST /channel/:slug/:source` (`channel-server.ts:73`): validate `X-Sender` against an allowlist, resolve the slug → project, then `forwardToProjectChildren(project, event)` (fan to EVERY registered child of the project, `:228`) + `onEvent(project.id, event)` (`:93`). The server wires `onEvent` to a `channel-event` UI broadcast (`index.ts:283`). When no child is registered, `forwardToProjectChildren` logs and **drops** the event (`:236`). This is the "silently drops" gap the spec §2 calls out.
- **The slice-007 mailbox platform is fully built and reachable.** `MailboxService.enqueue(EnqueueMailboxMessageInput)` (`packages/app-services/src/mailbox/mailbox-service.ts:113`) is a single-transaction outbox-write-door; the CALLER supplies each recipient's `channel` (`EnqueueMailboxRecipientRow.channel`, `packages/db/src/repos/mailbox.ts:44`) and a stable `idempotencyKey` (replay returns the existing rows, `created:false`). The `MailboxWorker` (`mailbox-worker.ts`) leases due deliveries and attempts by `channel`: `ui-inbox` → accept immediately; `orchestrator-turn` → `MailboxOrchestratorTurnAdapter.deliver` → the slice-006 `enqueueRuntimeTurn` facade (stable `mb:${deliveryId}` clientMessageId → at most one runtime turn); `compat-channel` → currently `fail('unsupported delivery channel', false)` (unwired). The worker resolves `orchestrator-session` / `active-orchestrator` addresses (`resolveOrchestratorSession`, `:185`); other address kinds for orchestrator-turn return "no orchestrator session resolvable" → dead-letter (NOT a silent drop).
- **There is no delivery selector / cutover gate today.** `rg "PC_DELIVERY_TRANSPORT"` finds only `agent-delivery.ts` (the Channel-internal hybrid/inbox/channel-only switch — NOT a mailbox-vs-Channel switch). There is no per-flow mailbox-vs-Channel config key anywhere. (Verified: slice-007 doc §16 explicitly DEFERRED "what feature flag controls per-message-kind fallback" to slice 008.)
- **`mailboxService` is a single index.ts singleton** (`index.ts:465`), constructed AFTER `channelServer` (`:280`) and BEFORE the route registrations (`registerAgentRunRoutes` at `:807`, `registerMailboxRoutes` at `:513`). The agent-run routes already receive `channelServer` as a dep (`features/agent-runs/routes.ts:44`) and thread it into the factory/terminal/pause call sites (`:200,278,378,501,550`) — so injecting a `mailbox` enqueue port into the agent-run route deps is a clean seam reachable at `index.ts:807`.
- **The workflow-review sender is composed deep inside `ProjectRuntime`, NOT in index.ts.** `postChannel` defaults inside `makeExecutorDeps` (`dag-run-service.ts:370`), whose `DagRunServiceOptions` are built by `ProjectRuntime.dagRunOptions()` (`project-runtime.ts:265`). `ProjectRuntime` holds `channelPort` but NO `channelServer` ref and NO `mailboxService` ref today (verified: `rg "channelServer|mailbox" project-runtime.ts` → only `channelPort`). `postChannel` IS overridable via `opts.postChannel` (`dag-run-service.ts:371`), which is the clean injection seam — but the injected value must come from somewhere `mailboxService` is reachable. This is the highest-friction wiring of the three flows (see §6, §16).
- **The per-CC bridge (`channel-server/server.js`) is the only external `/channel` consumer.** It registers via `/channel-register` and re-emits `channel-event` as `notifications/claude/channel` to its Claude child (verified: `rg "/channel-register|notifications/claude/channel"` → `channel-server/server.js`, plus the server `channel-server.ts`/`index.ts`). Cutting Flow A/B off `emitToSession` does NOT touch this bridge; it stays registered and continues to receive external webhook (Flow C) fan-out unless Flow C is also gated to mailbox — and the worker's `orchestrator-turn` delivers a normal runtime turn (send queue → PTY), NOT a `channel-event` to the bridge. **This is the consumer that cannot trivially move (see §16).**
- **`compat-channel` exists in the contract enum but is unwired** (verified: `MailboxDeliveryChannel = 'ui-inbox'|'orchestrator-turn'|'compat-channel'`, `packages/contracts/src/mailbox.ts`; the worker `fail()`s on it, `mailbox-worker.ts:170`).

Synthesis — this slice re-points three existing senders at the slice-007 mailbox behind a per-flow gate:

```text
sender call site (agent / workflow-review / webhook)
  -> delivery selector (config gate; default = Channel fallback)
       -> mailbox path:  MailboxService.enqueue(address + channel + idempotencyKey)
                            -> MailboxWorker -> orchestrator-turn (send facade) | ui-inbox
       -> channel path:  enqueueAndPush / postChannel / forwardToProjectChildren  (unchanged)
  -> tests (both gate positions) + rollback + stop conditions
```

## 3. Current-State Evidence

| Label | Finding | Evidence |
|---|---|---|
| Verified fact | Agent delivery rides `enqueueAndPush` (inbox + best-effort `emitToSession`) at four sites. | `agent-delivery.ts:71`; `agent-run-factory.ts:1016`; `agent-run-terminal-effects.ts:274`; `pause-resume.ts:181` |
| Verified fact | The three agent envelopes target `pcSessionId = dispatcherSessionId`, `source:'agent'`, with prebuilt bodies. | `buildAgentQueuedStartedBody`/`buildAgentCompletedBody`/`buildAgentFailedBody` (terminal-effects); `buildPauseEventBody` (pause-resume) |
| Verified fact | Workflow review rides an injected `postChannel`; the default loops back through `/channel/:slug/:source` over HTTP. | `dag-run-service.ts:134,370-376`; `orchestrator-review-step.ts:20,31,53` |
| Verified fact | Only `orchestrator-review` posts to Channel; `human-review` only broadcasts the pending event. | `dag-run-service.ts:665-688`; foundation spec §3 |
| Verified fact | Workflow review already emits the durable slice-004 `workflow.review.changed` (pending) fact + legacy `workflow-v2-review-pending`. | `dag-run-service.ts:671-688` |
| Verified fact | External webhook delivery is the `/channel/:slug/:source` listener: allowlist → slug→project → fan-to-all-children + `onEvent`; drops on no registrant. | `channel-server.ts:73-95,228-242`; `index.ts:283` |
| Verified fact | `MailboxService.enqueue` is the additive write-door; caller supplies per-recipient `channel` + a stable `idempotencyKey` (idempotent replay). | `mailbox-service.ts:113`; `repos/mailbox.ts:44,72-88` |
| Verified fact | `MailboxWorker` delivers by channel: `ui-inbox` accept-now; `orchestrator-turn` via the send facade (stable `mb:${deliveryId}`); `compat-channel` unwired (`fail`). | `mailbox-worker.ts:129-171`; `mailbox-orchestrator-turn-adapter.ts:40-58` |
| Verified fact | Worker resolves `orchestrator-session`/`active-orchestrator` for orchestrator-turn; unresolvable → dead-letter (no silent drop). | `mailbox-worker.ts:144-170,185-195` |
| Verified fact | No mailbox-vs-Channel selector/gate exists; `PC_DELIVERY_TRANSPORT` is Channel-internal only. | `agent-delivery.ts:35`; `rg "PC_DELIVERY_TRANSPORT"` → agent-delivery only |
| Verified fact | `mailboxService` is an index.ts singleton (`:465`); agent-run routes already take `channelServer` and thread it to the factory/terminal/pause sites. | `index.ts:465,807`; `features/agent-runs/routes.ts:44,200,278,378,501,550` |
| Verified fact | The workflow `postChannel` default is composed in `ProjectRuntime` (no `channelServer`/`mailbox` ref); `opts.postChannel` is the override seam. | `project-runtime.ts:265-280`; `dag-run-service.ts:371` |
| Verified fact | The per-CC bridge is the only external `/channel` consumer; cutting Flow A/B off `emitToSession` doesn't touch it, but a mailbox orchestrator-turn delivers a send-queue turn, not a `channel-event`. | `channel-server/server.js:64,75`; `mailbox-worker.ts:149-164` |
| Verified fact | `compat-channel` is in the enum but unwired. | `contracts/src/mailbox.ts`; `mailbox-worker.ts:169-170` |
| Verified fact | Slice 007 explicitly deferred the per-flow fallback flag + the sender cutover to slice 008; `compat-channel` "reserved for the slice-008 cutover". | `build-slices/007-mailbox-platform.md` §4 non-goals, §16 |

## 4. Exact Scope

Implement only these behaviors when the user asks to build. Each flow gets: (a) a mailbox enqueue mapping, (b) a delivery-selector gate, (c) tests in both gate positions.

1. **Delivery selector / gating switch (the slice's spine).** Add a small server-owned selector that, per flow, chooses mailbox vs Channel. Recommended shape (recommendation):
   - One config key per flow, read once at boot from env (mirrors `readTransportMode()` in `agent-delivery.ts:35`): `PC_DELIVERY_AGENT`, `PC_DELIVERY_WORKFLOW_REVIEW`, `PC_DELIVERY_WEBHOOK`, each `'channel' | 'mailbox'`, **default `'channel'`**. A single env helper (`apps/server/src/services/delivery-routing.ts`, NEW) returns the resolved mode per flow; the call sites branch on it. Keep it a pure, injectable resolver (deps seam) so tests can flip it without env.
   - **Default semantics (recommendation):** absent/unknown value ⟹ `'channel'` (the current behavior). A fresh checkout, and any deploy that doesn't set the keys, behaves EXACTLY as today. Flipping to `'mailbox'` is opt-in and per-flow, so the three flows can be cut over and verified independently and rolled back independently.
   - **No dual-delivery by default (recommendation):** the gate selects ONE path so a message is never delivered twice (no double runtime turn, no double inbox push). An optional `'shadow'` mode (enqueue to mailbox AND keep Channel, for observability during verification) MAY be added if the human wants side-by-side comparison — but it is OUT by default and must NOT be the value that ships enabled. If shadow is added, the mailbox enqueue must use a `shadow:`-prefixed idempotency key so it never collides with a real cutover and the worker's orchestrator-turn must be disabled for shadow rows (visibility only) to avoid a duplicate runtime turn. Decide before building (Open Questions).
2. **Flow A — Agent delivery cutover.** Inject a `mailbox` enqueue port into the agent-run route deps (`features/agent-runs/routes.ts`) and the three call sites (`agent-run-factory.ts`, `agent-run-terminal-effects.ts`, `pause-resume.ts`). When the gate = `'mailbox'`, replace the `enqueueAndPush(channelServer, …)` call with `MailboxService.enqueue`:
   - Recipient address: `{ kind:'orchestrator-session', projectId, sessionId: dispatcherSessionId }`; delivery `channel:'orchestrator-turn'` (the dispatcher is an orchestrator session; the body is the existing prebuilt string, delivered as a runtime turn through the send facade).
   - Message kind: `agent-terminal` (completed/failed + queued-started) / `agent-question` (asks) / `agent-approval` (approval) per the contract `MailboxMessageKind`.
   - Idempotency key: stable per event so a retried/replayed emit is a no-op — recommend `agent:${runId}:${eventKind}` for terminal/queued-started and `agent-ask:${pendingAskId}` for asks.
   - When the gate = `'channel'`, the existing `enqueueAndPush` call is unchanged.
   - **Pause-resume nuance (recommendation):** the pause flow's durable STATE (`pending_asks` + the slice-005 `agent.run.changed` paused fact) is owned by slice 005 and is NOT moved — only the DELIVERY of the `agent-asks-*` envelope is gated. Keep `entry.run.markPaused` and the `pending_asks` write exactly as-is; gate only the `enqueueAndPush` body delivery. (Verified: slice 005 explicitly kept `enqueueAndPush` as the post-commit delivery step, deferring its cutover here.)
3. **Flow B — Workflow review delivery cutover.** Provide an `opts.postChannel` override (or a sibling `opts.deliverReview` seam) for the DAG executor that, when the gate = `'mailbox'`, enqueues a mailbox `workflow-review` message instead of POSTing to `/channel`:
   - Recipient address + channel: for `orchestrator-review`, `{ kind:'active-orchestrator', projectId }` + `channel:'orchestrator-turn'` (the review prompt becomes a runtime turn the orchestrator answers via `pc_complete_node`, identical to today's Channel body). Optionally also create/link a durable `pending_interactions` `workflow-orchestrator-review` row via `PendingInteractionService` so the review is inspectable (recommendation; the slice-004 `workflow.review.changed` fact already exists — do NOT duplicate it; the mailbox interaction is the actionable reference, the slice-004 fact is the run-state projection).
   - Idempotency key: `workflow-review:${runId}:${nodeId}` (stable per node).
   - The slice-004 durable `workflow.review.changed` (pending) fact + the legacy `workflow-v2-review-pending` broadcast are UNCHANGED in both gate positions (they are state facts, not the Channel delivery).
   - When the gate = `'channel'`, the existing `postChannel` default is unchanged.
   - **`human-review` (recommendation):** unchanged this slice — it does not post to Channel today. The mailbox-backed `human-review` UI inbox action is a follow-on; the foundation spec (§2, §7) says `human-review` must be inbox-backed or rejected, and the slice-007 UI inbox exists, but wiring the workflow `human-review` SENDER to a `ui-inbox` mailbox message is OPTIONAL here and should be confirmed before building (Open Questions). Do not silently convert it to a best-effort chat prompt.
4. **Flow C — External webhook delivery cutover.** When the gate = `'mailbox'`, the `/channel/:slug/:source` handler enqueues a mailbox `external-webhook` message instead of (or in addition to, if shadow) `forwardToProjectChildren`:
   - Recipient address + channel by policy (spec §7): default `{ kind:'project-inbox', projectId }` + `channel:'ui-inbox'` (durable, no silent drop — the spec's headline requirement for webhooks). An explicit policy MAY target `active-orchestrator` + `orchestrator-turn`; keep the default the durable inbox so a missing runtime never drops the event.
   - Idempotency key: an external-event id if the sender provides one, else a content+timestamp hash — recommend `webhook:${slug}:${source}:${hash(body)}:${at}` (the existing `/channel` body has no event id; document the dedup window as best-effort).
   - When the gate = `'channel'`, the existing fan-to-all-children + `onEvent` UI broadcast is unchanged.
   - **Keep the `channel-event` UI broadcast in both positions (recommendation):** the `onEvent` → `channel-event` WS broadcast is the UI's current view of webhook traffic. The mailbox path's canonical `mailbox.message.changed` fact is the NEW view (the web inbox). Until slice 011 removes `channel-event`, emit the UI broadcast in the mailbox position too (visibility parity) — but do NOT fan to the per-CC bridge children when gated to mailbox (that is the delivery that moved).
5. **Live events / fanout.** No new live-event family — the slice-007 `mailbox.message.changed` / `mailbox.delivery.changed` facts already cover the mailbox path; the slice-004 `workflow.review.changed` covers review state. No `/api/live-events` route change (contract-driven, verified slice 007 §3). Fan out the mailbox enqueue publication exactly as `registerMailboxRoutes` / `mailbox-worker` already do (after commit; project-bound → `broadcastTo`, project-less → `broadcastAll`).
6. **Wiring.** Thread the singleton `mailboxService` (+ the selector resolver) to:
   - the agent-run route deps (clean — `index.ts:807`);
   - the boot-reconcile / liveness-sweep / host-reconcile agent-terminal emitters (`index.ts:359,393,427`) which run BEFORE `mailboxService` is constructed and pass `channelServer` directly — these need either a forward-declared mailbox ref or to be moved after the service is built, or to stay on Channel even when the gate is mailbox (acceptable: boot/sweep terminal notices are recovery-path, low-volume — confirm). (verified ordering risk — see §16);
   - the `ProjectRuntime` DAG options for Flow B (the friction point — `project-runtime.ts` must gain an injected review-delivery seam without absorbing runtime-host concerns reserved for slice 009).
7. Run the listed automated verification (both gate positions per flow).

Non-goals (explicitly OUT — and which slice owns each):

- **DELETING Channel / `agent_inbox` / the `/channel/*` routes / `enqueueAndPush` / `postChannel` / `emitToSession` / `forwardToProjectChildren` / `/channel-register` / `channel-event` / the per-CC bridge / old event shapes — slice 011.** This slice keeps every Channel path in place as a gated fallback. Do NOT remove, deprecate, or stop registering any of them. Do NOT remove the `agent_inbox` table or its drain (`drainPendingForSession`, `index.ts:290`).
- **Wiring the `compat-channel` delivery channel — NOT this slice.** `compat-channel` stays unwired. The cutover routes to `ui-inbox`/`orchestrator-turn`, not back through Channel via a mailbox delivery. (If a flow truly needs Channel-as-mailbox-delivery, STOP and confirm — that would be the slice-011 bridge, not 008.)
- **Runtime-host split incl. the host-resume defect — slice 009.** Do NOT change `ProjectRuntime` runtime/PTY/host behavior, the agent-host protocol, reattach, the JSONL tailer, or worktree/path-guard logic. Flow B's wiring must add ONLY an injected review-delivery seam to `ProjectRuntime`/`DagRunServiceOptions` — no runtime-host refactor. The deferred host-resume defect is NOT addressed here.
- **MCP typed client / capability registry — slice 010.** Do NOT change `pc_answer_pending` / `pc_complete_node` / `pc_ask_*` tool names, payloads, or route them through the mailbox.
- **Slice-004 workflow-run boot-reconcile gap — NOT addressed here.** `reconcileWorkflowRunsOnBoot` being unwired (deferred-defects note) is a slice-004 fix, not in 008 scope.
- **Agent `pending_asks` → `pending_interactions` convergence — deferred.** Do NOT migrate/mirror `pending_asks`. Flow A's pending-ask STATE stays on `pending_asks`; only the DELIVERY is gated.
- **Changing the slice-006 `enqueueRuntimeTurn` signature** — the orchestrator-turn worker adapter already wraps the sync facade; do NOT widen it.
- **Adding a DB migration / altering any table.** Slice 007 added every mailbox/interaction table. This slice adds NONE.
- **Dual-delivery as the default** — the gate selects one path. (Optional `shadow` mode is opt-in only; see §4.1.)
- Do NOT restart or kill dev servers while implementing or verifying.

## 5. Contract Plan

Files likely affected:

```text
packages/contracts/src/mailbox.ts            (NO change expected — the kinds/addresses/channels already exist; verify only)
packages/contracts/src/index.ts              (NO change expected)
```

- **No new contracts expected (verified).** `MailboxMessageKind` already includes `agent-question`/`agent-approval`/`agent-terminal`/`workflow-review`/`external-webhook`; `MailboxAddress` already includes `orchestrator-session`/`active-orchestrator`/`project-inbox`; `MailboxDeliveryChannel` already includes `orchestrator-turn`/`ui-inbox`. The cutover MAPS the three flows onto these existing contracts; it does not add a kind, address, or channel.
- If a flow needs a kind/address not in the enum (it should not), STOP and confirm — adding to the contract enum touches slice-007 surfaces and warrants review.
- The gate config key strings are server-local config, NOT a browser contract — keep them in the server `delivery-routing.ts`, not `@pc/contracts`.

## 6. App-Service / Route / Wiring Plan

Files likely affected:

```text
apps/server/src/services/delivery-routing.ts            (NEW — per-flow selector resolver; mirrors readTransportMode)
apps/server/src/services/agent-delivery.ts              (add a mailbox-or-channel branch helper; keep enqueueAndPush intact)
apps/server/src/services/agent-run-factory.ts           (queued-started: gated enqueue)
apps/server/src/services/agent-run-terminal-effects.ts  (completed/failed: gated enqueue)
apps/server/src/services/pause-resume.ts                (asks: gate the DELIVERY only; state unchanged)
apps/server/src/features/agent-runs/routes.ts           (inject the mailbox enqueue port + selector into deps)
apps/server/src/services/dag-run-service.ts             (Flow B: gated postChannel/deliverReview seam)
apps/server/src/services/orchestrator-review-step.ts    (Flow B legacy step: gated delivery, if still live)
apps/server/src/services/project-runtime.ts             (thread the review-delivery seam into DagRunServiceOptions — minimal, no runtime-host change)
apps/server/src/services/channel-server.ts              (Flow C: gated enqueue in the /channel handler, or via an injected webhook sink)
apps/server/src/index.ts                                (compose: mailboxService + selector into agent routes, ProjectRuntime opts, channel-server deps; handle the boot-order risk)
```

Responsibilities:

| Component | Owns | Must not own |
|---|---|---|
| `delivery-routing.ts` (NEW) | Resolve per-flow mode (`channel`/`mailbox`[/`shadow`]) from config; default `channel`; injectable for tests | Mailbox/Channel mechanics, address mapping |
| Flow A call sites | Branch on the gate; build the `MailboxAddress`/kind/idempotency key; call `MailboxService.enqueue` OR `enqueueAndPush` | Worker/lease policy (the slice-007 worker owns delivery), `pending_asks` state (slice 005 owns it) |
| Flow B seam | Branch on the gate; enqueue a `workflow-review` mailbox message OR `postChannel`; optionally link a `pending_interactions` review row | The slice-004 `workflow.review.changed` fact (unchanged), runtime-host behavior |
| Flow C handler | Branch on the gate; enqueue an `external-webhook` mailbox message OR fan-to-children; keep the `channel-event` UI broadcast | Bridge registration, `/channel-register` |
| index.ts composition | Thread `mailboxService` + selector to all three; resolve the boot-order risk | — |

Boundary purity (verified pattern): `MailboxService`/`PendingInteractionService` already depend on `@pc/contracts`/`@pc/db`/`@pc/domain` only; the server call sites hold the injected service + selector + `broadcast`. No new package dependency.

**The Flow B wiring is the hardest part (verified):** `postChannel` is composed in `ProjectRuntime.dagRunOptions()` which has no `mailboxService` ref. Recommended minimal approach (recommendation): give `ProjectRuntimeOpts` an injected `deliverWorkflowReview?` seam (or a `mailboxEnqueue` port) supplied from `index.ts` where `mailboxService` lives, and have `dagRunOptions()` pass it through to `DagRunServiceOptions.postChannel`/`deliverReview`. This adds ONE injected function to `ProjectRuntime` — it does NOT refactor the runtime/PTY/host surfaces reserved for slice 009. If the minimal seam can't be added without touching runtime-host code, STOP and confirm.

## 7. Gate Semantics (exact)

| Flow | Config key | Values | Default | Mailbox mapping (address + channel + kind) | Channel fallback (unchanged) |
|---|---|---|---|---|---|
| A — Agent delivery | `PC_DELIVERY_AGENT` | `channel` \| `mailbox` | `channel` | `orchestrator-session(projectId, dispatcherSessionId)` + `orchestrator-turn`; kind `agent-terminal`/`agent-question`/`agent-approval`; idem `agent:${runId}:${eventKind}` / `agent-ask:${pendingAskId}` | `enqueueAndPush(channelServer, …)` at the 4 sites |
| B — Workflow review | `PC_DELIVERY_WORKFLOW_REVIEW` | `channel` \| `mailbox` | `channel` | `active-orchestrator(projectId)` + `orchestrator-turn`; kind `workflow-review`; idem `workflow-review:${runId}:${nodeId}`; optional `pending_interactions` `workflow-orchestrator-review` row | `postChannel(body, 'workflow')` → `/channel/:slug/workflow` |
| C — External webhook | `PC_DELIVERY_WEBHOOK` | `channel` \| `mailbox` | `channel` | `project-inbox(projectId)` + `ui-inbox` (durable; no drop); kind `external-webhook`; idem `webhook:${slug}:${source}:${hash}:${at}` | `forwardToProjectChildren` + `onEvent` |

Rules (recommendation):
- The gate is read per-flow; the three flows are independent. A flow at `channel` is byte-for-byte the current behavior.
- The gate selects ONE delivery path (no double delivery). The `channel-event` UI broadcast (Flow C) and the slice-004 `workflow.review.changed` fact (Flow B) are state/visibility surfaces, NOT the gated delivery — they fire in both positions.
- Unknown / missing value ⟹ `channel` (fail-safe to current behavior).
- The mailbox path NEVER touches the per-CC bridge; it delivers a runtime turn (orchestrator-turn) or an inbox item (ui-inbox).

## 8. Identity / Atomicity / Lifecycle

- **Idempotency is the cutover's safety net (verified).** `MailboxService.enqueue` is idempotent by `idempotencyKey` (a replay returns existing rows, `created:false`, writes nothing new). Each flow's stable key (§7) means a retried emit, a sweep re-fire, or a double call enqueues at most one message → at most one delivery → (orchestrator-turn) at most one runtime turn (the worker's `mb:${deliveryId}` clientMessageId enforces the last hop). This is what makes the cutover safe to flip live.
- **No silent drops (verified requirement).** Channel's `forwardToProjectChildren` drops on no registrant; the mailbox `ui-inbox`/`orchestrator-turn` either accepts, retries with backoff, or dead-letters (with audit) — never drops. An unresolvable orchestrator-turn recipient dead-letters (visible in the delivery inspector), not silent. This is the spec §2 webhook requirement and the §7 "no silent drop" rule.
- **Delivery is the slice-007 worker's job; the cutover only enqueues.** The call sites do NOT lease/ack/retry — they enqueue and return. The 1s worker sweep (`index.ts:523`) drains. Acceptance = send-service acceptance (orchestrator-turn) or inbox-visible (ui-inbox), per spec §8.
- **Pause/answer ordering unchanged (Flow A).** The slice-005 pending-ask atomicity (validate-before-flip, phantom-cancel, stale-rev) is untouched; only the `agent-asks-*` body delivery is gated.

## 9. DB

- **Migration needed: NO.** Slice 007 added `pending_interactions` + the five `mailbox_*` tables in `0036_mailbox_platform.sql`. This slice writes to those existing tables via the existing `MailboxService`/`PendingInteractionService`; it adds no table, no column, no migration.
- No existing table is altered. `agent_inbox` / `pending_asks` / `orchestrator_send_queue` are untouched (the agent-delivery Channel fallback still writes `agent_inbox` when gated to `channel`).

## 10. Live Event / WebSocket Compatibility Plan

- No `/api/live-events` route change (contract-driven; verified slice 007 §3). The mailbox path reuses the slice-007 `mailbox.message.changed` / `mailbox.delivery.changed` fanout (project-bound → `broadcastTo`, project-less → `broadcastAll`).
- The legacy `channel-event` (Flow C UI view), `workflow-v2-review-pending` (Flow B), `agent-run-changed` / `agent-jsonl-event` (Flow A adjacent) WS envelopes are UNCHANGED and continue to fire (removal is slice 011).
- The slice-004 `workflow.review.changed` and slice-005 `agent.run.changed` facts are unchanged regardless of gate position.
- Do not fan out a mailbox frame before the enqueue commits (the slice-007 services already commit-then-publish).

## 11. Test Plan

Minimum automated tests, mirroring the slice-002…007 style. Every flow is tested in BOTH gate positions.

| Priority | Test | Purpose |
|---|---|---|
| P0 | `delivery-routing.test.ts` | Selector resolves per-flow mode from config; unknown/missing ⟹ `channel`; the three flows are independent; injectable override works. |
| P0 | Flow A — agent delivery (gate=channel) | The 4 sites still call `enqueueAndPush(channelServer,…)` with the current body/kind/session; `agent_inbox` row written; no mailbox enqueue. |
| P0 | Flow A — agent delivery (gate=mailbox) | Each site calls `MailboxService.enqueue` with `orchestrator-session(dispatcherSessionId)` + `orchestrator-turn` + the stable idempotency key; NO `enqueueAndPush`/`emitToSession`; a re-fire (same key) enqueues no new message; the worker yields exactly one runtime turn (send-queue row) and `accepted` delivery. |
| P0 | Flow B — workflow review (gate=channel) | `orchestrator-review` still `postChannel(body,'workflow')`; the slice-004 `workflow.review.changed` + legacy `workflow-v2-review-pending` still fire; `human-review` still only broadcasts. |
| P0 | Flow B — workflow review (gate=mailbox) | `orchestrator-review` enqueues a `workflow-review` mailbox message (`active-orchestrator` + `orchestrator-turn`, key `workflow-review:${runId}:${nodeId}`) instead of `postChannel`; the slice-004 fact + legacy broadcast STILL fire (unchanged); a re-request (same node) enqueues no duplicate; optional `pending_interactions` review row created. |
| P0 | Flow C — external webhook (gate=channel) | `/channel/:slug/:source` still fans to children + emits `channel-event`; no-registrant still drops (documented current behavior). |
| P0 | Flow C — external webhook (gate=mailbox) | `/channel/:slug/:source` enqueues an `external-webhook` mailbox message (`project-inbox` + `ui-inbox`) — durable, no drop with no registrant; the `channel-event` UI broadcast still fires; the per-CC bridge is NOT fanned to; idempotency key dedups a replayed event. |
| P0 | Channel-still-intact test | With all gates default (`channel`), behavior is byte-identical to pre-slice; `ChannelServer`/`enqueueAndPush`/`postChannel`/`/channel/:slug/:source` all still registered and exercised. |
| P0 | No-double-delivery test | A flow at `mailbox` does NOT also call the Channel path (single delivery); a flow at `channel` does NOT enqueue mailbox. |
| P1 | Rollback test | Flipping a gate from `mailbox` back to `channel` restores the exact Channel path with no residual mailbox enqueue. |

Gate commands (run from repo root; matches slices 002–007):

```powershell
pnpm --filter @pc/contracts test
pnpm --filter @pc/contracts typecheck
pnpm --filter @pc/db test
pnpm --filter @pc/db typecheck
pnpm --filter @pc/app-services test
pnpm --filter @pc/app-services typecheck
pnpm --filter @pc/server test
pnpm --filter @pc/server typecheck
pnpm --filter @pc/web test
pnpm --filter @pc/web typecheck
pnpm typecheck
git diff --check
```

(Note: `pnpm typecheck` excludes `test/**` per the known deferred defect — typecheck new test files manually or rely on `tsx` runtime; avoid `string`→branded-`ULID` casts in tests, build real rows via `createProject`/repos.)

Manual verification after implementation (batched to the human end-of-section pass; flip gates per flow, no dev-process restart by the build agent):

- **Default (all `channel`):** confirm agent completion/ask, workflow orchestrator-review, and external webhook behave exactly as before (Channel push to the orchestrator, `/channel` fan-out).
- **Flow A `mailbox`:** complete a background agent while the orchestrator is busy → confirm exactly ONE queued runtime turn (the completed/failed/queued-started body) arrives, the mailbox delivery is `accepted` with a send-queue `target_ref`, and NO `agent_inbox`/Channel push fired. Pause an agent → confirm the `agent-asks-*` body arrives as one runtime turn; answering still resumes once (slice-005 path intact).
- **Flow B `mailbox`:** run a workflow with an `orchestrator-review` node → confirm the review prompt arrives as one orchestrator runtime turn, `pc_complete_node` still approves/rejects, the review survives refresh/reconnect (slice-004 fact + optional interaction), and NO `/channel` POST fired.
- **Flow C `mailbox`:** POST an external webhook with NO registered child → confirm it lands durably in the project inbox (no drop), the `channel-event` UI broadcast still shows it, and the bridge is not fanned to. With the gate back to `channel`, confirm the old fan-out resumes.
- **Rollback:** flip each gate back to `channel` and confirm the legacy path returns with no duplicate delivery.
- Confirm chat, work-item, agent-run, and Channel-registration behavior is otherwise unchanged.

## 12. Migration Steps

1. Add `delivery-routing.ts` (the per-flow selector, default `channel`) + its test.
2. Flow A: add a gated mailbox-or-channel branch helper in `agent-delivery.ts` (keep `enqueueAndPush` intact); inject the `mailbox` port + selector into the agent-run route deps; gate the 4 call sites; tests in both positions.
3. Flow B: add the injected review-delivery seam to `DagRunServiceOptions`/`ProjectRuntime` (minimal, no runtime-host change); gate `requestReview`/`orchestrator-review-step`; tests in both positions.
4. Flow C: gate the `/channel/:slug/:source` handler (enqueue `external-webhook` mailbox message when `mailbox`); keep the `channel-event` broadcast; tests in both positions.
5. Compose in `index.ts`: thread `mailboxService` + selector to agent routes, `ProjectRuntime` opts, and the channel-server webhook seam; resolve the boot-order risk for the sweep emitters (§6).
6. Run automated verification (both gate positions per flow).
7. Update trackers with implementation notes.

## 13. Rollback Plan

- **The gate IS the rollback (recommendation).** Every flow defaults to `channel`; setting/leaving a key at `channel` restores the exact current behavior with zero code revert. The cutover is reversible at runtime config, per flow.
- The selector + the gated branches are additive: removing the branch (reverting to the unconditional `enqueueAndPush`/`postChannel`/fan-out) fully removes the mailbox path. The slice-007 mailbox platform stays — only the senders revert.
- No DB migration to reverse. No table altered.
- Channel, `agent_inbox`, `/channel/*`, the per-CC bridge, and `compat-channel` are untouched, so disabling the cutover restores nothing (Channel never left).
- If a mailbox path misbehaves under load, flip its key back to `channel` (no restart needed beyond the config reload the human controls).

## 14. Stop Conditions

Stop and return to planning if implementation requires any of the following:

- DELETING or ceasing to register Channel / `agent_inbox` / `/channel/:slug/:source` / `/channel-register` / `channel-event` / `enqueueAndPush` / `postChannel` / `emitToSession` / `forwardToProjectChildren` / the per-CC bridge / any old event shape (slice 011).
- Wiring the `compat-channel` delivery channel, or routing a mailbox delivery back through Channel.
- A default that is anything other than `channel`, or shipping a `shadow`/dual-delivery mode enabled by default.
- Any double-delivery (a flow delivering through BOTH mailbox and Channel for one event in a non-shadow position).
- Adding a DB migration, altering any table, or a backfill.
- Changing `ProjectRuntime` runtime/PTY/host behavior, the agent-host protocol, reattach, the JSONL tailer, transient-session handling, or worktree/path-guard logic (slice 009) beyond adding ONE injected review-delivery seam.
- Touching the deferred host-resume defect or the slice-004 boot-reconcile gap.
- Migrating/mirroring agent `pending_asks` into `pending_interactions`, or changing pause/answer/cancel STATE semantics (slice 005).
- Changing the slice-006 `enqueueRuntimeTurn` signature or the slice-007 worker/adapter.
- Adding/renaming MCP tools or routing `pc_complete_node`/`pc_answer_pending`/`pc_ask_*` through the mailbox (slice 010).
- Converting workflow `human-review` into a best-effort chat prompt instead of an inbox-backed action (spec §2/§7) — confirm the `human-review` decision before building.
- Raw-sending to the PTY (the orchestrator-turn worker rides `enqueueRuntimeTurn`), or restarting/killing dev processes.

## 15. Acceptance Criteria

This slice is ready to implement only when the user explicitly asks to build and these criteria are accepted:

- A per-flow delivery selector exists with config keys `PC_DELIVERY_AGENT` / `PC_DELIVERY_WORKFLOW_REVIEW` / `PC_DELIVERY_WEBHOOK` (`channel`|`mailbox`), each defaulting to `channel`; unknown/missing ⟹ `channel`; the three flows are independent and independently reversible.
- Flow A (agent completed/failed/queued-started/asks): when gated `mailbox`, the four call sites enqueue through `MailboxService.enqueue` (`orchestrator-session` + `orchestrator-turn`, stable idempotency keys) and the slice-007 worker delivers exactly one runtime turn per event; when gated `channel`, `enqueueAndPush` is unchanged; the slice-005 pending-ask state is untouched.
- Flow B (workflow orchestrator-review): when gated `mailbox`, `requestReview`/the review step enqueue a `workflow-review` mailbox message instead of `postChannel`; the slice-004 `workflow.review.changed` fact + legacy `workflow-v2-review-pending` fire in both positions; `human-review` behavior is unchanged (or inbox-backed, if confirmed); when gated `channel`, `postChannel` is unchanged.
- Flow C (external webhook): when gated `mailbox`, `/channel/:slug/:source` enqueues a durable `external-webhook` mailbox message (no silent drop on missing registrant) and still emits the `channel-event` UI broadcast; the per-CC bridge is not fanned to in the mailbox position; when gated `channel`, the fan-out is unchanged.
- No DB migration; no table altered; the slice-007 mailbox platform and the Channel platform both remain in place.
- Idempotency keys make every flow safe to flip live (at-most-one delivery per event); no double delivery in any non-shadow position.
- Tests cover the selector, all three flows in both gate positions, channel-still-intact at default, no-double-delivery, and rollback.
- Channel deletion, runtime-host split (incl. host-resume defect), the slice-004 boot-reconcile gap, MCP, and `compat-channel` wiring remain untouched except for unaffected typecheck/test fallout.
- Tracker marks this build-slice artifact `planned`.

## 16. Open Questions

| Question | Status |
|---|---|
| Gate granularity: three per-flow keys, or one `PC_DELIVERY_MODE` with per-flow overrides? | Recommended: three independent per-flow keys (default `channel`) so cutover/rollback is per-flow. Confirm before building. |
| Should a `shadow` mode (enqueue mailbox AND keep Channel, for side-by-side verification) ship? | Default: NO. If wanted, it must use a `shadow:`-prefixed idempotency key and disable the orchestrator-turn worker for shadow rows (visibility only, no duplicate runtime turn). Confirm. |
| Flow B `human-review` sender: leave unchanged, or wire it to a `ui-inbox` mailbox message this slice? | Recommended: leave unchanged this slice (it doesn't post to Channel today); the slice-007 UI inbox exists but wiring the workflow `human-review` SENDER is optional. The spec forbids a best-effort chat fallback. Confirm. |
| Flow B: also create a durable `pending_interactions` `workflow-orchestrator-review` row, or rely on the slice-004 `workflow.review.changed` fact alone? | Recommended: create the interaction row (actionable reference) AND keep the slice-004 fact (run-state projection); don't duplicate the fact. Confirm. |
| Boot-order: the agent boot-reconcile / liveness / host-reconcile terminal emitters run before `mailboxService` is constructed and pass `channelServer` directly. | Recommended: either forward-declare the mailbox ref / move the service construction earlier, OR keep those recovery-path terminal notices on Channel even when gated `mailbox` (low-volume, recovery-only). Verified ordering risk — decide before building. |
| Flow C idempotency: external `/channel` bodies carry no event id. | Recommended: best-effort `webhook:${slug}:${source}:${hash}:${at}` dedup window; document it's not exactly-once for webhooks. Confirm. |
| Per-CC bridge consumer: a mailbox orchestrator-turn delivers a send-queue runtime turn, NOT a `channel-event` to the bridge. Is that acceptable for the flows being cut over? | Verified non-trivial move: for Flow A/B the orchestrator receives the message as a normal runtime turn (the desired target behavior); the bridge stays for any flow left on `channel` and for slice-011 cleanup. Confirm the orchestrator UX is equivalent during human review. |

## 17. Notes for the Implementation Agent

- **Do NOT build a new delivery primitive.** The slice-007 `MailboxService.enqueue` + `MailboxWorker` + `MailboxOrchestratorTurnAdapter` already do lease/ack/retry/dead-letter and the orchestrator-turn-over-send-facade. This slice only re-points senders at `MailboxService.enqueue` behind a gate and maps each flow to an existing `MailboxAddress`/`MailboxDeliveryChannel`/`MailboxMessageKind`.
- **The gate default is `channel` — load-bearing.** A fresh checkout and any unset deploy must behave EXACTLY as today. Mirror `readTransportMode()` (`agent-delivery.ts:35`) for the env-read shape; keep the resolver injectable so tests don't depend on env.
- **Idempotency keys are the cutover's safety net.** Use a stable per-event key (§7) so re-fires, sweeps, and double-calls enqueue at most once. Combined with the worker's `mb:${deliveryId}` clientMessageId, an orchestrator-turn flow yields at most one runtime turn. Get the keys right before flipping any gate.
- **Flow B is the wiring friction.** `postChannel` is composed in `ProjectRuntime.dagRunOptions()` (`project-runtime.ts:265`), which has no `mailboxService` ref. Add ONE injected review-delivery seam from `index.ts` (where `mailboxService` lives) through `ProjectRuntimeOpts` → `DagRunServiceOptions`. Do NOT absorb runtime-host concerns (slice 009). If you can't add the seam without touching runtime/PTY/host code, STOP.
- **Flow A boot-order risk:** the boot-reconcile/liveness/host-reconcile terminal emitters (`index.ts:359,393,427`) run before `mailboxService` (`:465`) and pass `channelServer` directly. Decide per §16 (forward-declare, reorder, or keep recovery-path notices on Channel). Don't blindly inject a ref that isn't constructed yet.
- **Keep state/visibility surfaces in both gate positions:** the slice-004 `workflow.review.changed` fact (Flow B) and the `channel-event` UI broadcast (Flow C) are NOT the gated delivery — they fire regardless of gate. Only the Channel DELIVERY (`emitToSession`/`postChannel`/`forwardToProjectChildren`) is gated.
- **Channel stays.** Do NOT delete, deprecate, or stop registering any Channel path, `agent_inbox`, or the per-CC bridge. Do NOT wire `compat-channel`. Removal is slice 011.
- **No migration.** Slice 007 added every table; this slice writes to them via the existing services.
- The slice-004 workflow-run boot-reconcile gap and the slice-009 host-resume defect are NOT in scope — do not pull them in.
- `pnpm typecheck` excludes `test/**` (known deferred defect) — new test files won't be type-checked by the build gate; rely on `tsx` runtime + a manual test-file typecheck, and avoid `string`→branded-`ULID` casts in tests.
- Do not use `archive/` as evidence or a source for tests.
