# Transient Sessions & Modals

> **Role:** Brain (today) → Engine (north star, Step 5)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> `apps/server/src/services/project-runtime.ts` (lines 763–1072) · `apps/server/src/features/transient-sessions/routes.ts` · `packages/runtime/src/pty-session.ts` · `apps/web/src/features/transient-sessions/events.ts` · `apps/web/src/features/transient-sessions/client.ts` · `apps/web/src/components/WorkflowBuilderModal.tsx` · `apps/web/src/components/SetupWizardModal.tsx` · `apps/web/src/components/agents/CreatePodModal.tsx` · `apps/web/src/components/agents/AgentDesignerChat.tsx` · `apps/web/src/components/WorkflowBuilderChat.tsx` · `apps/web/src/components/TransientAgentConversation.tsx`

---

## What it is (plain English)

Three short-lived Claude chat windows that open inside popups (modals): one for designing an agent by conversation, one for building a workflow by interview, and one for writing a project's setup file via a guided wizard. Each one starts its own Claude process, streams the conversation live into the popup while you type, and disappears completely when you close it. Think of them as pop-up consultants — they show up, do one specific job, and leave no trace behind.

> **Not in this group:** `AgentTranscriptModal` — that's a read-only view of a finished agent run's log. It has no live process. It doesn't belong here.

---

## What it's supposed to do (intent)

Give you a conversational way to author things that are too rich for a form but don't need a permanent session: design an agent pod, build a workflow graph, or answer setup questions. Each popup is its own isolated Claude session with a curated set of tools, runs only while open, and leaves no saved session row in the database.

---

## The parts (every component, plain English)

### 1. The three modals

| Popup | Which Claude "personality" | Job | Internal label |
|---|---|---|---|
| **Agent designer** | `agent-designer` stock pod | Design a new agent by chatting through its purpose, tools, and behavior | `agent-designer-*` |
| **Workflow builder** | `workflow-builder` stock pod | Author a workflow by interview + live graph preview | `workflow-builder-*` |
| **Setup wizard** | Claude's default + an appended instructions file | Writes the project's `CLAUDE.md` setup file | `setup-wizard-*` |

### 2. How a session starts — and why the session ID matters

When you open one of these popups, the server doesn't just launch a Claude process blindly. It first **mints a specific session ID** and tells Claude "use this exact ID." That matters because Claude writes its conversation history to a file on disk, and without a pinned ID the system would fall back to scanning a folder and grabbing whatever file was most recently touched — which could be **the conversation from a completely different Claude window** (a VS Code session, for instance). That chat would then bleed into your popup. The pinned ID prevents that entirely. (`project-runtime.ts:825–831`)

