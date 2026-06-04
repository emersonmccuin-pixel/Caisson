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

### C — Live-verify (gate before P7)

- Chat: "I want a workflow that …" → interview → dispatch → published row visible on Workflows
  tab → ask for a change → re-dispatch → row updated.
- Chat: "make me an agent that …" → dispatch → pod on Agents tab.
- Chat: setup ask on a CLAUDE.md-less project → file written, nag clears.
- Manual: name → disabled skeleton → YAML tab edit → enable.

### D — P7: the deletion (FD-21, separate commits)

Server: transient-sessions routes + project-runtime transient block (763–1072) +
`pc_save_workflow_draft`/`pc_read_workflow_draft` (registry + handlers + draft store) +
golden regen. Web: `WorkflowBuilderModal`, `WorkflowBuilderChat`, `AgentDesignerChat`,
`TransientAgentConversation`, `SetupWizardModal`, `features/transient-sessions/*`.
Banned-resurrection gate entries. Docs sweep: `transient-sessions-modals.md` ☠ tombstone ·
ledger §4/§6 row 7 · sequencing P7 · this doc's as-built.

**P8 unblocked after D:** remaining `PtySession` callers should be zero → Step 6 (delete
`PtySession`, banner-regex, file-watching) becomes a pure deletion pass.

## Open / deferred

- Workflow review depth: read-the-graph + revise-by-chat is the v1 (Emerson 2026-06-04);
  human drag-edit + publish on the Workflows page rides M6.
- Builder edit-mode needs the current def: verify `pc_list_workflows` exposes it (or grant a
  read door) at build time.
- First-run wizard (install/sign-in/first project) untouched — FD-21 keeps it.
