# S2 — Authoring handoffs (FD-21 prereq for P7 modals-delete)

**Date:** 2026-06-04 · **Branch:** `refactor/auto-pathway`
**FDs:** FD-21 (modals die; authoring through the orchestrator) · FD-11 §4 (expert builder) · FD-16 (specialist steering)
**Emerson's direction (2026-06-04):** lean. Create surfaces get a banner — "You can create a
workflow through conversation in chat" — plus a link that opens chat. Nothing more (no prefill,
no auto-send). Manual creation stays.

---

## What changes (user-visible)

| Surface | Today | After S2 |
|---|---|---|
| Workflows "+ New workflow" | Opens the conversational popup (own Claude session + live graph) | Small dialog: banner + **Open chat** link, plus a name field that creates a **disabled skeleton** workflow and lands you in the existing YAML tab to fill in |
| Workflow "Edit" button | Opens the popup in edit mode | Switches to the YAML tab (already editable today); chat handles conversational edits |
| Agents "+ Add agent" → Conversational tab | Own Claude session in the modal | Tab gone; banner + **Open chat** link on the remaining (Global pool / Manual) tabs |
| Project setup nag ("Run setup wizard…") | Opens the wizard popup (own Claude session) | Banner + **Open chat** link; the orchestrator interviews + writes `CLAUDE.md` itself |
| Orchestrator chat | Points the user *away*: "open the Agents tab → Conversational" | Interviews in chat, **dispatches the specialist**, reports back, runs the revise loop |

**The one loss (accepted):** the mid-interview live graph + drag-nodes preview. Review happens on
the finished workflow (Workflows page graph + YAML tab); revisions go through chat. The
genuinely-good visual editor rides M6 (step-model v3) — building it now means building it twice.

