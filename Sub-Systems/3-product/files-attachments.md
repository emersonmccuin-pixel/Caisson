# Files & Attachments

> **Role:** UI / Store / cross-cutting
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> `apps/server/src/features/files/routes.ts` · `apps/server/src/services/files-tree.ts` · `fs-browse.ts` · `fs-probe.ts` · `memory-files.ts` · `attachment.ts`
> `packages/db/src/repos/attachments.ts` · `schema.ts` (`attachments` table) · `packages/domain/src/attachment.ts`
> `apps/web/src/components/FilesRail.tsx` · `FilesViewer.tsx` · `AttachmentLightbox.tsx` · `FolderBrowserModal.tsx`

---

## What it is (plain English)

Four related surfaces that all live under the "files" umbrella, doing different jobs:

1. **File browsing** — a read-only window into the project folder on disk so the user can see and preview their files without leaving the app.
2. **Attachments** — documents, images, or text snippets produced by agents or typed by the user, stored permanently inside the app's database and tied to a work item.
3. **Memory files** — a thin edit surface for the `CLAUDE.md` instruction files that control how Claude Code behaves (at user, project, and workspace scope).
4. **Folder picker** — the directory browser used when creating a project or changing the app's root folder.

---

## What it's supposed to do (intent)

- **File browsing:** give the user a read-only view of their project folder without leaving the app. Eventually useful for agents too.
- **Attachments:** store artifacts durably — they survive restarts, persist across sessions, and can be handed back to agents. **Content always lives inline in the database; there is no filesystem path variant.** This is a locked architectural decision.
- **Memory files:** let the user read and edit `CLAUDE.md` instruction files from the app's UI.
- **Folder picker:** let the user navigate to and select a directory on their machine when setting up a project.

---

## The parts (every component, plain English)

### 1. Browsing the project's files

The file tree walks the project's root folder on disk and shows a sorted directory listing in the left rail.

Two layers of filtering keep noise out:
- A hardcoded skip list (`HARD_SKIP_DIRS` — `node_modules`, `dist`, `.git`, `data`, etc.) drops directories that are never useful to browse. (`files-tree.ts:11`)
- The project's own `.gitignore` rules are applied via the `ignore` npm package, so anything git ignores is hidden here too.

The result is sorted: folders before files, then alphabetically within each group. Each entry carries its name, path, kind, and file size.

**Previewing a file** reads its content and classifies it into one of six kinds: `markdown`, `html`, `image`, `text`, `binary`, or `oversized`. Hard cap is 1 MB — files above that return `kind: 'oversized'` without reading their content. (`files-tree.ts:27, 147`) Images come back as base64 data URIs. Binary detection sniffs the first 8 KB for a NUL byte.

The UI for this is **`FilesRail.tsx`** (the left-rail tree) and **`FilesViewer.tsx`** (the center panel). The viewer renders each kind differently — Markdown gets rendered, HTML goes in a sandboxed iframe, images as `<img>`, text as `<pre>`. Expand state in the tree is local and resets on project switch. A "Show hidden" toggle reveals dot-prefixed entries.

### 2. Previewing an attachment (the lightbox)

Attachments tied to work items can be opened full-screen via **`AttachmentLightbox.tsx`**, which mounts at the Shell level so it can open from anywhere in the app (including clicking a `pc://attachment/<id>` rich link in chat). It fetches the attachment by ID and renders images as `<img>` or everything else as `<pre>`. Provides Download (constructs a Blob from the content) and "View parent work item" actions.

### 3. Attachments (stored inside the database, never as file paths)

An attachment is any text or binary payload — a draft, an image, a report — produced by an agent or added by the user, permanently tied to a work item.

**How they're stored:** the `attachments` table in SQLite has a `content` column that holds the payload inline as text. The schema comment explicitly says: *"No filesystem-path variant — content always lives in the DB."* (`schema.ts:499`) There is no `path` column and no file-system write anywhere in the create path. Binary content is stored as base64 with a `contentType` field. This is a locked decision — keep it stated.

**CRUD:** four operations — list, get, create, delete. Delete is permanent (hard-delete only; no soft-delete/restore). (`repos/attachments.ts`)

**Project scope guard:** every operation checks that the work item belongs to the current project before touching the attachment. (`attachment.ts:136`)

**Live updates:** when an attachment is created or deleted, a `AttachmentChangedLiveEvent` is written to `live_outbox` and fanned out to the UI. The full `AttachmentDto` (including content) is carried on create; the delete event omits content. (`packages/contracts/src/attachments.ts`)

**Agents create attachments** via the `pc_attach_to_work_item` MCP tool, which routes through the same `AttachmentService`.

### 4. Memory files (the CLAUDE.md surface)

The memory-file service reads and writes the `CLAUDE.md` instruction files that tell Claude Code how to behave. Three scopes:

| Scope | File location |
|---|---|
| `user` | `~/.claude/CLAUDE.md` |
| `project` | `<projectFolder>/CLAUDE.md` |
| `workspace` | `<parentOfProjectFolder>/CLAUDE.md` |