**Start sequence (agent designer and workflow builder):**
1. Kills any existing session of the same type (only one per project at a time).
2. Reads the pod's settings (prompt, allowed tools, MCP config) and writes them to a temporary local folder — `preparePodSpawn()`. (`project-runtime.ts:763–811`, `:905–953`)
3. Mints a fresh session UUID and computes the exact file path Claude will write its conversation to — `transientCcSession()`, `jsonlPathFor()`. (`project-runtime.ts:825–831`)
4. Launches Claude with `--agent <podName>` (which replaces Claude's default personality entirely) and the minted session ID. Sets `PC_SESSION_ID` in the process environment so hook scripts can tag their writes to this session.
5. Returns to the frontend with the session's identity — does NOT separately call `.start()`; the process is already running.

**Setup wizard** follows the same pattern but uses `prepareClaudeRuntimeFiles` (no pod definition needed) and `--append-system-prompt-file` instead of `--agent`. (`project-runtime.ts:994–1043`)

### 3. How the chat streams to the popup

Claude's output travels over a WebSocket connection (a persistent live channel) as **envelopes** — small labeled packets. Each modal type has its own prefix so packets don't mix:

- `agent-designer-raw`, `agent-designer-state`, `agent-designer-jsonl`, `agent-designer-exit`
- Same pattern for `workflow-builder-*` and `setup-wizard-*`

On the frontend, `adaptTransientEvents()` filters the project-wide event stream down to envelopes for this session only (using the session ID to exclude anything that arrived before the ID was resolved), then translates them into the standard shapes the shared `ChatSurface` component understands. The chat renderer is the **same component** used by the main orchestrator chat — no bespoke renderer. (`events.ts:23–86`)

One cosmetic touch: both agent-designer and workflow-builder chat components hide the MCP warmup message pair (`reply with only the word ok` / `ok`) so it never appears in the conversation. (`AgentDesignerChat.tsx:55–57`, `WorkflowBuilderChat.tsx:74–77`)

### 4. State the session can be in

`'spawning' → 'ready' → 'thinking' → 'exited'`

Driven entirely by `*-state` WebSocket envelopes — there is no database row. State lives only in the React component and in the server's in-memory `PtySession` handle. (`events.ts:3`)

### 5. Workflow-builder extras

The workflow builder has a second pane alongside the chat: a live graph preview that updates as the agent authors the workflow.

- **Two-pane layout:** chat (~64%) + graph (~36%). (`WorkflowBuilderModal.tsx:243–263`)
- **Draft sync:** the agent calls `pc_save_workflow_draft` mid-interview; the server stores the draft in memory and broadcasts a `workflow-builder-draft` envelope; the frontend feeds it to the graph. (`project-runtime.ts:884–899`, `WorkflowBuilderModal.tsx:158–164`)
- **You can drag nodes:** the frontend writes changes back via `saveWorkflowBuilderDraft` so the agent can read them with `pc_read_workflow_draft`. (`WorkflowBuilderModal.tsx:193–199`)
- **Edit-mode first message:** when opened for an existing workflow, the modal sends a hidden `[edit-mode workflowId="…"]` message once the session is ready; the chat component drops it from the rendered view. (`WorkflowBuilderModal.tsx:62–72`, `:130–142`)
- **Auto-close:** the modal closes itself when a `workflow-definition` live event arrives with the matching published slug. (`WorkflowBuilderModal.tsx:172–188`)

### 6. Setup wizard extras

- **Auto-close:** closes when it detects that the project's `CLAUDE.md` file has been written — it captures a baseline signature at mount and watches for it to change. (`SetupWizardModal.tsx:92–104`)

### 7. Session teardown

Each modal calls `stop*()` in its explicit close handler (not in React's cleanup hook — see scar tissue below). The server kills the Claude process, cleans up the temp folder, and that's it. No database row to clean up.

---

## How it connects

- **Depends on:** `PtySession` (the process/PTY/JSONL-tailer primitive) · `preparePodSpawn` (writes the temp session files) · `prepareClaudeRuntimeFiles` (setup wizard path) · `jsonlPathFor` (deterministic JSONL path) · `ChatSurface` (the shared chat renderer) · `WorkflowGraphV2` (workflow builder only)
- **Used by:** `CreatePodModal` (hosts the agent-designer tab) · `WorkflowBuilderModal` · `SetupWizardModal` — all opened from the main UI
- **Contracts crossed:** WS envelopes (`{prefix}-raw/state/event/jsonl/exit`, `workflow-builder-draft`) · HTTP (`POST /start`, `POST /send`, `POST /interrupt`, `DELETE /`) · `PC_SESSION_ID` env var (hooks use it to tag `ask` envelopes so session routing works — `templates/.claude/hooks/ask-intercept.cjs:28–30`)

---

## Target shape (per north star + Foundation Decisions)

**Ledger verdict:** `MERGE→Engine` (Step 5), HIGH confidence. (`consolidation-ledger-2026-06-02.md §2`)

Today `ProjectRuntime` (Brain) owns these `PtySession` instances directly — the same structural problem as the orchestrator owning its own Claude process. The target moves them to the Engine with a policy of `{ephemeral, streaming}`: the same underlying primitive as an agent run, differentiated only by the policy record, no separate class needed.

**What changes in the migration:**
- Brain calls the Engine to start a modal session, the same way it calls the Engine for dispatched agents. The Engine owns the `claude.exe`.
- The deterministic `ccSessionId` (the bleed-through guard) must be threaded through `AgentHostStartRunRequest` — the guard that was added for `PtySession` must carry over.
- `PtySession` and its `terminalBufferLooksReady` banner-detection function are **deleted** in Step 6 (after both the orchestrator in Step 4 and modals in Step 5 have migrated). The JSONL file-watching dies with them.
- **Prerequisite:** Step 3 (Engine endpoint re-resolution + reattach) must land first, or an Engine respawn silently severs modal sessions mid-conversation. (`unified-process-supervision-2026-06-02.md §9`)
- **Phase-0 plan row:** Item 7 in `consolidation-ledger-2026-06-02.md §6`.

---

## Known issues / scar tissue

1. **JSONL bleed-through (FIXED — commit `b33e37b`).** Without a pinned session ID, the system scanned `~/.claude/projects/<cwd-hash>/` and grabbed the newest `.jsonl` by file-modification time. If a VS Code Claude window was open in the same project folder, its conversation bled into the modal. Fix: `transientCcSession()` mints a UUID and `jsonlPathFor()` computes the exact file path. (`project-runtime.ts:825–831`)

2. **"Starting…" forever — the start-race (FIXED).** The HTTP `start` response can arrive *after* a WebSocket `*-state` envelope has already advanced the session to `ready`. Naively writing `setState(r.state)` in the response handler overwrote a `ready` back to `spawning` — the modal appeared stuck loading. Fix: `mergeTransientSessionState` refuses to go backward; `setSessionId` is called separately from `setState` so identity is locked in regardless of ordering. (`events.ts:102–108`, `SetupWizardModal.tsx:50`, `WorkflowBuilderModal.tsx:112`)

3. **React Strict Mode kills the session at birth (FIXED).** In development, React 18 double-invokes every `useEffect` mount + cleanup. Placing `stopAgentDesigner` in a `useEffect` cleanup killed the freshly-spawned Claude process ~50ms after creation, producing a silent 16-byte transcript. Fix: teardown is in the explicit `handleClose()` handler, NOT in `useEffect` cleanup. (`CreatePodModal.tsx:97–106`, `WorkflowBuilderChat.tsx` comment)

4. **Banner cursor-escape regex.** Claude v2+ renders banner words using `\x1b[1C` cursor-right escape sequences instead of spaces. After stripping escape codes, `"Welcome back"` becomes `"Welcomeback"`. The `terminalBufferLooksReady` function uses `\s*` between words to absorb both renderings. (`pty-session.ts:79–91`) This function is marked for deletion in Step 6 when `PtySession` is removed.

5. **Modal auto-open state backfill** (unverified across all three). Modals that open automatically in response to a WS broadcast must scan the event history at mount — the event that triggered the open may have already scrolled past the cursor. `SetupWizardModal` handles this by scanning `events.slice(processedRef.current)` in a second `useEffect`. The agent-designer opens manually (not on broadcast), so this race is less likely there. (`SetupWizardModal.tsx:92–104`)

6. **Dead-event-stream post-23.4 (partially resolved).** Before the JSONL migration, modal chat was driven by the `'event'`/`*-creator-event` hook channel. Post-23, that channel stopped emitting chat events. The fix was to migrate to `*-jsonl` envelopes + `ChatSurface`. Agent-designer and workflow-builder are on the correct path. Setup wizard also uses `adaptTransientEvents` with `prefix: 'setup-wizard'`, so it should be correct too — but this wasn't independently re-verified.

7. **One session per project, not per user.** `ProjectRuntime` holds exactly one of each modal type. Opening the agent-designer in a second browser tab on the same project kills the first session. Not a bug — a deliberate constraint — but worth knowing if you're testing.

---

## Decisions & open questions

**For Emerson (product calls):**
- **One modal per project is a real constraint.** Today two tabs on the same project share one agent-designer session — opening a second kills the first. Is that acceptable long-term, or should sessions eventually be per-user?

**Technical:**
- Does the Engine's `AgentRun` primitive need new policy flags (`ephemeral`, `streaming`) before Step 5, or can the existing flags be reused with small tweaks? The orchestrator migration (Step 4) is the validation gate.
- Does `ccSessionId` need to be threaded through `AgentHostStartRunRequest` for bleed-through prevention, or does the Engine already mint deterministic session IDs on the host side?
- After Step 5, does the `workflow-builder-draft` store (currently an in-memory map in `ProjectRuntime`) need to move to Brain/Store, or can it stay as a Brain-side map keyed by `sessionId`?
- Setup wizard uses `--append-system-prompt-file` (no pod spawn). After migration, does this need a pod row, or can the Engine accept an arbitrary append-prompt path in its session policy?
