# Files & Attachments

> **Role:** UI / Store / cross-cutting
> **Status:** as-built snapshot — 2026-06-03
> **Code anchors:**
> `apps/server/src/services/files-tree.ts`,
> `apps/server/src/services/fs-browse.ts`,
> `apps/server/src/services/fs-probe.ts`,
> `apps/server/src/services/memory-files.ts`,
> `apps/server/src/services/attachment.ts`,
> `apps/server/src/features/files/routes.ts`,
> `apps/server/src/features/work-items/routes.ts` (attachment CRUD),
> `packages/db/src/repos/attachments.ts`,
> `packages/db/src/schema.ts` (`attachments` table),
> `packages/domain/src/attachment.ts`,
> `packages/contracts/src/attachments.ts`,
> `apps/web/src/features/files/client.ts`,
> `apps/web/src/components/FilesRail.tsx`,
> `apps/web/src/components/FilesViewer.tsx`,
> `apps/web/src/components/AttachmentLightbox.tsx`,
> `apps/web/src/components/FolderBrowserModal.tsx`,
> `apps/server/src/services/memory-files.ts`

## What it is (plain English)

Two related but distinct surfaces. **Project file browsing** lets the user
navigate the project folder on disk — the same folder their code lives in —
and preview files in the UI. **Attachments** are text or binary payloads
produced by agents or typed by the user and stored inside the app's database,
tied to a work item. A third surface, **memory files**, is a thin read/write
wrapper for Claude Code's `CLAUDE.md` instruction files at user, project, and
workspace scope.

## What it's supposed to do (intent)

- **File browsing / tree:** give the user (and eventually agents) a read-only
  view of what's inside their project folder without leaving the app.
- **Attachments:** durably store artifacts produced during workflow runs or
  conversations. Content must survive a process restart, cross-session, and be
  surfaced back to agents via MCP. Inline DB storage (never a filesystem path)
  is a locked architectural decision.
- **Memory files:** let the user read and edit `CLAUDE.md` instruction files
  that control Claude Code's behaviour in each scope, via the app's UI.

## How it works today (as-built)

### File tree & preview

- `getFilesTree(folderPath)` (`files-tree.ts:79`) recursively walks the
  project's root folder, applying two filter layers:
  1. Hard-skip a fixed set of noisy dirs (`HARD_SKIP_DIRS` at line 11:
     `node_modules`, `dist`, `.git`, `data`, etc.).
  2. Load the root `.gitignore` via the `ignore` package and skip matching
     paths.
- Result is sorted dirs-first, then alpha within each group. Each node carries
  `name`, Posix-relative `path`, `kind`, and file `size`.
- `previewFile(folderPath, relPath)` (`files-tree.ts:147`) reads a single file
  and classifies it as `markdown | html | image | text | binary | oversized`.
  - Hard cap: 1 MB (`PREVIEW_BYTE_CAP = 1_000_000`, line 27). Larger files
    return `kind: 'oversized'`.
  - Images are returned as a base64 data URI.
  - Binary detection: sniffs the first 8 KB for a NUL byte (`looksBinary`,
    line 230).
- **Path containment check** (`files-tree.ts:156`): uses `resolve()` +
  `startsWith(folderAbs + sep)` — not `path.relative`. This is the **known
  scar tissue site** (see Known Issues below). The `+ sep` guard blocks
  sibling-prefix attacks (`/foo` escaping to `/foobar/...`), but the code
  still uses `startsWith` rather than the safer `path.relative` + reject-`..`
  pattern.
- Routes are registered in `apps/server/src/features/files/routes.ts`:
  - `GET /api/projects/:projectId/files/tree` → `getFilesTree`
  - `GET /api/projects/:projectId/files/preview?path=` → `previewFile`

### Folder browser (create-project picker)

- `browseFolder(input, opts)` (`fs-browse.ts:49`) lists one directory at a
  time. Two modes controlled by the `roots` option:
  - No `roots` → unrestricted roaming (used by the App Settings folder
    picker).
  - `roots` provided → any path outside those roots is 403'd (used by
    Create Project modal, gated to `projectsFolder`).
- Containment check in `isInsideAnyRoot` (`fs-browse.ts:149`) uses
  `normalize(path).startsWith(rNorm + sep)` — same `startsWith + sep` pattern
  as `files-tree.ts`. On Windows, paths are lowercased before comparison.
