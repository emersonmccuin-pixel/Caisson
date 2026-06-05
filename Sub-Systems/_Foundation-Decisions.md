# Foundation Decisions

> **What this is:** the agreed conceptual decisions for the rebuild, each with its reasoning. This is
> the *law* the rebuild must honor — the spec. It's deliberately separate from:
> - **the subsystem docs** (what's true *today*, as-built), and
> - **`_Emerson's Notes.md`** files (Emerson's in-progress thinking per folder).
>
> A decision lands here only once we've talked it through. Until then it's a **proposal** and can
> change freely.

**Status legend:** 🟡 Proposed (under discussion) · 🟢 Locked (agreed; rebuild must honor) · ⚪ Open (raised, not yet discussed)

---

## FD-1 — Where tools live: catalog in code, selection in the DB

**Status:** 🟢 Locked — 2026-06-03 (Emerson: "we don't need a tool DB")

**The decision (proposed):**
- **Built-in tools** — the *catalog* (each tool's name, description, and inputs) stays defined **in
  code**, as the single source of truth. It is not moved into a database table.
- **Tool selection** — *which* tools a given pod is granted stays **in the database**, per pod (as it
  works today: a `tools` list on the agent row).
- **External tools** (Gmail, Slack, other MCP servers) — configured **in the database, per pod**
  (the existing `agent_mcp_servers` attachment), because their behavior lives on someone else's
  server, not in our code.

**Why:**
- A tool is two parts — a *description* (data) and a *behavior* (code that actually does the thing).
  The behavior **must** be code. So every tool requires code regardless.
- Because code is always required, a database catalog could only ever be *descriptions pointing at
  code that must already exist* — it wouldn't let you add a working tool without a code change.
- Splitting a tool's description (DB) from its behavior (code) creates **two sources of truth that
  can drift** — the exact "poison at the roots" pattern we're trying to eliminate. Keeping them
  together in code makes drift impossible.
- Tool *selection*, by contrast, is genuine configuration ("this agent may do these things") — that
  belongs in the DB, and already is.

**What this means concretely:**
- Adding a new built-in tool = a code change (write its behavior + add its catalog entry together).
- Giving an agent a tool = a data change (edit the pod's tool list) — no deploy.
- The catalog (code) remains the thing that validates a pod's selected tools at launch.
- This is a deliberate **hybrid**: our tools = code catalog; outside tools = DB-configured per pod.
  It half-exists today; the rebuild should make it intentional, not accidental.

**Sub-questions — resolved:**
1. ~~Per-customer / per-deploy tool toggling?~~ **No.** Confirmed not needed (local-first,
   single-user). This was the only thing that argued for a DB catalog — so catalog-in-code stands.
   (And note: turning tools on/off *per agent* is already a data change via the pod's tool list — no
   code release needed for that.)
2. **Reverse drift (a pod lists a tool that no longer exists in code):** default rule —
   **drop-it-and-warn at launch** (one stale entry must never brick a working agent) **+ flag it
   loudly at edit/save time** so it's caught immediately. Revisit only if this proves too quiet.
3. **External tool servers (Gmail/Slack/etc.):** **not a near-term priority** — built-in tools only
   for now. But *design the seam* so an external server can register its tool list cleanly later
   (cheap to leave room for, expensive to retrofit). No integrations built until asked.

---

## FD-2 — One shared tools server vs. one messenger per agent

**Status:** 🟢 Locked — spike PASSED 6/6, 2026-06-03 — **one shared HTTP tools server wins**

> **Spike verdict (2026-06-03, CC 2.1.162, harness `labs/fd2-shared-http-mcp/`):** three live
> claude.exe sessions against ONE Streamable-HTTP MCP server — all six criteria green:
> - **Identity ✅ (the make-or-break):** per-session `.mcp.json` carries
>   `{"type":"http","url":…,"headers":{"X-PC-…":…}}`; CC sends the headers on EVERY tool call and
>   the SDK hands them to the handler (`extra.requestInfo.headers`). Zero cross-talk across A/B/C.
> - **Turn-1 tools ✅:** all three clients called tools on turn 1, no warmup — CC 2.1.162 adds MCP
>   tools mid-turn via `deferred_tools_delta`, so the historical "no tools on turn 1" race is gone
>   over HTTP.
> - **Concurrency ✅:** three server-side 2s calls ran overlapped, distinct MCP sessions per client.
> - **Restart ✅:** server killed + restarted mid-session → answering `404` + JSON-RPC `-32001`
>   ("Session not found") makes CC re-initialize and call again within ~5s, hands-off. (Quirk: CC
>   opens TWO fresh MCP sessions on reconnect — one re-lists tools, one carries the call. Harmless;
>   don't key server state on "one session per claude".)
> - **Bonus catch:** the spike exposed that PC's `encodeCwdForClaude` kept `.`/`_` while CC 2.1.162
>   replaces ALL non-alphanumerics (CC src `sessionStoragePortable.ts:311`) — the blind-tailer
>   stall class waiting to fire on any dotted workspace path. Fixed same day (one copy, in
>   `path-resolver.ts`).
> - **Adoption path:** rides Step 4 / P6 (orchestrator → Engine) — sessions move to the shared
>   endpoint as they move to the Engine. North-star doc amended. Re-run the harness on every FD-22
>   CC version bump (it IS the quirk-surface test for the tools transport).

**The idea (Emerson):** instead of every Claude process getting its own little tools-messenger,
have **one shared PC-RIG tools server** that all Claude processes connect to.

**The target this points at:** fold today's thin per-session messenger into the Brain as **one
always-on tools endpoint.** Every tool call already funnels to the one Brain over HTTP anyway — the
per-session messenger is just a stateless relay in front of it. Removing it deletes one process per
agent and a recurring "agent sees no tools on turn 1" timing bug.

**⚠️ The transport wrinkle (why this isn't free):**
- A *shared* server that many Claude processes connect to **must be served over HTTP (a URL)** — not
  stdio. **stdio can't be shared:** it's a private pipe between one parent (a Claude process) and one
  child, so it's inherently one-per-agent. "One server over stdio that everyone connects to" isn't
  possible; "one server over HTTP that everyone connects to" is.
- So the real question is: **does `claude.exe` reliably use an HTTP tools server?** This codebase has
  been burned repeatedly by Claude Code's quirks, so we do NOT assume it works — we test it.

**The spike (de-risk before committing):**
- Point a Claude process at a single HTTP PC-RIG endpoint (instead of spawning the stdio child) and
  confirm it connects and lists all tools.
- **Identity:** prove the shared server can tell *which* agent/run/project is calling (today identity
  is stamped into each per-agent messenger at spawn; over a shared HTTP server it must arrive some
  other way — a header, or a per-session token/path). This is the make-or-break item.
- **Timing:** check whether the 1–3s tool-registration lag disappears with an always-on server.
- **Concurrency:** several agents on the one endpoint at once — no cross-talk, no collisions.
- **Resilience:** Brain restarts — connected agents recover at least as well as today.
- **Success =** unambiguous per-call identity + reliable/fast tool registration + clean concurrency +
  survives a restart.

**Note:** the current north-star doc says "keep the per-session MCP child" — but it says that for
*ownership* reasons, not efficiency. This FD is a deliberate challenge to that on efficiency grounds;
if the spike succeeds, the north-star note gets updated.

**Scope note (2026-06-03):** the per-orchestrator *channel child* was briefly in scope here; its
fate is now decided independently by **FD-3** (it dies, regardless of this spike's outcome). FD-2's
spike is solely about the **tools** transport.

---

## FD-3 — The channel notification system dies entirely; the mailbox is the ONE notify door

**Status:** ✅ **EXECUTED — 2026-06-03** (locked same day; Emerson: "entirely dead and no piece of it must survive")

> **Demolition shipped:** channel-server package · `ChannelServer` service (:8788) · the
> `--dangerously-*` flag + auto-confirm regex (both spawn paths) · `channel-event` UI bypass ·
> `/channel-send` route · webhook mcp.json entry · the referenced-tools config filter · all port
> plumbing (dev-supervisor, restart-stack, desktop port guard, stage-resources). Verified: workspace
> typecheck + all suites green · live acceptance (fire → agent delivers on new spawn path → gate →
> approve → completed) · mailbox notification confirmed · :8788 connection-refused.
> The legacy-cleanup service intentionally keeps its channel references — it *removes* old channel
> files from user projects. The no-bypass-gate resurrection detector still guards against revival.

**The decision:**
- The **entire channel notification path is removed** in the rebuild. Nothing survives:
  - the per-orchestrator channel child (`channel-server/server.js` and its `.mcp.json` entry),
  - the `--dangerously-load-development-channels` spawn flag and the regex-matched auto-confirm of
    Claude's dev-channel boot prompt,
  - channel MCP push notifications into the orchestrator,
  - the `channel-event` direct-to-UI broadcast (the relay bypass),
  - and the config-filtering machinery that existed only to keep the webhook server entry from
    knocking out dispatched agents' tools.
- **All notifications to the orchestrator flow through the durable mailbox**, delivered by injecting
  a turn into the orchestrator's PTY (the existing mailbox → orchestrator-turn path becomes the only
  path).

**Requirements on injected notifications (Emerson, part of the decision):**
1. **Clearly labeled as system messages** in the injected text itself — the orchestrator (and anyone
   reading the transcript) can always tell a system notification from a human message. Never
   ambiguous.
2. **Tagged with a machine-readable source/kind end-to-end** (send-queue row → transcript → live
   events), so the frontend chat can **filter them out** (e.g. a "hide system messages" toggle).
   *(Partial support exists: runtime turns already carry a `source` field in the send-queue contract
   — the rebuild must carry that tag all the way through to the chat renderer.)*

**Why:**
- The channel path was a production feature standing on a **dev-mode escape hatch**: a
  `--dangerously-*` flag, an auto-confirmed boot prompt matched by regex (already broke once when CC
  changed banner rendering), and defensive filtering in the agent spawn path to contain it.
- It was also a **second notify door** beside the mailbox — the exact dual-path pattern this rebuild
  exists to kill. The mailbox does the same job durably, with zero claude.exe-quirk dependencies.

**Boundary question — resolved (Emerson, 2026-06-03): no outside hooks at all.** Inbound
external-webhook ingestion is **dropped entirely** — the rebuild has no webhook endpoint, no
channel server process, nothing. The channel system is 100% dead including its front door. If a
real integration ever needs inbound events, it comes back as a plain mailbox writer (one HTTP
endpoint that enqueues a mailbox message) — trivial to add when actually needed.

---

## FD-4 — Agent scope: one three-tier field; `origin` dies

**Status:** 🟢 Locked — 2026-06-03 (from `2-brain/Emerson's Notes.md` discussion)

**The decision:**
- Scope becomes **one field with three values**:
  - **`built-in`** — ships with the app, available everywhere. Protected: can't be deleted, receives
    auto-updates unless customized (the existing drift/trust model keys off this value).
  - **`global`** — appears in every project's **"Add agent" picker**, but is *not* usable in a project
    until explicitly added. Not orchestrator-callable anywhere it hasn't been added.
  - **`project`** — lives in one project. **Promote to global** makes it *available* to other projects
    via the picker; the project-scoped original remains where it is.
- The separate **`origin` field is deleted** — "is this built-in?" *is* now a scope value, not a
  second axis to mentally combine with the first.

**Why:** today's behavior is already approximately this, but expressed as two fields (`scope` +
`origin`) whose combinations the reader must decode. One field, three values, no decoding.

**Deferred design (intent locked, mechanism later):** per-project *adjustment of a built-in* — tweak a
built-in agent for one project's specifics, with a visible "customized for this project" indicator.
The DB is already shaped for this overlay (Section 17c); the layering gets designed as its own small
piece, not in this pass.

---

## FD-5 — Assignment-level settings move to the Work Contract

**Status:** 🟢 Locked — 2026-06-03 · **✅ DELIVERED in M5 (2026-06-04, as amended below;
scope + evidence: `refactor plan/m5-work-contract-scope-2026-06-04.md`)**

**The decision:**
- **`expected_output` and `output_destination` come off the pod.** Both describe *an assignment*
  ("what does this job produce, where does the result go"), not *an agent*. The **Work Contract**
  owns them — set at dispatch, per job.
- **The deliverable result lives on the Work Contract** (absorbs the former backlog item). The work
  item's `body` goes back to being the human description only — kills the "result stored in two
  places" split (`work_items.body` doing double duty as `$root.output`).

**Why:** Emerson's instinct ("this should always be set at agent dispatch, no?") is exactly right —
pod-level defaults for job-level facts is how dispatch-time settings get silently overridden or
conflict. The contract becomes the *complete* job spec: what to produce, where it goes, who reviews it.

**Guard:** the `work_items.body` ↔ `$root.output` coupling is load-bearing today — the migration
needs the round-trip guard test the ledger already calls for before that write moves.

**Addendum (2026-06-03, from the dispatch-payload audit):** "the contract is the complete job spec"
must hold **from the agent's side too** — the agent must be able to **read its own contract during
the run, including the acceptance criteria** it will be verified against (today only the
expected-output spec is inlined once; the verification predicates are invisible, so an agent can't
self-check before submitting). Concretely: a contract-read tool (or equivalent) in the dispatched
agent's baseline set, carrying expected output + acceptance criteria. The companion gap — work-item
**attachments unreachable by tool** — is logged in the audit backlog as a baseline-tools rebuild
requirement.

**Amendments (2026-06-04, M5 trace+refute — Emerson confirmed):**
- **`output_destination` is DELETED, not moved.** Refute showed it is a dead knob: stored,
  editable, seeded — consumed by **zero** runtime code (results route via terminal envelope →
  orchestrator relay; prose placement is `expectedOutput.store`). Migrating it would carry rot
  onto the contract. If a "send results to X" feature is wanted later, it gets designed on the
  contract in M6 as a working feature.
- **Pod-level `expected_output` survives as an explicit DEFAULT** (dispatch always wins; contract
  row is the per-run authority — that half of the migration shipped pre-M5). Custom pods are job
  templates in practice; killing the default would force every dispatch to restate the spec. The
  "silently overridden" risk this FD feared is structurally gone (explicit precedence chain).
- Scope + evidence: `refactor plan/m5-work-contract-scope-2026-06-04.md`.

**Delivered (M5, 2026-06-04):** body = brief-only LAW (☠ `store: work_item_body`; `$root.output`
now guaranteed to read the brief — its documented meaning; round-trip guard test pins it) ·
`output_destination` deleted whole (migration 0042) · addendum delivered: `pc_get_contract`
(acceptance criteria readable mid-run; dispatch door now derives AC onto the contract row at mint)
+ `pc_list_attachments`/`pc_get_attachment` (the audit's 🔴 closed) — all three in the required
worker set. Live-fire: an agent read its contract + AC, fetched a secret-word attachment, and
delivered; verification passed.

**M5 finding, still open (→ M6/contract work):** an ad-hoc `pc_invoke_agent` dispatch with NO
`expected_output` mints a contract with a NULL spec — `resolveContractForDispatch` does not
consult the pod default or the stock map (only `createAgentWorkItem` does). The contract isn't
"the complete job spec" on that path. Wiring the fallback in changes Decision-4 behavior (e.g. a
spec-less code-writer dispatch would start requiring a work item), so it's a deliberate pass, not
a patch.

---

## FD-6 — One ask door: agents only ask the orchestrator

**Status:** ✅ Executed — M7, 2026-06-04 (scope: `refactor plan/m7-ask-door-scope-2026-06-04.md`)

**Delivered:** `pc_ask_user` ☠ deleted whole (registry · tier map · MCP handler case · route
rejects `kind:'user'` · `PendingAskKind`/`AgentInboxEventKind`/`PENDING_INTERACTION_KINDS`
narrowed · `agent-asks-user` event + payload + wire types dead · web rendering gone · 4 names in
banned-resurrection). `pc_ask_orchestrator` is THE door and **inherited the multi-choice
`options` array**. Required set 7→6 (baseline audit done — see Audit backlog). 7 stock-pod
grants + prompts re-aimed ("if only the human can decide, say so — the orchestrator takes it to
them"); orchestrator triage protocol rewritten; boot sweep `agent-tools-scrub.ts` scrubs stored
rows the stock reseed can't reach (project copies + custom pods). Live-verified: agent asked
through the one door w/ options → `kind:'orchestrator'` row → pause → answer accepted
(`answeredBy:'user'`) → respawn. **Live-fire CAUGHT a pre-existing Engine bug (2/2 repro, not
M7's): the resume's answer send is eaten by the `--resume` replay repaint (echo-ack passes, no
JSONL user row, empty composer, run wedged 'running') + the pre-pause claude.exe never exits
(code assumed "CC exits cleanly when paused" — it doesn't), leaving two processes on one
session. The known quiet-window class ([[resume-needs-quiet-window]]) landing on the ONE door —
FIXED same session (cd92e784: pre-pause spawn killed at resume · quiet-gated send · positive
JSONL-user-row receipt w/ bounded re-sends → typed failure). Third live fire end-to-end GREEN:
ask → answer → resume → "Human chose: fetch-report" deliverable → completed, zero zombie
processes. Full ask loop now positively verified on the one door.**

**The decision:**
- **Agents never ask the human directly. Every agent question goes to the orchestrator** through the
  mailbox; the orchestrator answers it itself or surfaces it to the human. `pc_ask_user` **dies**.
- The agent↔orchestrator exchange is **visible in chat by default**, with a chat-settings filter to
  hide system traffic. (No new mechanism — FD-3 already requires every injected system message to
  carry a machine-readable kind tag *exactly so* the chat can filter it. This also answers the
  mailbox doc's open question: system-injected messages are **shown by default**, filterable.)

**Why:** one door instead of two; the orchestrator is better positioned to triage than a raw agent
question landing in the human's lap; deletes a whole path.

**Ripple:** ✅ done in M7 — the required set is now 6 (`pc_ask_user` left; M5 had added the
contract/attachment readers). Baseline-tools audit recorded in the Audit backlog.

**Addendum (2026-06-03, from `3-product` notes):** the **orchestrator itself has no ask tool, and
keeps none** — verified: its toolset contains no `pc_ask_*`; it only *answers* agent questions via
`pc_answer_pending`. **Chat is the orchestrator's ask door** — when it needs the human, it asks in
plain text and the turn ends. The full ask layering, deliberate:
- **agents** ask the **orchestrator** (mailbox, this FD),
- the **orchestrator** asks the **human in chat** (no special mechanism),
- **formal reviews/approvals** go through the **Human Inbox** (FD-7).

---

## FD-7 — Human Inbox System becomes its own workstream

**Status:** 🟢 Locked — 2026-06-03 · **✅ EXECUTED — M8, 2026-06-04** (scope doc:
`refactor plan/m8-human-inbox-scope-2026-06-04.md`)

**The decision:** human review gets designed as a **dedicated subsystem**, not patched per-feature:
- proper **review packages** (everything a reviewer needs, assembled),
- a proper **review process** (consistent approve/reject/feedback flow everywhere),
- **global notifications** when review is needed in *other* projects.

**What it had to resolve — all three resolved in M8:**
- ~~The two overlapping "open question" tables~~ → **the mailbox `user-inbox` channel IS the one
  durable Human Inbox** (no new table). `pending_asks` survives as agent ask-STATE (a different
  job); ☠ `pending_interactions` + AskShadow deleted whole (migration 0045 archive) — the
  "durability shadow" was write-only with no reader; the visible surface rides the real sources.
- ~~Review gates vs verification holds merge?~~ → **two mechanisms, ONE surface + ONE decision
  shape.** They gate different things (a planned graph step vs a contract's deliverable); both now
  arrive as the same inbox **decision card** (context + work + Approve / Reject-with-required-
  feedback) and resolve through their existing typed doors. A decision through ANY door
  (card, orchestrator tool, raw HTTP) auto-clears the card (resolve-by-source).
- ~~Where do ceiling hand-offs land?~~ → the M6-C escalated gate now delivers an **escalated
  user-inbox card** ("agent loop exhausted").

**What M8 found + fixed:** pre-M8, EVERY formal human decision was invisible — `requestReview`
delivered only the orchestrator flavor (a `reviewer:'human'` gate paused the run silently); the
human-review verification tier promised an inbox that didn't exist; and a loop kick-back's
re-review **dedupe-vanished** against the first prompt's idempotency key (FD-8 violation — fixed
with iteration-keyed delivery). Also ☠ the v1 web approval corpse (ApprovalBubble posted to a
route that never existed).

**Delivered surface:** cross-project **Inbox bell** in the app header (actionable-count badge,
project chips, decide-from-the-card) + the per-project ActivityPanel inbox grew the same decision
cards. `GET /api/inbox` = every user-inbox recipient across all projects.

---

## FD-8 — No message silently dies (mailbox lifecycle + failsafes)

**Status:** 🟢 Locked — 2026-06-03 · core delivered in M4a (2026-06-04) ·
**✅ CLOSED in M4b (2026-06-04, as amended; scope:
`refactor plan/m4b-lifecycle-failsafes-scope-2026-06-04.md`)**

**The decision:** the principle is law — **every undelivered or unanswered mailbox message must
either retry or surface visibly. Silent loss is never acceptable.** Concretely:
- **Dead-letter recovery** — ✅ **SOLVED STRONGER in M4a: messages no longer die in the first
  place.** An orchestrator-less delivery DEFERS (parked, zero attempts consumed, 60s recheck)
  until an orchestrator exists — no give-up, so no re-delivery sweep needed. (Live finding that
  forced it: 93 dead letters incl. same-day; the old worker dead-lettered an away-orchestrator
  message on its FIRST pass. Also fixed at the source: workflow workers' synthetic dispatcher
  ids no longer get doomed terminal envelopes at all — asks fall back to the active
  orchestrator; a pinned session that truly doesn't exist dead-letters honestly.)
- **Lifecycle tracking:** sent → delivered → *expecting response* → response received → done. The
  plumbing half-exists (delivery rows track pending→accepted; interactions track open→answered); the
  rebuild unifies it and adds a **watchdog for "expecting a response that never came."**
  ✅ **M4b delivered the watchdog** (open ask > 15min → ONE actionable `agent-ask-escalated`
  user-inbox card; answer/cancel from the card through the EXISTING doors; decided-anywhere clears
  it, resolve-by-source). The M4b refute REJECTED a literal unified state machine — the states
  already live in the right places (delivery rows · `pending_asks`); one more table would be a
  pending_interactions-style shadow. FD-17's stall ladder deliberately excludes paused runs;
  this watchdog is its complement.
- **M4b amendments:** ☠ `expires_at` deleted whole (migration 0046) — the column was dead since
  birth (one NULL-writing site, zero readers), and message expiry CONTRADICTS this decision
  (silent loss by timer). · Honest dead letters now mint a user-inbox `system-notice` card in the
  same tx ("Message could not be delivered" + original content + reason) — **notice, not
  requeue**: the remaining dead-letter causes are permanent or already-retried ×5, so requeue
  would re-run a guaranteed failure.

**Why:** Emerson's failsafes note + the known issue that dead-lettered orchestrator copies vanish
with no alert, no indicator, no requeue.

---

## FD-9 — Workflow steps: Agent · Review · Move card · Loop

**Status:** 🟢 Locked — 2026-06-03 · ⚠️ **reverses the shipped card-move-as-effect decision** ·
**✅ EXECUTED — M6 slice B, 2026-06-04** (four kinds live: `move` step = drawn card-move, failure
fails the step honestly; `loop` step = the reject target owning back_to/ceiling/carry, drawn with
an iteration badge; ☠ move-as-property ×3 incl. on-reject move-back · RejectEdge · RetryPolicy
(dead schema — validated, executed by nothing); boot def-migration spliced stored properties into
real steps. Ceiling-hit still fails+flags — the pause-for-human semantics land in slice C/FD-11.)

**The decision:** the rebuild's step model is **four visible step kinds, each doing one thing**:
- **Agent** — hand a job to an agent (unchanged).
- **Review** — quality gate, human or orchestrator (unchanged).
- **Move card** — moving the card is **a step of its own**, drawn in the graph — not a property
  hidden under an agent or review step. The move-as-property mechanism **dies**, including
  "on reject, move back to Z."
- **Loop** — a real construct: review rejects → loop back to the agent step with feedback, up to a
  **retry ceiling (default 3)**; hitting the ceiling sends the work to the **Human Inbox** (FD-7).

**Why:** what the graph shows = what happens. A property is invisible in the editor; a step is drawn
and reviewable. The visual editor being genuinely good is a rebuild requirement — this serves it.
The old property's one job the step can't do (conditional move-back on reject) is covered better by
Loop semantics: the card only moves on the *forward* path, via explicit Move steps.

**One-path note:** this consciously reverses `card-move-as-effect` from the first-principles
redesign (shipped days earlier). The rebuild **deletes** the property path — no dual support.

---

## FD-10 — No stage-entry triggers

**Status:** 🟢 Locked — 2026-06-03 · **✅ EXECUTED — M6 slice A, 2026-06-04**

**The decision:** a card entering a stage **does not start a workflow**. Exactly two ways a run
starts: the **orchestrator's fire tool** and **manual "run now."** The stage-watching trigger
machinery is deleted in the rebuild.

**Why:** stage-entry triggering "causes too much issue" (Emerson) — it's a hidden tripwire that
fights the agent-centric direction. If automation demand returns, it comes back deliberately — most
likely as the orchestrator *noticing* the move and choosing to fire, keeping one brain in charge.

**✅ Delivered (M6 slice A):** definitions have NO `triggers:` key (validator rejects one; schedule/
event vapor kinds died too — validation accepting what the runtime can't do was a lie at the save
door); ☠ `dag/triggers.ts` + the firing half of `moveAndFireV2` (→ `moveWorkItemV2`) + run-row
trigger columns (migration 0043) + trigger UI; boot sweep strips the key from stored defs. The
fire route + `pc_fire_workflow` gained optional `workItemId` — fire ON an existing card (it becomes
the run root), preserving stage-entry's one real capability through the one deliberate door.
Banned names: the matcher fns + trigger types + `allow_stage_workflow_skip` + `also_fire_on_regression`.

---

## FD-11 — Workflow observability + repair are core requirements

**Status:** 🟢 Locked — 2026-06-03 · **req 1 SHIPPED in M3a (2026-06-04)**

**The decision:**
1. **The run diary becomes the truth.** Every run keeps a readable step-by-step story (started step 2
   · agent delivered · review rejected with notes · retried…), and **the orchestrator can read all of
   it** to debug. A stuck or dead run is never a mystery.
   **✅ M3a:** ONE gateway door writes every line + its live fact; lifecycle bookends + the
   `agent_dispatched` cross-link (the diary hands you the agentRunId); `pc_get_workflow_run`
   renders the plain-English story; the Workflows run panel shows the live timeline. Live-proof:
   a 12-line reject-loop story end-to-end. (State PROJECTION from the diary rides M6.)
2. **Restart at a specific step** after repair — not from scratch.
   **✅ M6 slice C (2026-06-04):** `pc_resume_workflow_run` / resume route / run-panel button —
   failed runs reset their failed/skipped steps to pending (completed work KEPT) and re-advance.
3. **Repair loop until reliable:** broken workflow → orchestrator helps work through it → resume from
   the failed step → once it succeeds, it's locked in as the repeatable, reliable workflow.
   **✅ M6 slice C:** the resume RE-FREEZES the current definition (compat-checked) — the repair
   edit actually reaches the resumed run. Plus: loop ceiling now PAUSES as an escalated human gate
   (never fails), and cancel is wired end-to-end (route + button + tool + soft-delete path, with
   child-agent cascade + the `workflow_cancelled` diary line).
4. **The workflow-builder agent must be expert-level** — complete knowledge of how the engine works,
   translating user intent into a fully valid, runnable workflow ("saved ⇒ runnable" validation
   backstops it).

---

## FD-12 — One write door, zero bypasses

**Status:** 🟢 Locked — 2026-06-03 (from `0-store/Emerson's Notes.md` discussion)

**The decision:** the gateway law becomes enforced, not aspirational — **every durable change goes
through the one write door, with the change and its "this changed" receipt written in one
unbreakable step. Zero bypasses.**

**The three known bypasses, all sentenced:**
1. ☠ The old two-step work-item writer (`work-item-writer.ts` — save, then announce separately) —
   ✅ EXECUTED in M2 (2026-06-03): cut for the one-step gateway form.
2. ☠ The workflow run-diary writes that skip the gateway and `live_outbox` (`appendEvent`) —
   ✅ EXECUTED in M3a (2026-06-04): every diary line through
   `WorkflowRunMutationGateway.appendRunEvent` (event row + `workflow.run.event` fact, one txn);
   DIARY-DOOR structural gate keeps it dead.
3. ☠ The legacy `inbox-drain.cjs` hook's raw-SQL writes —
   ✅ EXECUTED in M4a (2026-06-04): the hook + repo + `agent_inbox` tables deleted whole
   (migration 0041 archive-rename; the tables had been writer-less since slice 017 — the hook
   drained an eternally-empty set every prompt). NO-INBOX-WRITE gate keeps it dead.
   **ALL THREE BYPASSES EXECUTED — FD-12 is fully delivered.**

**Plus a guard:** a structural test that a new bypass can't quietly appear (e.g., no direct
table-write imports outside the gateway layer). Vigilance is not a strategy; the build enforces it.

**Why:** Emerson's "poison at the roots rots the whole tree." The one-cashier-window pattern is
already the design; this locks closing the stragglers as rebuild requirements.

---

## FD-13 — The store split: happenings are event logs, configuration is rows

**Status:** 🟢 Locked — 2026-06-03 — **the #1 store decision, resolved**

**The decision:** a deliberate split, not all-or-nothing event-sourcing:
- **Things that happen** — workflow runs, agent runs, messages/notifications — are stored as
  **append-only event logs** (the diary is the truth; "current state" is derived from it).
- **Things that are configured** — agents/pods, projects, settings, cards, stages — stay as
  **mutable rows** (with the existing append-only audit tables for history).

**What this buys (user-visible):** a frozen or dead run is never a mystery · any run's history can
be replayed step-by-step · the orchestrator's debugging view (FD-11) becomes trivially real.

**Why the split and not full event-sourcing:** history is the whole *value* of run-shaped data —
you ask "what went wrong?" about runs, not about a pod's prompt. Event-sourcing config would tax
every screen in the app for no user-visible gain; the audit tables already keep config history.
All the payoff where it pays, none of the tax where it doesn't.

**Resolves:** the "Store: event-log vs row-state" backlog item. FD-11's run diary is the first
concrete instance. Open (technical): cutover handling for runs in flight when the diary becomes
truth (migrate history vs accept gap vs quiet-moment cutover).

---

## FD-14 — Interrupted runs are resumable; paused runs always survive restart

**Status:** 🟢 Locked — 2026-06-03 (from `1-engine/Emerson's Notes.md` discussion)

**The decision:**
1. **A run killed by an app/engine crash is resumable, not just visibly failed.** The conversation
   survives on disk (Claude's transcript file); the continuation machinery already exists. The
   product grows a **"resume interrupted job"** affordance instead of a dead-end failure notice.
2. **Paused runs (waiting on a human answer) always survive a restart** — already true on the
   production path; locked as law everywhere (the legacy boot path that bulk-fails paused runs is
   wrong and dies in the Step-2 one-loop merge).

**Why:** "I don't want users losing valuable work because they accidentally closed the app"
(Emerson). The work isn't lost today — we just don't offer the pickup.

---

## FD-15 — Agent concurrency cap is a visible app setting

**Status:** ✅ Shipped — 2026-06-03 (commit 87b33b27)

**The decision:** the "how many agents may run at once" limit (hard-coded 5 today; the rest queue)
becomes a **global app setting** the user can see and change.

**As built:** the setting existed in the store but was a DEAD KNOB — nothing read it; the host's
registry hard-coded 5. Now: `AgentRunRegistry.setMaxConcurrent` (live; raise admits queued runs
immediately, lower never interrupts running ones) · new `set-config` host command · the server
pushes the stored cap on every host connect AND on settings save (host restart never required) ·
"Max agents at once" field in Settings → General (1–50) · host `/health` reports the effective cap
(positive receipt that a push landed). Verified live both ways: fresh host booted at 5 → server
connect-push set it to the stored value; PATCH → host effective cap followed.

---

## FD-16 — Orchestrator tooling is two-tier: lifecycle first-order, diagnostics on demand

**Status:** ✅ Shipped — 2026-06-03

**The decision:**
- **Agent-lifecycle tools are first-order** — the orchestrator natively knows them in its prompt:
  list my agents, inspect a run, cancel, resume/continue. (Partially exists.)
- **Diagnostic/engine tools are reachable on demand** — exposed through a search-style "find me the
  tool for X" tool rather than dumped into the prompt or load-time tool list. Applies to the
  orchestrator and the `caisson` in-app specialist.

**Why:** Emerson wants debugging power available without prompt-bloat. The on-demand pattern is
proven (Claude Code itself uses deferred tool search for big catalogs).

**As built:** every catalog tool carries a tier (`PC_RIG_TOOL_TIERS` in the one registry; parity
guard test): `first-order` / `on-demand` / `worker`. Two new first-order tools form the door:
`pc_find_tool` (keyword search; returns matches with tier + input schema) and `pc_call_tool`
(executes ONLY `on-demand` tier through the same handler chain — same routes and audit rows as
the specialist surfaces; typed refusal for first-order/worker/unknown, so the door can't bypass a
withheld grant and can't recurse). Emerson's call (2026-06-03): full reach including config
WRITES, audited — Option B over read-only. Orchestrator + caisson granted the door (live in DB
via boot reseed, 34/23 tools); prompts steer authoring to specialists by default and warn against
editing a workflow def while a run is in flight (open question rides M6). Worker comms + sentenced
tools (`pc_ask_user` et al.) are permanently outside the door.

**Live-verified 2026-06-04:** fresh orchestrator, one natural-language turn → `pc_find_tool`
("agent audit log") returned `pc_list_agent_audit` + tier + schema → `pc_call_tool` executed it
(`ok:true`, real rows) → clean end_turn in 18s. Find → schema → audited call, end to end.

---

## FD-17 — Timeouts escalate before they execute

**Status:** 🟢 Locked — 2026-06-03

**The decision:** **no agent is killed while demonstrably alive and working.** Silence is a trigger
for escalation, not execution. The ladder, in order:
1. "Looks slow" badge in the UI (exists today).
2. Verify the process is actually alive and mid-task (process check + transcript activity).
3. Notify the orchestrator to look in on it.
4. Kill **only** on the hard ceilings: total-run-time limit, or a confirmed-dead process.

Every escalation step is still typed and visible — this does not reintroduce silent hangs. The
blunt "5 minutes of quiet = killed as idle" behavior dies: it guesses death from silence, which
violates the positive-receipt principle, burns usage, and destroys user trust by killing
deep-in-work agents.

---

## FD-18 — "Claude is loading" is visible on every session surface

**Status:** 🟢 Locked — 2026-06-03

**The decision:** every chat surface (orchestrator especially, plus modals and agent views) shows a
clear loading state — greyed-out input + a "Claude is loading…" indicator — until the session's
**positive ready signal** fires, and only then enables input.

**The mechanism already exists:** the modern spawn path's ready gate waits for three positive
confirmations (tools registered + input channel open + init complete) — not just the welcome
banner. The rebuild requirement is *surfacing* it. The three popup modals get this for free when
they migrate off the older banner-guess machinery (Engine Steps 5–6).

**Why:** feedback to the user is non-negotiable; "is it frozen or loading?" must never be a guess.

---

## FD-19 — Areas are first-class: renamed, redesigned, and known to the orchestrator

**Status:** 🟢 Locked — 2026-06-03 (from `3-product/Emerson's Notes.md` discussion)

**The decision:**
1. **The page is called "Areas"** — not FOCUS.
2. **The page becomes cards → click → edit modal.** Each area card shows title, a summary, and
   open-vs-complete work-item counts. Clicking opens a modal to edit name, description, everything.
3. **Areas become first-class for the orchestrator** — the same pattern as tools: every area carries
   a **good description**, and when the orchestrator creates a work item it **considers which area
   the item belongs to** and assigns it. Ergonomics are part of the decision:
   - the orchestrator is **nudged at card-creation time** (the create door carries the area
     consideration — it doesn't have to remember),
   - the orchestrator can **write and improve area descriptions itself**, so the human isn't
     maintaining them by hand for the orchestrator's benefit.

**Why:** areas are the project's mental map; today they're a passive filter rail. If the
orchestrator is the primary creator of work items, it must think in the same buckets the human
does — and that only works if the buckets describe themselves (exactly how tool selection works).

---

## FD-20 — Patterns: a template that spawns a fully-loaded work item

**Status:** 🟢 Locked (shape) — 2026-06-03 · detailed design comes as its own pass

**The decision:** PC gets a **"Patterns" place** — saved, reusable recipes for work that recurs.

- **What a Pattern is:** a package — context + instructions + optionally a workflow — that **mints a
  fresh work item with everything attached** when invoked. "A combo of work items and workflows,
  wrapped up and repeatable" (Emerson).
- **The dividing line:** work items **complete**; Patterns **persist**. A work item is a one-shot
  unit of work with an ending; a Pattern is the standing recipe for the next occurrence.
- **Promotion:** a finished work item can be **promoted to a Pattern** — the brief, context, and
  shape of work that succeeded once becomes the reusable starting point.
- **No new runtime machinery:** workflows remain the only execution path. A Pattern is a **template
  layer above** — it spawns the card (and wires the workflow if it has one); the engine never learns
  a new concept.

**Why this shape:** PC already has a repeatable construct (workflows) — a Pattern must not become a
second one. Keeping it as "template that spawns a fully-loaded work item" adds the recurring-work
experience with zero new engine semantics, and keeps one path.

**Open (design pass later):** where Patterns live (global vs project) · the promote flow · how a
Pattern's context attaches to the spawned card (interacts with the dispatch-payload audit below).

---

## FD-21 — Transient modal sessions die; authoring flows through the orchestrator

**Status:** 🟢 Locked — 2026-06-03 (from `4-ui` + `5-supervisor-ops` notes discussion)

**The decision:** the three popup Claude sessions — **agent designer, workflow builder, project
setup wizard — are deleted entirely.** No separate modal Claude processes. Instead:
- The user tells the **orchestrator** what they want (new agent, new workflow, project setup);
  the orchestrator interviews them **in the one chat**, then **dispatches the specialist agent**
  to build it (the FD-11 expert workflow-builder · the agent-management agent from the audit
  backlog · plain `CLAUDE.md` writing for setup).
- **Entry buttons survive as chat handoffs** — "Create agent" / "Create workflow" drop the user
  into the orchestrator chat with a pre-filled intent, not into a popup.
- **Review happens on the real surfaces** — the built workflow is reviewed in the Workflows page's
  visual editor (FD-9 requires it to be genuinely good), not a modal preview pane.
- The **first-run wizard stays** (install + sign-in + first project) — a bare machine genuinely
  needs it. Only the *project* setup wizard (the `CLAUDE.md` interview popup) dies.

**Why:** modals pull the user out of where they work, and each one spawns its own Claude process on
the most burned machinery in the codebase (start-race, chat bleed-through, banner-regex, strict-mode
kill — four documented scars). One conversation surface, one brain, specialists dispatched behind it.

**Structural bonus:** migration **Step 5 ("move modals to Engine") collapses into "delete."** Only
the orchestrator migrates (Step 4); `PtySession` + banner detection die sooner (Step 6 shrinks).

---

## FD-22 — Claude Code version is exact-pinned, tested, and update-controlled

**Status:** 🟢 Locked — 2026-06-03

**The decision:**
1. PC declares **one exact tested Claude Code version** — a pin in code, bumped deliberately only
   after a new version is verified against PC's quirk surface (banner rendering, queue protocol,
   transcript format — all have broken under us before).
2. **Preflight checks for exactly that version** (today it only checks ≥ 2.0.0); the first-run
   installer installs exactly that version.
3. PC **disables Claude's auto-updater for sessions it spawns** (PC controls every spawned Claude's
   environment, so this is cheap) — an overnight self-update can't silently break the app.
4. **Mismatch = loud warning + one-click "install the tested version"** — not a hard wall, so a dev
   machine can run ahead deliberately.

**Related lock (same discussion):** `.project-companion/` (workflows + prompts scaffolded into a
project) **stays committed to git** — workflows are part of the project: versioned, history-tracked,
machine-portable. Not gitignored. Nothing else PC writes lands in project folders (runtime config
lives in per-session scratch dirs outside the repo).

---

## Audit backlog (agreed work, not decisions)

- **Knowledge usage audit — ✅ DONE 2026-06-04, PASS.** Two live probes (Quick Tasks writer pod,
  planted-fact glossary doc): (1) unprimed fact-retrieval task → ONE `pc_knowledge_read` call,
  correct fact delivered; (2) knowledge-helpful-but-not-literal task → agent consulted the doc
  unprompted and wove both facts in naturally. Knowledge is genuinely used, not just listed.
  Probe artifacts removed.
- **Agent-management toolkit audit — ✅ DONE 2026-06-04 (d1eec913).** 14 of 17 capabilities were
  already tool-complete; the 3 UI-only gaps (reset-to-default · clone-to-project ·
  promote-to-global) gained on-demand tools (`pc_reset_agent_to_default` /
  `pc_clone_agent_to_project` / `pc_promote_agent_to_global`) — thin proxies over the existing
  routes. Registry 56→59; golden regenerated. Design rule going forward: every pod-management
  capability ships with an on-demand MCP tool, not just a UI button.
- **Baseline-tools audit — ✅ first half DONE in M7 (2026-06-04).** The always-granted set is 6:
  `pc_get_work_item` · `pc_submit_deliverable` · `pc_ask_orchestrator` (the ONE escalation door) ·
  `pc_get_contract` · `pc_list_attachments` · `pc_get_attachment` (`REQUIRED_AGENT_TOOLS`,
  tool-catalog.ts). ~~Still open: the full agent roster audit~~ **✅ roster audit DONE 2026-06-04
  (d1eec913):** tools clean across all 10 stock pods (required-6 everywhere, zero dead grants);
  descriptions/dispatch-guidance all current. 3 findings fixed: live `caisson-workflows-guide`
  taught the deleted trigger/6-kind model (reseed-LOCKED by historical hand-edits — overwritten
  directly via updateKnowledge; a seed edit can never heal a hand-edited knowledge row) ·
  orchestrator prompt's stage-entry-triggers clause → no-triggers truth · 'workflow v2' labels in
  3 caisson seeds. NOTE the audit corrected a premise: stock pods DRIFT-RESEED on boot
  (pod-seed-with-drift.ts), they are NOT insert-if-not-exists — only hand-edited knowledge locks.
  ~~M7 finding: `agent-ask-*` history kinds have no writer~~ ✅ cleanup sweep 2026-06-04 — the
  writerless kinds (and their dead fields + web render branches) DELETED; zero rows carried them.
  Same pass: contracts `PENDING_ASK_KINDS` 'user' leftover narrowed (domain had it since M7).
- **Dispatch-payload audit — ✅ DONE 2026-06-03.** Verdict: the context-pod goal is **partially met,
  broken for attachments.**
  - **Body / fields / parent / live-read:** OK — body referenced in the prompt, everything readable
    via `pc_get_work_item` during the run.
  - **🔴 Attachments are unreachable.** The dispatch prompt *explicitly tells* the agent to use the
    card's attachments (`pod-materializer.ts:320`) but **no tool exists to fetch them** — no
    `pc_list_attachments` / `pc_get_attachment` in the registry. The agent is directed to use
    something it cannot access. **Rebuild requirement: an attachment-read tool in the baseline set.**
  - **🟠 Acceptance criteria are invisible to the agent.** Only the expected-output spec is inlined;
    the verification predicates (`body_contains`, `attachments_present`, …) are never surfaced, so an
    agent can't self-check before submitting. Folds into FD-5: the Work Contract the agent can read
    must include its acceptance criteria (see FD-5 addendum).
  - **🟠 No contract re-read.** `expected_output` is inlined once; no `pc_get_contract` tool to
    re-check mid-run. Same FD-5 fold.
  - Knowledge: roster inlined, content via `pc_knowledge_read` — OK (depth of *use* is the separate
    knowledge-usage audit above).

---

## Decision backlog (raised in discussion, not yet written up)

These came up and need their own entries once we talk them through:

- 🟡 **Worktree confinement must cover Bash git** — observed live 2026-06-03 (P2 landing): a
  workflow agent mistakenly wrote its file in the MAIN repo, committed there, then "cleaned up" with
  `git reset HEAD~1` + `git checkout -- .` + `git clean -f` in the main tree — destroying all
  uncommitted human work (and one command away from eating a commit).
  **Mitigated same day (commit 19a8818d):** root cause was that path-guard's worktree enforcement
  had been SILENTLY DEAD — CC ≥2.1 sets `agent_type` on the main thread of `--agent` sessions, so
  the hook mis-took every workflow agent for a Task() subagent, found no binding, and skipped. Fixed
  (env checked first) + Git-Bash `/e/…` path form covered + NEW **git write fence** for every PC
  session including the orchestrator (writing git outside the session's fence root → denied with a
  "stop, report, don't clean up" message). 13 subprocess tests; the hook previously had zero.
  **Still open for the rebuild:** string-scanning is a backstop, not a sandbox — the real fix is a
  spawn-level jail. Add path-guard to the FD-22 quirk surface (a CC change killed it once already).
- ⚪ **Dispatch payloads must be fence-relative (Emerson, 2026-06-03)** — agents already spawn WITH
  cwd = their worktree; the incident agent wandered out because our prompts/payloads hand it
  ABSOLUTE paths (work-item bodies, project records, task text all leak `E:\…` references — the
  model sees a full path and sometimes goes there). Rule for the rebuild: nothing in a dispatch
  payload may contain an absolute path outside the agent's fence; instructions reference files
  relative to the agent's own root ("create `docs/x.md`"), and "the project" IS the cwd. Folds into
  the FD-5 Work Contract shape + the dispatch-payload audit findings.
  **Talked through 2026-06-03, then SHELVED (Emerson):** direction tentatively agreed — **block at
  the dispatch door** (typed refusal naming the exact offending text; orchestrator-sent → it
  self-fixes and retries; workflow-step-sent → step fails visibly with the reason, future Human
  Inbox item). NOT locked — needs another pass, and the bigger open question is **app-owned
  worktree creation + teardown lifecycle**, which is its own design conversation. Revisit alongside
  FD-5.

- 🟢 **CLOSED by P9 (2026-06-04) — an agent's ask trips the engine's watchdogs.** Original
  finding (S2 live-fire): a dispatched workflow-builder asked via `pc_ask_orchestrator`; after the
  answer, the resumed run produced no turn within 90s and the `firstTurnMs` watchdog killed it as
  failed/idle-timeout — twice. (Refute pass corrected the mechanism: the ASK paused correctly and
  cleared the idle timer; the killer was the post-answer RESUME fail-fast.) **P9 fix: the 90s
  firstTurn watchdog AND the 5min idle-kill are DELETED** (`armIdleTimer`/`armFirstTurnWatchdog`
  banned-resurrection) — silence escalates via the reconciler's stall ladder (badge 3min →
  verify-alive + ONE `agent-stalled` orchestrator notify 5min) and kills only on wall-clock or
  confirmed-dead. The interim "ask suspends watchdogs" rule is structurally true (paused runs are
  excluded from the ladder; FD-14 law already protects them).
  **Sibling (marco class) ALSO CLOSED:** turn-end without `pc_submit_deliverable` on a contract
  run now triggers an instant marked nudge into the run (strike 1) → ONE orchestrator escalation
  (strike 2) — never a kill. **Live-verified 2026-06-04:** the verbatim marco task got nudged and
  delivered in ~10s (was: silent death at 300s); a mid-run claude.exe kill still fails
  `unexpected-exit` in ~2s. Scope: `refactor plan/p9-timeout-ladder-scope-2026-06-04.md`.
- ⚪ **Work Item vs Work Contract model** — what each is, how they relate (goal vs. assignment), and
  the rule for a contract with no work item. *(See `0-store/contracts-system.md` and `3-product/work-items.md`.)*
  Also owns: **passing work down the line** in workflows (hand-off control lives in the contract) —
  parked here per the 2026-06-03 discussion.
- 🟢 **Naming: "Work Contract"** — agreed 2026-06-03; in prose we call the `agent_contracts` entity the
  "Work Contract" to avoid collision with the `@pc/contracts` type package. (Code rename deferred to
  the rebuild.)

*(Resolved and promoted: "Where the deliverable lives" → FD-5 · "Store: event-log vs row-state" → FD-13.)*