**Manual-create gap closed:** today there is NO from-scratch manual workflow create ("+ New
workflow" is conversation-only; manual = duplicate + YAML edit). The new dialog's name field fills
it: `POST /api/workflows` with a minimal skeleton def carrying `disabled: true` (route lifts
`disabled` from the def; invalid YAML persists as `status:'invalid'` — both safe, can't fire).

## Build order

### A — Brain (server prompts; pods update via boot reseed/drift)

1. **`workflow-builder` pod** (`workflow-builder-pod-content.ts`): reshape modal-interviewer →
   **dispatched worker**. Keeps the entire v2 expertise core (shape, refs, patterns,
   validator table — FD-11 §4). Drops: interview shape, AskUserQuestion, draft-sync sections.
   Gains: build-from-spec contract (the dispatch input IS the interview result; decide defaults,
   never stall; `pc_ask_orchestrator` only for genuine blockers), edit-by-slug flow, deliverable =
   what-was-published summary. Tools: − `pc_save_workflow_draft` − `pc_read_workflow_draft`
   − `AskUserQuestion` + `pc_ask_orchestrator`. `dispatchGuidance` flipped to "dispatch with a
   full spec: purpose, trigger, steps, agents, gates."
2. **`agent-designer` pod** (`stock-pod-seed.ts`): same reshape — design-from-spec worker
   (keeps the design doctrine: one-job pods, naming, model sizing, knowledge-vs-prompt).
   Creates via `pc_create_agent` + `pc_create_knowledge`; deliverable = what-was-created.
3. **Orchestrator pod** (`orchestrator-pod-content.ts`): the inversion. "Modifying agents" /
   offloaded-surfaces sections rewritten to the authoring playbook: interview in chat (you know
   the project; ask only what changes the outcome) → dispatch `workflow-builder` /
   `agent-designer` with the full spec → report where to review (Workflows tab / Agents tab) →
   revise loop = re-dispatch with notes. Project setup: interview + write `CLAUDE.md` directly
   (it has Write; dispatching a worker for one file is ceremony) — fold the setup-wizard
   instructions content in.

### B — Web (lean surfaces)

4. New `CreateWorkflowModal` (replaces `WorkflowBuilderModal` usage in `WorkflowsList.tsx`):
   banner + Open chat (navigate to orchestrator tab, same mechanism as the Work-Items
   "Chat about this" bridge, no prefill) + name → skeleton create → select row, YAML tab.
5. `DetailPane` "Edit" → `setTab('yaml')`; drop the edit-mode modal mount.
6. `CreatePodModal`: remove Conversational tab + `AgentDesignerChat` import; add banner.
7. `ProjectSettingsPanel` `SetupWizardNag`: banner text + Open chat (drop `SetupWizardModal` mount).

### C — Live-verify (gate before P7) — ✅ ALL THREE FLOWS GREEN 2026-06-04

Throwaway project `s2live` (FD-16 recipe: POST /api/projects snake_case → WS first-send spawns
→ poll REST for the artifact; deleted after):

- **Workflow ✅** — one natural turn (complete spec) → orchestrator dispatched `workflow-builder`
  in 9s, NO needless interview → published `draft-and-check` with the EXACT requested shape
  (manual trigger · writer node w/ `$carry.feedback` · orchestrator review gate · reject
  back_to draft, max 3, carry `$self.output`). **Self-heal observed:** builder run 1 asked the
  orchestrator a (needless) writer-pod question and DIED at the 90s first-turn watchdog while
  waiting; continuation died the same way; orchestrator answered, amended the spec inline, and
  re-dispatched fresh → run 3 published clean in 35s. User never involved; total ~6 min.
- **Agent ✅** — one turn → `agent-designer` dispatched in 6s → `haiku-weather` pod 24s later:
  project scope, haiku/low (correctly sized from "cheap and fast"), minimal tool set.
- **Setup ✅** — one turn → CLAUDE.md written in 20s, terse, conventions honored — via the
  on-demand door (`pc_call_tool` → `pc_write_claude_md`, 3 calls in transcript), so the
  nag-clearing `project-claude-md` live event fires.

**🔴 Engine finding (logged, NOT fixed here — FD-17/P9 class):** `pc_ask_orchestrator` during a
worker's FIRST turn leaves the run waiting on the tool result → no turn-end → the 90s
`firstTurnMs` watchdog (agent-run.ts:203) kills the run as failed/idle-timeout. Same exposure
for `idleMs` on later turns. An ask should suspend the watchdogs (the agent is waiting by
design, not stuck). FD-17's escalate-don't-kill ladder is the proper fix; until then the
orchestrator's revise loop recovers, and the reshaped prompts minimize asks (decide-don't-ask).

### D — P7: the deletion (FD-21) — ✅ SHIPPED 2026-06-04

As-built:
- **Web:** ☠ `WorkflowBuilderModal` · `WorkflowBuilderChat` · `AgentDesignerChat` ·
  `TransientAgentConversation` · `SetupWizardModal` · `features/transient-sessions/*`;
  `api/client.ts` re-export pruned.
- **Server:** ☠ `features/transient-sessions/` + index.ts registration · the entire
  `ProjectRuntime` transient block (fields, `start/end/resize/Pty/Session` ×3,
  `transientCcSession`, `hasLiveTransientSession`, draft store) · workflow-compat draft
  routes + interface methods (+ unused `broadcastTo` dep) · runtime-host
  `hasLiveTransientSession` seam · setup-wizard scaffold (template file, `writeSetupWizardPrompt`,
  the always-re-render backfill); interview beats folded into the orchestrator's setup playbook.
- **Tools:** ☠ `pc_save_workflow_draft` + `pc_read_workflow_draft` (registry, tiers, mcp
  handlers); golden regenerated **53→51**.
- **Gates:** banned-resurrection grew `registerTransientSessionRoutes` / `startAgentDesigner` /
  `startWorkflowBuilder` / `startSetupWizard` / `hasLiveTransientSession` /
  `set|getWorkflowBuilderDraft` / both draft tool names; transient-sessions + workflow-compat
  allowlist entries removed.
- **Tests:** project-create.test.ts re-anchored on workflow-seed scaffold.
- **Verified:** workspace typecheck · server 251 · mcp 75 · web 126 · domain 20 all green;
  dev API restarted on the cut — boots clean, transient routes 404.

**P8 unblocked:** zero `PtySession` constructors remain in `apps/server` → Step 6 (delete
`PtySession`, banner-regex, file-watching) is a pure @pc/runtime deletion pass.

## Open / deferred

- Workflow review depth: read-the-graph + revise-by-chat is the v1 (Emerson 2026-06-04);
  human drag-edit + publish on the Workflows page rides M6.
- Builder edit-mode needs the current def: verify `pc_list_workflows` exposes it (or grant a
  read door) at build time.
- First-run wizard (install/sign-in/first project) untouched — FD-21 keeps it.