- `createChildFolder` (`fs-browse.ts:92`) validates the new folder name
  (single path segment, no `/`, `\`, `..`) and calls `mkdirSync`.
- `probeFolder(input)` (`fs-probe.ts:32`) is a one-shot stat call: returns
  `exists`, `isDirectory`, `hasFiles`, `isGitRepo`, `hasPcScaffold`,
  `hasMcpJson`. Used by the Create Project modal to classify the chosen dir
  before committing.
- Routes: `GET /api/fs/browse`, `GET /api/fs/drives`, `POST /api/fs/mkdir`,
  `POST /api/fs/probe` (all in `files/routes.ts`).

### Attachments

- **DB schema** (`packages/db/src/schema.ts:499`): `attachments` table.
  The `content` column is `text().notNull()` with a comment: *"Inline payload.
  No filesystem-path variant — content always lives in the DB."* Confirmed
  — there is no `path` column, no file-system write anywhere in the create
  path.
- **Domain type** (`packages/domain/src/attachment.ts`): `content: string`
  field with note: *"Future binary support stores base64 here with contentType
  set."*
- **Repo** (`packages/db/src/repos/attachments.ts`): four functions —
  `createAttachment`, `listAttachmentsForWorkItem`, `getAttachment`,
  `deleteAttachment`. Hard-delete only (no soft-delete/restore).
- **Service** (`apps/server/src/services/attachment.ts`): project-scoped
  facade. Verifies every operation's work item belongs to the current project
  (`assertWorkItemInProject`, line 136) before passing through to the repo.
  On create and delete, writes a `live_outbox` event via `insertLiveEvent` +
  fires a legacy `broadcast` in parallel (Phase A dual-write; bare broadcast
  will be dropped in Phase C once the relay-first path is stable).
- **Routes** (in `apps/server/src/features/work-items/routes.ts`):
  - `GET /api/projects/:pId/work-items/:wiId/attachments` — list
  - `GET /api/projects/:pId/work-items/:wiId/attachments/:aId` — get by id
  - `GET /api/projects/:pId/attachments/:aId` — get by id (project-scoped,
    no wiId needed — used by the lightbox)
  - `POST /api/projects/:pId/work-items/:wiId/attachments` — create
  - `DELETE /api/projects/:pId/work-items/:wiId/attachments/:aId` — delete
- **Live event contract** (`packages/contracts/src/attachments.ts`):
  `AttachmentChangedLiveEvent` (type `attachment.changed`, entity
  `attachment`, scope `project`). Carries the full `AttachmentDto` (which
  includes `content` inline) on create; omits it on delete.
- **MCP surface**: agents create attachments via the `pc_attach_to_work_item`
  MCP tool (not in scope of this doc), which calls through `AttachmentService`
  with `source: 'agent'`.

### Memory files

- `memory-files.ts` handles three scopes: `user` (`~/.claude/CLAUDE.md`),
  `project` (`<folderPath>/CLAUDE.md`), `workspace`
  (`dirname(folderPath)/CLAUDE.md`).
- `readMemoryFile` / `writeMemoryFile` are simple `readFileSync` /
  `writeFileSync` wrappers. Write creates the directory if missing
  (`mkdirSync({ recursive: true })`).
- No route registration is visible in this file — the server endpoint that
  exposes these functions is elsewhere (unverified in this pass).

### UI components

- **`FilesRail.tsx`**: left-rail file tree. On project-switch, fetches the
  whole tree via `filesApi.getFilesTree(project.id)`. Expand state is in
  local React state (resets on project switch). "Show hidden" toggle filters
  leading-dot entries client-side. Clicking a file calls
  `useViewingFile.setViewing(project.slug, path)`.
- **`FilesViewer.tsx`**: center-column. Reads `useViewingFile` store; on path
  change fetches `filesApi.previewFile` and dispatches to the matching render
  branch (`ReactMarkdown` / sandboxed `<iframe>` / `<img>` / `<pre>` /
  binary placeholder / oversized placeholder).
- **`useViewingFile` store** (`apps/web/src/store/viewing-file.ts`): keyed by
  project slug; in-memory only (not persisted across reloads).
- **`AttachmentLightbox.tsx`**: full-screen modal mounted at Shell level.
  Opens when the `useAttachmentLightbox` store fires an `attachmentId`. Fetches
  the attachment by id from `workItemsApi.getAttachmentById`. Renders
  `image/...` content as `<img>` (data-URI if the content starts with
  `data:`; otherwise wraps in base64), and all other content types as
  `<pre>`. Provides Download (constructs a `Blob` from `attachment.content`)
  and "View parent" (opens the work-item modal) actions.
- **`FolderBrowserModal.tsx`**: used by Create Project and App Settings
  pickers. Drills one directory at a time via `filesApi.browseFolder`. In
  ungated mode shows drive jump buttons (Windows only). Persists last-browsed
  path in `localStorage` under key `pc.last-browse-dir`. Supports inline
  folder creation.

## Integrations (how it connects)

- **Depends on:**
  - SQLite / `@pc/db` — attachment storage and live-outbox writes.
  - Node `fs` / `path` — all disk reads for file tree and memory files.
  - `ignore` npm package — `.gitignore` parsing in `files-tree.ts`.
  - `live_outbox` table + relay — attachment change events pushed to the UI.
- **Used by:**
  - Work Items feature — attachments bound to work items; lightbox opened via
    `pc://attachment/<id>` rich-link clicks in chat.
  - Workflow engine / MCP — `pc_attach_to_work_item` tool writes through
    `AttachmentService`.
  - Create Project modal — `FolderBrowserModal` + `probeFolder` for folder
    selection.
  - App Settings modal — `FolderBrowserModal` for `projectsFolder` setting.
  - Memory drawer (UI) — reads/writes `CLAUDE.md` files via the memory-files
    service.
- **Contracts / events crossed:**
  - `AttachmentChangedLiveEvent` / `AttachmentChangedRefetchEnvelope`
    (`packages/contracts/src/attachments.ts`) — the WS live event the UI
    subscribes to for attachment list refresh.
  - `AttachmentDto` — the over-the-wire shape; mirrors `Attachment` domain
    type field-for-field including inline `content`.

## Target shape (per north star)

The ledger (`consolidation-ledger-2026-06-02.md`) has no explicit verdict row
for file-browsing or memory-files. Both are UI-support services with no
process-ownership concerns — they are already in the right place (Brain / UI
shell) and require no migration.

For attachments, the relevant ledger entries are:

- **`live_outbox` as the one notify door:** `AttachmentService` already
  writes to `live_outbox` via `insertLiveEvent` + the relay fans it to the UI.
  The legacy bare `broadcast` call alongside it is explicitly Phase A
  dual-write (`attachment.ts:113`). Phase C removes the bare broadcast,
  leaving `live_outbox` → relay as the sole fanout.
- **DB is the source of truth:** already true — content is inline, no
  filesystem variant.
- **`announcement → outbox → relay`** pattern: already wired for attachments.
  No structural change required.

No rename, merge, or rebuild is needed for this subsystem. The only pending
cleanup is the Phase C removal of the `broadcast` call in `AttachmentService`.

## Known issues / scar tissue

- **`startsWith` path containment (scar tissue — project memory):** Both
  `previewFile` (`files-tree.ts:156`) and `isInsideAnyRoot` (`fs-browse.ts:149`)
  use `startsWith(root + sep)` for path containment rather than
  `path.relative(root, candidate)` + reject-`..`. The `+ sep` suffix
  prevents the classic sibling-prefix bypass (`/foo` → `/foobar`), so the
  current code is not exploitable in practice, but it diverges from the safer
  pattern documented in project memory. A future change that removes the `sep`
  suffix would reopen the sibling-prefix hole.
  - The correct pattern: `const rel = path.relative(root, candidate); return !rel.startsWith('..') && !path.isAbsolute(rel)`.

- **Dual broadcast in `AttachmentService`:** Create and delete both call
  `announceAttachment` (durable `live_outbox` write) AND
  `this.opts.broadcast(...)` (legacy bare WS broadcast) — explicitly
  acknowledged as Phase A dual-write (`attachment.ts:112–113,125`). The bare
  broadcast is a second path doing the same job and will cause duplicate UI
  updates until Phase C removes it.

- **Lightbox backdrop-click dismisses on the `AttachmentLightbox`:**
  (`AttachmentLightbox.tsx:79`) the backdrop has an `onClick` that calls
  `close()`. Per project memory (`reference_modals_explicit_close_only`),
  implicit-close via backdrop click is considered destructive on modals that
  hold hard-to-redo work. The lightbox is read-only, so the risk is low here,
  but it contradicts the stated modal rule.

- **Memory-file write is synchronous and unbounded:** `writeFileSync` in
  `memory-files.ts:47` runs synchronously on the API thread. For typical
  `CLAUDE.md` sizes this is fine; if the UI were to write large content it
  would block the server event loop.

## Open questions

- Where are the memory-file HTTP routes registered? `memory-files.ts` has no
  route wiring visible — the server endpoint surfacing read/write to the UI
  was not found in this pass. (Unverified.)
- Should `previewFile` migrate to `path.relative` containment to match the
  documented safe pattern, and should that be a near-term guard test?
- Phase C timing for removing the bare `broadcast` from `AttachmentService` —
  no scheduled slot in the current ledger Phase-0 plan.
