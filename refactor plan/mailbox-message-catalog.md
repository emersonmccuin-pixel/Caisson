# Mailbox Message Catalog

Decision Q1 (2026-05-31): the mailbox is **one universal durable feed**. Every
message is catalogued with a `kind` + typed recipient address + delivery channel.
Route everything to one inbox now; later **filter/subscribe by `kind`** to
dedicated UI surfaces. Pure UI-layer routing on the durable catalog — **no schema
change**. This doc enumerates every `kind` and its eventual UI home.

Source of truth: `packages/contracts/src/mailbox.ts`
(`MAILBOX_MESSAGE_KINDS`, `MAILBOX_DELIVERY_CHANNELS`, `MailboxAddress`).

## Delivery channels (how a message is delivered)
- `ui-inbox` — rendered in the in-app inbox (worker accepts immediately).
- `orchestrator-turn` — injected as one runtime turn via the slice-006 send
  facade (`enqueueRuntimeTurn`, never raw-send; stable `mb:${deliveryId}` key).
- `compat-channel` — reserved/unwired (legacy Channel bridge; retired in 011).

## Address kinds (who receives it)
`user-inbox` (global, `projectId:null` allowed) · `project-inbox` ·
`active-orchestrator` · `orchestrator-session` · `agent-run` · `workflow-review`.
Invariant: global ⟺ `projectId IS NULL`.

## The 7 message kinds

| kind | Producer (cutover site) | Channel · Address | UI home TODAY | Eventual UI home |
|---|---|---|---|---|
| `agent-question` | agent asks orchestrator/user — `pause-resume.ts` (Flow A) | orchestrator-turn · orchestrator-session | orchestrator chat turn | **Waiting-on-you** surface (Q2) |
| `agent-approval` | agent approval-request — `pause-resume.ts` (Flow A) | orchestrator-turn · orchestrator-session | orchestrator chat turn | **Approvals/Review** surface (Q2) |
| `agent-terminal` | agent completed/failed — factory / terminal-effects (Flow A) | orchestrator-turn · orchestrator-session | orchestrator chat turn | run-activity feed (or stays a turn) |
| `workflow-review` | orchestrator-review node — `dag-run-service.ts` (Flow B) | orchestrator-turn · active-orchestrator | orchestrator chat turn | dedicated **Review** surface |
| `external-webhook` | `/channel/:slug/:source` listener (Flow C) | ui-inbox · project-inbox (+ user-inbox) | Activity-rail inbox | project **event feed** / inbox |
| `runtime-hook-ask` | `/api/ask` ask-shadow — `ask-shadow.ts` | (shadow; not delivered) | none (shadow only) | **Waiting-on-you** authority (Q2) |
| `system-notice` | generic notices | ui-inbox · user-inbox/project-inbox | Activity-rail inbox | notifications / inbox |

## What this catalog exposes (review findings, 2026-05-31)
- **`agent-terminal` was NOT arriving via mailbox** under `gate=mailbox` — the
  always-on host completion path bypassed the gate to Channel. Fixed in
  `e22456d2` (host path now threads the delivery gate; regression test added).
- **`runtime-hook-ask` is a SHADOW only** — the in-memory `/api/ask` resolver is
  still authoritative; the `pending_interactions` row is inspectable but not the
  answer source. Making it the authority + retiring the "Waiting on you" panel is
  **Q2**, sequenced as its own slice **after** slice 009 (it touches the same
  ask/resume host boundary 009 formalizes).

## Routing principle (now → later)
Today: `agent-*` + `workflow-review` → orchestrator turns; `external-webhook` +
`system-notice` → Activity-rail inbox; `runtime-hook-ask` → shadow. Later, the UI
subscribes by `kind` to route the actionable kinds (`agent-question`,
`agent-approval`, `workflow-review`, `runtime-hook-ask`) to a Waiting-on-you /
Review surface and the informational kinds to a feed — all off the one durable
catalog, no new tables.
