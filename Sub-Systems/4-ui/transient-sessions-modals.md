# Transient Sessions & Modals

> **Role:** Brain (today) → Engine (north star, Step 5)
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> - `apps/server/src/services/project-runtime.ts` — spawn + lifecycle (lines 763–1072)
> - `apps/server/src/features/transient-sessions/routes.ts` — HTTP + WS wiring
> - `packages/runtime/src/pty-session.ts` — PtySession (the session primitive)
> - `apps/web/src/features/transient-sessions/events.ts` — envelope adapter
> - `apps/web/src/features/transient-sessions/client.ts` — frontend HTTP calls
> - `apps/web/src/components/WorkflowBuilderModal.tsx` — workflow-builder modal
> - `apps/web/src/components/SetupWizardModal.tsx` — setup-wizard modal
> - `apps/web/src/components/agents/CreatePodModal.tsx` — agent-designer host modal
> - `apps/web/src/components/agents/AgentDesignerChat.tsx` — agent-designer chat surface
> - `apps/web/src/components/WorkflowBuilderChat.tsx` — workflow-builder chat surface
> - `apps/web/src/components/TransientAgentConversation.tsx` — shared chat wrapper

## What it is (plain English)

Three short-lived Claude sessions that run inside UI modals: one for designing an agent by conversation, one for building a workflow by interview, and one for writing a project's `CLAUDE.md` via a guided wizard. Each spawns its own `claude.exe` process behind the scenes, streams its chat into the modal while the user types, and is thrown away when the modal closes. They feel like a live chat window that opens, does one job, and disappears.

Note: `AgentTranscriptModal` is NOT a transient session — it is a read-only view of a dispatched agent run's JSONL. It has no PtySession; it does not belong to this subsystem.

## What it's supposed to do (intent)

Give users a conversational interface for authoring tasks that are too complex for a form but don't need a full persistent session — design an agent pod, build a workflow graph, or answer setup questions. Each modal is its own isolated Claude session with a curated tool allowlist, runs only while open, and leaves no durable session row.

## How it works today (as-built)

### The three modals

| Modal | Claude pod | Purpose | WS prefix |
|---|---|---|---|
| Agent-designer | `agent-designer` stock pod | Design a new agent by chat | `agent-designer-*` |
| Workflow-builder | `workflow-builder` stock pod | Author a v2 workflow by interview + live graph | `workflow-builder-*` |
| Setup wizard | CC default + `--append-system-prompt-file setup-wizard-prompt.md` | Writes `CLAUDE.md` for the project | `setup-wizard-*` |

### Server side: ProjectRuntime owns the PtySession

`ProjectRuntime` holds one `PtySession | null` per modal type (`agentDesigner`, `workflowBuilder`, `setupWizard`). All three spawn through `PtySession` (not through `AgentRun` / the Engine). (`project-runtime.ts:108–119`)