Reads and writes are simple synchronous file operations. Write creates the directory if it doesn't exist yet. (`memory-files.ts`)

Where the HTTP routes for this surface are registered is **not confirmed** — the route wiring was not found in this pass. (unverified)

### 5. The folder picker

**`FolderBrowserModal.tsx`** is the directory browser used in Create Project and App Settings. It drills one directory at a time, persisting the last-browsed path in `localStorage` under key `pc.last-browse-dir`. On Windows it shows drive-letter jump buttons. Supports creating a new subfolder inline.

Two access modes:
- **Unrestricted** (App Settings root folder) — can roam anywhere on disk.
- **Gated** (Create Project) — restricted to paths inside the configured `projectsFolder`; requests outside that root are 403'd.

Before the user commits to a folder, **`probeFolder`** (`fs-probe.ts:32`) does a one-shot stat: returns whether the path exists, is a directory, has files, is a git repo, has a Caisson scaffold, and has an `mcp.json`. The Create Project modal uses this to classify the chosen location before proceeding.

---

## How it connects

- **Depends on:** SQLite / `@pc/db` (attachment storage + live-outbox writes) · Node `fs`/`path` (disk reads for file tree + memory files) · `ignore` npm package (`.gitignore` parsing) · `live_outbox` relay (attachment change events).
- **Used by:** Work Items feature (attachments on items; lightbox from chat rich links) · Workflow engine / MCP (`pc_attach_to_work_item` writes through `AttachmentService`) · Create Project modal (folder picker + probe) · App Settings modal (folder picker for `projectsFolder`) · Memory drawer in the UI (reads/writes `CLAUDE.md` files).
- **Contracts / events crossed:** `AttachmentChangedLiveEvent` (`packages/contracts/src/attachments.ts`) — the live WebSocket event the UI subscribes to for list refresh. `AttachmentDto` — the over-the-wire shape; carries inline `content`.

---

## Target shape (per north star + Foundation Decisions)

The consolidation ledger has no verdict row for file-browsing or memory files — both are UI-support services with no process-ownership concerns, already in the right place, and require no migration.

For attachments, two ledger items apply:

- **`live_outbox` as the one notify door:** `AttachmentService` already writes to `live_outbox` + the relay fans it to the UI. The legacy bare `broadcast` call alongside it is an explicit Phase A dual-write. Phase C removes the bare broadcast, leaving `live_outbox` → relay as the sole fanout. (`attachment.ts:112–113, 125`)
- **DB is the source of truth:** already true — content is inline, no filesystem variant.

No rename, merge, or rebuild is needed for this subsystem. Only pending work is the Phase C removal of the bare `broadcast` in `AttachmentService`.

---

## Known issues / scar tissue

- **`startsWith` path containment — the documented safe pattern isn't used.** Both `previewFile` (`files-tree.ts:156`) and the folder-browser's `isInsideAnyRoot` (`fs-browse.ts:149`) use `startsWith(root + sep)` to check that a requested path stays inside the allowed root. The `+ sep` suffix blocks the classic sibling-prefix bypass (`/foo` escaping to `/foobar/…`), so the current code isn't exploitable in practice — but it diverges from the safer pattern recorded in project memory. A future edit that drops the `sep` suffix would reopen the hole. The correct pattern: `const rel = path.relative(root, candidate); return !rel.startsWith('..') && !path.isAbsolute(rel)`.

- **Dual broadcast in `AttachmentService` (Phase A debt).** Create and delete both fire `announceAttachment` (the durable `live_outbox` write) AND `this.opts.broadcast(...)` (legacy bare WebSocket broadcast). Two paths doing the same job; causes duplicate UI updates until Phase C removes the bare broadcast. (`attachment.ts:112–113, 125`)

- **Lightbox backdrop-click closes the modal.** `AttachmentLightbox.tsx:79` has an `onClick` on the backdrop that calls `close()`. Project memory (`reference_modals_explicit_close_only`) says implicit-close via backdrop is considered destructive. The lightbox is read-only so actual data loss is low — but it contradicts the stated rule.

- **Memory-file write is synchronous and blocks the server.** `writeFileSync` in `memory-files.ts:47` runs on the API thread. For normal `CLAUDE.md` sizes this is fine; a large write would stall the server event loop.

---

## Decisions & open questions

**For Emerson (product calls):**
1. **Can an attachment be edited after it's created?** Today delete is the only mutation — there's no update operation. Is that right for the product?
2. **Should the lightbox close on backdrop click?** It contradicts the "explicit close only" rule. Low stakes because it's read-only, but worth confirming either way.

**Technical:**
- Where are the memory-file HTTP routes registered? Not located in this pass. (unverified)
- Should `previewFile` and `isInsideAnyRoot` migrate to `path.relative` containment? Low urgency but would eliminate the documented divergence.
- Phase C timing for removing the bare `broadcast` from `AttachmentService` — no scheduled slot in the current ledger Phase-0 plan.