**Start sequence (agent-designer and workflow-builder):**
1. `startAgentDesigner()` / `startWorkflowBuilder()` kills any prior session, then calls `preparePodSpawn(agentName)` which materialises the pod row's prompt, tools, and MCP allowlist into a temp session-local directory. (`project-runtime.ts:763–811`, `:905–953`)
2. Calls `transientCcSession()` to mint a fresh CC session UUID and compute the deterministic JSONL path (`jsonlPathFor(folderPath, ccSessionId)` — resolves to `~/.claude/projects/<cwd-hash>/<uuid>.jsonl`). (`project-runtime.ts:825–831`)
3. Constructs a `PtySession` with `claudeSessionId: cc.ccSessionId`, `resume: false`, `jsonlPath: cc.jsonlPath`, and `--agent <podName>` (replaces CC's default identity). The `PC_SESSION_ID` env var is set to the `ad-`/`wb-`/`sw-` prefixed transient id that names the on-disk session directory. (`project-runtime.ts:792–808`, `:934–951`)
4. Returns the `PtySession` object (does NOT call `.start()` here — start happens inside `PtySession`'s constructor via internal spawn).

**Setup wizard** mirrors steps 2–3 but uses `prepareClaudeRuntimeFiles` (no pod spawn) and `--append-system-prompt-file` instead of `--agent`. (`project-runtime.ts:994–1043`)

### WS wiring (routes)

`registerTransientSessionRoutes` registers `start`, `send`, `interrupt`, `terminal-input`, `resize`, and `DELETE` (end) routes for all three modals. (`routes.ts:209–252`)

On `start`, `attachTransientSessionHandlers` wires `PtySession` events (`raw`, `state`, `event`, `jsonl-event`, `exit`) to `broadcastTo(projectId, ...)` envelopes prefixed with the modal's wire prefix (e.g. `agent-designer-raw`, `agent-designer-state`, `agent-designer-jsonl`). (`routes.ts:65–117`)

The `start` HTTP response returns `{ ok, state, sessionId }` where `sessionId` is the `PC_SESSION_ID` (the `ad-`/`wb-`/`sw-` prefixed id, NOT the CC session UUID). (`routes.ts:129–149`)

### Client side: modal lifecycle

Each modal's React component calls `transientSessionsApi.start*()` in a `useEffect` on mount and `stop*()` on unmount cleanup. (`SetupWizardModal.tsx:41–65`, `WorkflowBuilderModal.tsx:101–127`)

**Start-race fix** (`mergeTransientSessionState`): The start HTTP response may arrive AFTER a WS `*-state` envelope has already advanced the state. If the response naively called `setState(r.state)` it would overwrite the newer state back to `spawning`. Instead it uses `mergeTransientSessionState(prev, next)` which ignores a `next === 'spawning'` if `prev` has already moved forward. (`events.ts:102–108`)

The `sessionId` is set from the HTTP response via `setSessionId(r.sessionId)` — deliberately separate from the state update so the session identity is locked in before state advances. (`SetupWizardModal.tsx:50`, `WorkflowBuilderModal.tsx:112`)

### Chat streaming: envelope adapter → ChatSurface

Raw WS envelopes (`workflow-builder-jsonl`, etc.) go into the project-level events array. Each modal's chat component calls `adaptTransientEvents(events, prefix)` to translate them into the standard shapes `ChatSurface` understands: `{type:'jsonl', event}`, `{type:'state', state}`, `{type:'raw', ...}`. (`events.ts:23–86`)

`adaptTransientEvents` filters by `sessionId` (via `belongsToTransientSession`) so a session started before the sessionId resolved doesn't leak into the chat. (`events.ts:38–44`)

Both `AgentDesignerChat` and `WorkflowBuilderChat` pass `hiddenUserText` to drop the MCP warmup turn pair (`reply with only the word ok`) from the rendered conversation so users never see it. (`AgentDesignerChat.tsx:55–57`, `WorkflowBuilderChat.tsx:74–77`)

The adapted envelopes feed `TransientAgentConversation` → `ChatSurface`, the same surface used by the orchestrator chat. (`TransientAgentConversation.tsx:72–90`)

### Workflow-builder extras

- Two-pane layout: chat (~64%) + live `WorkflowGraphV2` visualizer (~36%). (`WorkflowBuilderModal.tsx:243–263`)
- Agent calls `pc_save_workflow_draft` during the interview; server stores the draft in `workflowBuilderDrafts: Map<sessionId, WorkflowV2.Workflow>` and broadcasts `workflow-builder-draft` WS envelope. Frontend syncs it to `draftDef` for the visualizer. (`project-runtime.ts:884–899`, `WorkflowBuilderModal.tsx:158–164`)
- User can drag nodes; frontend calls `saveWorkflowBuilderDraft(projectId, sessionId, nextDef)` to write changes back so the agent picks them up via `pc_read_workflow_draft`. (`WorkflowBuilderModal.tsx:193–199`)
- Edit mode: `WorkflowBuilderModal` sends a `[edit-mode workflowId="…"]` first message once the session reaches `ready`; `WorkflowBuilderChat` drops this message from the rendered chat. (`WorkflowBuilderModal.tsx:62–72`, `:130–142`)
- Close trigger: modal closes on a `workflow-definition` live event matching the published slug. (`WorkflowBuilderModal.tsx:172–188`)

### Setup wizard extras

- Close trigger: auto-closes when the live entity signature for `project-claude-md` changes (i.e. when `CLAUDE.md` gets written), comparing against a baseline captured at mount. (`SetupWizardModal.tsx:92–104`)

### State machine

`TransientSessionState` = `'spawning' | 'ready' | 'thinking' | 'exited'`. (`events.ts:3`) Driven by `*-state` WS envelopes. There is no DB row; state lives only in the React component and the runtime's `PtySession`.

## Integrations (how it connects)

- **Depends on:**
  - `PtySession` (`packages/runtime/src/pty-session.ts`) — the PTY/spawn/JSONL-tailer primitive
  - `preparePodSpawn` (`apps/server/src/services/pod-spawn.ts`) — materialises the pod's prompt, tools, mcp.json into a temp dir
  - `prepareClaudeRuntimeFiles` (`apps/server/src/services/claude-runtime-bundle.ts`) — used by setup wizard
  - `jsonlPathFor` (`packages/runtime/src/path-resolver.ts`) — deterministic CC JSONL path
  - `ChatSurface` (`apps/web/src/features/chat/ChatSurface.tsx`) — the shared chat render surface
  - `WorkflowGraphV2` — the workflow visualizer (workflow-builder only)
- **Used by:**
  - `CreatePodModal` — hosts the agent-designer chat tab
  - `WorkflowBuilderModal` — the workflow authoring surface
  - `SetupWizardModal` — the project onboarding wizard
  - All three are opened from the main UI (agent creation, new workflow, first-run setup)
- **Contracts / events crossed:**
  - WS broadcast envelopes: `{prefix}-raw`, `{prefix}-state`, `{prefix}-event`, `{prefix}-jsonl`, `{prefix}-exit`, `workflow-builder-draft`
  - HTTP REST: `POST /start`, `POST /send`, `POST /interrupt`, `POST /terminal-input`, `POST /resize`, `DELETE /`
  - `PC_SESSION_ID` env var (set in `extraEnv`) — scopes hook writes and ask-intercept routing
  - `ask-intercept.cjs` hook uses `PC_SESSION_ID` to tag outbound `ask` envelopes so session filtering works (`templates/.claude/hooks/ask-intercept.cjs:28–30`)

## Target shape (per north star)

**Ledger verdict:** `MERGE→Engine` (Step 5), HIGH confidence. (`consolidation-ledger-2026-06-02.md §2`)

Today `ProjectRuntime` (Brain) owns these `PtySession` instances — the same structural problem as the orchestrator owning its own Claude process. The target moves them to the Engine with policy `{ephemeral, streaming}`: same primitive as an agent run, just a different policy record, no separate class.

What changes:
- Brain calls the Engine to start a modal session (like it calls Engine for dispatched agents). Engine owns the `claude.exe`.
- `PtySession` and `SessionState`/`terminalBufferLooksReady` are deleted in Step 6 after both orchestrator (Step 4) and modals (Step 5) have migrated.
- Deterministic `ccSessionId` still needs to be threaded through `AgentHostStartRunRequest` — the bleed-through guard that was added for `PtySession` must carry over.
- The `PtySession` file-watching (stop-marker + events file) dies with the migration. (`consolidation-ledger-2026-06-02.md §2, Transcript reading`)

**Prerequisite:** Step 3 (Engine endpoint re-resolution + reattach) must land before Steps 4–5, or an Engine respawn silently severs modal sessions. (`unified-process-supervision-2026-06-02.md §9 step ordering`)

**Phase-0 plan row:** Item 7 in `consolidation-ledger-2026-06-02.md §6`.

## Known issues / scar tissue

1. **JSONL bleed-through** — without a deterministic `--session-id`, `PtySession` fell back to a directory scan (`~/.claude/projects/<cwd-hash>/`) and latched onto the newest `.jsonl` by mtime, which could be a sibling VS Code claude.exe session writing into the same project folder. Fix: `transientCcSession()` mints a UUID, passes `--session-id`, and uses `jsonlPathFor` to produce the exact path CC will write to (`project-runtime.ts:825–831`). Fixed in commit `b33e37b`.

2. **Start-race ("Starting…" forever)** — the HTTP `start` response returns before the first WS `*-state` envelope if the session reaches `ready` very quickly. Naively doing `setState(r.state)` in the `.then()` overwrites a `ready` back to `spawning`. Fix: `mergeTransientSessionState` refuses to regress (`events.ts:102–108`). Also: `setSessionId` is called separately from `setState` so the session identity is locked in regardless of state ordering.

3. **React Strict Mode double-invoke teardown** — in dev, React 18 double-invokes `useEffect` mount + cleanup. Putting `stopAgentDesigner` in `useEffect` cleanup killed the freshly-spawned claude.exe ~50ms after creation, producing a 16-byte silent transcript. Fix: cleanup is in the explicit `handleClose()` handler, NOT in `useEffect` cleanup (`CreatePodModal.tsx:97–106`). Same pattern in `WorkflowBuilderChat.tsx` comment.

4. **Banner cursor-escape regex** — claude.exe v2+ renders banner words with `\x1b[1C` cursor-right escapes instead of spaces. After `stripAnsi`, `"Welcome back"` becomes `"Welcomeback"`. `terminalBufferLooksReady` uses `\s*` between words to absorb both renderings. (`pty-session.ts:79–91`). This function is marked `DELETE` in Step 6 (dies with PtySession after migration).

5. **Modal auto-open state backfill** (unverified live in all three modals) — modals that auto-open on a WS broadcast must backfill state from the events history at mount; cursor-snap-to-end skips the triggering envelope. `SetupWizardModal` scans `events.slice(processedRef.current)` in a second `useEffect` to catch state and exit envelopes that arrived before the component mounted. The agent-designer pattern (in `CreatePodModal`) is manual start (not auto-open), so this race is less likely there.

6. **Dead-event-stream post-23.4** (scar tissue, partially resolved) — prior to the JSONL migration, transient modal chat was driven by the `'event'`/`*-creator-event` hook channel. Post-23 those channels no longer emit chat events; the fix was to migrate modals to `*-jsonl` envelopes + `ChatSurface` adapter. The agent-designer and workflow-builder are on the correct path; verify the setup wizard similarly uses `*-jsonl` (it does: `adaptTransientEvents` with `prefix: 'setup-wizard'`).

7. **One per project, not one per user** — `ProjectRuntime` holds exactly one of each modal session. Starting a second agent-designer kills the first (`endAgentDesigner()` in `startAgentDesigner()`). Not a bug, but a constraint: two browser tabs on the same project share one transient session.

## Open questions

- Does the Engine's `AgentRun` primitive need new policy flags (`ephemeral`, `streaming`) before Step 5, or can the existing one-shot flags be reused with small tweaks? The orchestrator migration (Step 4) is the validation gate.
- Does `ccSessionId` need to be threaded through `AgentHostStartRunRequest` for bleed-through prevention, or does the Engine already mint deterministic session ids on the host side?
- After Step 5, does the `workflow-builder-draft` store (currently in `ProjectRuntime`) need to move to the Brain/Store, or can it stay as an in-process Brain-side map keyed by `sessionId`?
- Setup wizard uses `--append-system-prompt-file` (no pod spawn). After migration, does this need a pod row, or can the Engine accept an arbitrary append-prompt path in its session policy?
