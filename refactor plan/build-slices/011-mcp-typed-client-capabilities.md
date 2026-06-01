# 011 MCP Typed Client and Capability Registry Migration

## 1. Baseline and Decision

| Field | Value |
|---|---|
| Date | 2026-06-01 |
| Branch | `refactor/auto-pathway` |
| Commit | baseline `5bf64dff` (slice 010 Areas implemented + live-verified; slices 001–009 + 015 spine landed) |
| Artifact status | Planned build slice |
| Owning roadmap phase | Phase 11 — MCP typed client and capability registry migration |
| Slice subject | Route `@pc/mcp` tool internals through `@pc/contracts` DTOs/parsers + a typed localhost client, behind a canonical capability registry — WITHOUT changing tool names, ListTools ordering, wire payloads, or the agent-visible text result strings |
| Implementation target | This repo. Do not create a parallel app. |
| Scope rule | This is a build plan only. Do not implement until the user explicitly asks to build. |

Decision:

- **Recommendation:** Take a dependency `@pc/mcp → @pc/contracts` (workspace source import, esbuild-bundled). Keep `TOOLS` (`packages/mcp/src/server.ts`) the **sole source of truth** for the tool catalog + ListTools ordering + `PC_RIG_TOOL_NAMES`; add a SEPARATE, derived **capability registry** that maps each tool name → `{ family, contract parser(s), text-result builder }` metadata used by handlers — the registry is a lookup layer, NOT a re-declaration of TOOLS. Add a **typed localhost client** (`packages/mcp/src/client/`) that wraps the existing raw-HTTP `ToolContext` helpers, parses responses through contract parsers, returns typed DTOs + typed errors, and **falls back to the raw `{status, body}` per family** (compat column). Migrate tool families one-commit-each (11C work-item/project → 11D workflow → 11E agent/pending), where "migrated" means internals parse via contracts but the agent sees **byte-identical text result strings**. 11F validates external MCP config (`pod-mcp-config.ts` / `mcp-config-rewrite.ts`). 11G re-verifies the esbuild bundle still produces a working `dist/server.mjs`.
- **Reason (verified, this checkout):** `@pc/contracts` is zero-runtime-dep, isomorphic (only intra-package `./shared.ts` imports, no `node:` built-ins — verified by grep across `packages/contracts/src/*`) and already consumed as `workspace:*` source by `@pc/app-services` under `moduleResolution: Bundler`. `@pc/mcp`'s tsconfig uses the same Bundler resolution and esbuild `bundle: true` inlines everything — so the dep adds zero runtime weight and cannot break the stdio bundle. Today every tool handler hand-parses (`typeof args.x === 'string'`, `JSON.parse(res.body)` then pokes the shape — e.g. `work-items.ts:294-322`, `:519-591`), with hand-written JSON-Schema literals per tool. Contracts already own the exact DTOs + parsers for every family this slice touches: project/work-item/stages/fields (003), workflow def/run/review (004), agent-run + pending-ask (005), areas (010). The migration is to reuse them, not invent them.
- **Compatibility stance:** Tool **names**, **ListTools ordering**, **input JSON Schemas**, **HTTP request payloads/paths**, and **agent-visible text result strings** are all unchanged. The typed client is an internal seam; on a parse miss or shape drift it falls back to the current raw `{status, body}` handling so no agent ever sees a regression. No new emit path (see §10).

## 2. Problem Statement

Verified facts (code-evidence based, this checkout):

- **`packages/mcp` depends ONLY on `@pc/domain`** (`package.json:21-24`), NOT `@pc/contracts`. The `data/worktrees/**` copies are scratch — ignored.
- **`TOOLS` in `server.ts:84-126` is the de-facto catalog.** `PC_RIG_TOOL_NAMES` (`:134`) is `TOOLS.map(t => \`mcp__pc-rig__${t.name}\`)`; `apps/server/src/services/pod-tool-catalog.ts:13` re-exports it from `@pc/mcp` and `pod-spawn.ts:124` feeds it as `mcpToolCatalog: { 'pc-rig': PC_RIG_TOOL_NAMES }` for the Section-36 `mcp__pc-rig__*` wildcard expansion. **ListTools returns `TOOLS` verbatim (`:233-235`) — ordering is observable + load-bearing** (the catalog-drift trap the comments at `:80-83,:128-133` call out). `apps/server` imports `@pc/mcp` via its `types`/`import` export = `src/server.ts`, so the SERVER typechecks against the MCP TS source — a contracts dep there must typecheck clean.
- **Tool dispatch is a chain of `handleXTool(name, args, ctx)` in the CallTool handler** (`server.ts:237-251`): `handleWorkItemTool` → `handleAgentTool` → `handleWorkflowTool` → `handleProjectConfigTool` → `handleAgentRunTool`; first non-null wins; unknown → throw. Each handler is a `switch (name)` (`work-items.ts:287`, `agents.ts:393`, `workflows.ts:218`, `agent-runs.ts:222`, `project-config.ts`).
- **`ToolContext` exposes UNTYPED raw-HTTP helpers** (`context.ts:19-35`): `postServer/putServer/getServer/patchServer/deleteServer → Promise<{status:number, body:string}>`, plus `projectPath`, `resolveWorkItemIdViaServer`, `withRichLinkHint`. Each tool `JSON.parse(res.body)` then hand-checks fields — no shared types, no typed errors. Result strings today are mostly **the raw server `res.body` passed through** (`ctx.withRichLinkHint(res.body)`) or a hand-built `\`pc_x failed (${status}): ${body}\`` — byte-compat is preserving exactly these strings.
- **Input schemas are hand-written JSON-Schema literals per tool** (e.g. `work-items.ts:7-26`), each a `… as const` object with `name`, `description`, `inputSchema`.
- **Family sizes:** `work-items.ts` 824, `agents.ts` 1075, `workflows.ts` 679, `agent-runs.ts` 605, `project-config.ts` 294, `context.ts` 153 (verified `wc -l`).
- **Contracts coverage already exists** for every family this slice migrates: `projects.ts`, `work-items.ts` (incl. `areaId`), `stages.ts`, `field-schemas.ts`, `attachments.ts`, `areas.ts` (incl. `pc_list_areas`/`area_id`), `workflow-definitions.ts`, `workflow-runs.ts`, `agent-runs.ts`, `pending-asks.ts`. Parsers accept `unknown` → `ParseResult<T>`.
- **MCP tools mutate ONLY via apps/server HTTP routes** (verified: every handler uses `ctx.postServer/putServer/...`; no `broadcast`, no `live_outbox`, no DB import in `packages/mcp`). The server routes are the slice-002/003/004/005/010 mutation gateways that already emit the canonical `live_outbox` door (and, post-015, the relay). So the MCP layer has **no emit path of its own** and must not gain one.
- **External MCP config surfaces** (11F): `apps/server/src/services/mcp-config-rewrite.ts` (boot-time npx→bundle rewriter, suffix-matched), `apps/server/src/services/pod-mcp-config.ts` (`parsePodMcpServerConfig` — hand-validates `command/args/env/url` off `@pc/domain` `PodMcpServerConfig`), `apps/server/src/features/mcp-bridge/routes.ts` (handshake bridge), `apps/web/src/store/mcp-panel.ts` (web MCP panel).
- **Build (11G):** `packages/mcp/scripts/build.mjs` esbuild `bundle:true, platform:node, format:esm, target:node20` → `dist/server.mjs`; the package `prepare`/`dev --watch` rebuild it. `import.meta.url === ENTRY_URL` guards the stdio attach (`server.ts:262`) so `apps/server` can import `PC_RIG_TOOL_NAMES` without booting a server.

Synthesis — this slice applies the contracts/typed-client cartridge to the MCP adapter family WITHOUT touching the wire:

```text
contract (reuse @pc/contracts DTOs/parsers per family)
  -> typed localhost client over the existing raw-HTTP ToolContext (parsed DTOs + typed errors; raw fallback)
  -> capability registry derived FROM TOOLS (family + parser + text-result-builder metadata)
  -> tool handlers parse via contracts; emit BYTE-IDENTICAL result strings
  -> external MCP config validation (11F) + esbuild rebuild verification (11G)
  -> tests
```

## 3. Current-State Evidence

| Label | Finding | Evidence |
|---|---|---|
| Verified fact | `@pc/mcp` deps = `@modelcontextprotocol/sdk` + `@pc/domain` only; NOT `@pc/contracts`. | `packages/mcp/package.json:21-24` |
| Verified fact | `@pc/contracts` is zero-runtime-dep, isomorphic; only `./shared.ts` intra-imports, no `node:` built-ins. | grep `^import` across `packages/contracts/src/*`; `package.json` devDeps only |
| Verified fact | `@pc/app-services` already imports `@pc/contracts` as `workspace:*` source under Bundler resolution; mcp tsconfig uses the same resolution + esbuild bundles. | `app-services/package.json:14-18`; `mcp/tsconfig.json:5,16`; `mcp/scripts/build.mjs:24-31` |
| Verified fact | `TOOLS` is the catalog; `PC_RIG_TOOL_NAMES` derives from it; `apps/server` re-exports it; ListTools returns `TOOLS` verbatim (ordering observable). | `server.ts:84-136,233-235`; `pod-tool-catalog.ts:13`; `pod-spawn.ts:124` |
| Verified fact | Dispatch = ordered `handleXTool` chain; each is a `switch(name)`. | `server.ts:237-251`; `work-items.ts:287`; `agents.ts:393`; `workflows.ts:218`; `agent-runs.ts:222` |
| Verified fact | `ToolContext` raw-HTTP helpers return untyped `{status, body}`; tools hand-parse via `typeof` + `JSON.parse`. | `context.ts:19-35,58-110`; `work-items.ts:294-322,519-591` |
| Verified fact | Result strings are the raw server body passed through (`withRichLinkHint(res.body)`) or a hand-built failure string. | `work-items.ts:327-337`; `context.ts:149-151` |
| Verified fact | Contracts already own DTOs+parsers for project/work-item/stages/fields/areas/workflow-def/run/agent-run/pending-ask. | `packages/contracts/src/*` listing |
| Verified fact | MCP tools mutate only via apps/server HTTP routes; no broadcast/outbox/DB in `packages/mcp`. | grep `broadcast`/`live_outbox`/`@pc/db` in `packages/mcp` → none |
| Verified fact | External MCP config surfaces: rewriter, pod-mcp-config validator, mcp-bridge routes, web mcp-panel. | `mcp-config-rewrite.ts`; `pod-mcp-config.ts:3-35`; `features/mcp-bridge/routes.ts`; `apps/web/src/store/mcp-panel.ts` |
| Verified fact | esbuild bundle + `import.meta.url===ENTRY_URL` entry guard let `apps/server` import the module without booting a server. | `build.mjs`; `server.ts:261-268` |

## 4. Exact Scope

Implement only these behaviors when the user asks to build:

1. **Add `@pc/mcp → @pc/contracts` dependency.** Add `"@pc/contracts": "workspace:*"` to `packages/mcp/package.json`. No code in contracts changes. Verify `pnpm --filter @pc/mcp typecheck` and the esbuild build both stay green; verify `apps/server` (which typechecks against `@pc/mcp` source) stays green.
2. **11A — capability registry (derived, TOOLS stays source of truth).** Add `packages/mcp/src/capabilities.ts`: a `CAPABILITIES` map keyed by tool name → `{ family: 'work-item'|'project'|'workflow'|'agent'|'agent-run', responseParser?, buildText? }`. Do NOT make it the catalog source — `TOOLS` (and thus `PC_RIG_TOOL_NAMES` + ListTools order) stays exactly as-is. Add a focused test asserting every `TOOLS` name has a registry entry and every registry key is in `TOOLS` (parity guard, mirrors the deleted Section-36 drift test in spirit) — this is the only structural coupling, and it PROTECTS ordering rather than altering it.
3. **11B — typed localhost client.** Add `packages/mcp/src/client/typed-client.ts`: a thin wrapper constructed from the existing `ToolContext` raw helpers (inject them; do not re-implement HTTP) exposing typed methods (e.g. `getWorkItem(id) → ParseResult<WorkItemDto>`, `listAreas() → ParseResult<AreaDto[]>`, …) that call the raw helper, then run the matching contract parser on `res.body`. **Compat fallback (load-bearing):** every typed method returns BOTH the parsed DTO (when parse succeeds) AND the raw `{status, body}`; handlers keep emitting the raw `body` text. On non-2xx or parse failure, the typed layer surfaces a typed error but the handler's text output is the SAME failure string it builds today. The client lives in `packages/mcp` (NOT a shared package) — it is MCP-process-specific (localhost loopback to `PC_SERVER_PORT`), and a shared package would pull HTTP concerns into a browser-safe boundary.
4. **11C — project / work-item family migration (one commit).** Route `handleWorkItemTool` + `handleProjectConfigTool` request shaping and response handling through contract parsers + the typed client. Keep the hand-written input JSON Schemas (they are the MCP wire contract for the agent; contracts don't yet emit JSON Schema — see Open Questions). The text result strings stay byte-identical (assert in tests).
5. **11D — workflow family migration (one commit).** Same for `handleWorkflowTool` using `workflow-definitions`/`workflow-runs` contracts.
6. **11E — agent / agent-run / pending family migration (one commit).** Same for `handleAgentTool` + `handleAgentRunTool` using `agent-runs`/`pending-asks` contracts. (Agent-pod CRUD in `agents.ts` has no dedicated contract family beyond `pods.ts` — migrate what contracts cover; leave pod-CRUD response handling raw if no parser exists, and note it. See Open Questions.)
7. **11F — external MCP config validation.** Tighten `parsePodMcpServerConfig` (`pod-mcp-config.ts`) and/or the `mcp-config-rewrite.ts` shape checks. This is server-side validation of the `command/args/env/url` shape an external MCP server entry must have. Do NOT add a contract that forces a browser dependency on `@pc/domain`'s `PodMcpServerConfig`; keep the validator where it is, harden it, add tests. (External-server *capability discovery* — listing an external server's tools — is OUT; see §14.)
8. **11G — rebuild verification.** After the contracts dep + migrations, run `pnpm --filter @pc/mcp build` and confirm `dist/server.mjs` is produced and boots as a stdio server (a smoke check: spawn it with a fake `PC_*` env and assert ListTools returns the same names+order). Confirm `apps/server` typecheck + the `PC_RIG_TOOL_NAMES` import are unaffected.
9. Run the listed automated verification.

Non-goals (explicitly OUT — and which slice owns each):

- **Renaming any tool, changing ListTools ordering, or changing input JSON Schemas / HTTP payloads / paths.** The wire is frozen this slice.
- **Changing any agent-visible text result string.** Byte-compat is the headline invariant.
- **Introducing a second emit path** (broadcast / outbox / WS) from the MCP layer — mutations stay route-only; the server gateways own the live_outbox door + the slice-015 relay (see §10).
- **Generating JSON Schema from contracts** (replacing the hand-written `inputSchema` literals) — deferred (Open Questions); the hand schemas stay.
- **External MCP server capability discovery / dynamic tool listing** — OUT (Open Questions / §14).
- **Compatibility cleanup / legacy path deletion** — slice 015c (subsumes 012). Do not delete raw-HTTP fallbacks; keep them per the compat column.
- **Server route, app-service, DB, or contract *changes*** — this slice CONSUMES existing contracts; it does not add DTOs (if a family needs a new parser, prefer leaving it raw + noting it, or STOP-and-confirm before adding to `@pc/contracts`).
- Do NOT restart or kill dev servers while implementing or verifying.

## 5. Contract Plan

Files likely affected:

```text
packages/contracts/*    (NO change expected — this slice CONSUMES existing parsers; verify only)
```

- **No new contracts expected (verified).** Every family this slice migrates already has DTOs + parsers (003/004/005/010). The migration imports and applies them.
- If a handler needs a DTO/parser that does not exist (likely agent-pod CRUD responses, possibly some workflow-draft shapes), the default is to **leave that response raw** (keep current handling) and note it for a later slice. Adding a parser to `@pc/contracts` touches a shared browser-safe boundary → **STOP and confirm** before adding.
- The capability-registry metadata and the typed-client types live in `packages/mcp`, NOT in `@pc/contracts` (they are MCP-process-specific, not browser contracts).

## 6. Capability Registry + Typed Client Plan

Files likely affected:

```text
packages/mcp/package.json                     (add @pc/contracts dep)
packages/mcp/src/capabilities.ts              (NEW — derived registry: name -> {family, parser, buildText})
packages/mcp/src/client/typed-client.ts       (NEW — typed wrapper over ToolContext raw helpers; raw fallback)
packages/mcp/src/tools/context.ts             (optionally expose the typed client off ToolContext, or inject per-handler)
packages/mcp/src/tools/work-items.ts          (11C parse via contracts)
packages/mcp/src/tools/project-config.ts      (11C parse via contracts)
packages/mcp/src/tools/workflows.ts           (11D)
packages/mcp/src/tools/agents.ts              (11E — what contracts cover)
packages/mcp/src/tools/agent-runs.ts          (11E)
packages/mcp/src/server.ts                    (NO change to TOOLS / ordering / PC_RIG_TOOL_NAMES / ListTools)
```

Responsibilities:

| Component | Owns | Must not own |
|---|---|---|
| `TOOLS` (`server.ts`) | The catalog + ListTools ordering + `PC_RIG_TOOL_NAMES` derivation (UNCHANGED) | Response parsing, family routing |
| `capabilities.ts` (NEW) | name → {family, contract parser, text-result builder} lookup; parity-guarded against TOOLS | Being the catalog source; declaring tool names/order |
| `typed-client.ts` (NEW) | Typed request/response over the raw `ToolContext` helpers; parsed DTO + typed error + **raw `{status,body}` fallback** | HTTP transport (reuses `ctx.postServer/...`); emitting events |
| Tool handlers | Parse args + responses via contracts; emit **byte-identical** text strings | Inventing new wire shapes or result strings |

Boundary purity: `@pc/contracts` stays zero-runtime-dep + isomorphic. The typed client may import `@pc/contracts` + `node:http` (it's the stdio process). No handler imports `@pc/db`, `@pc/app-services`, Hono, or the websocket hub (none do today).

## 7. Capability Registry: Source-of-Truth Decision (locked)

- **`TOOLS` stays the SOLE source of truth.** The registry is a derived metadata lookup, not a re-declaration. Rationale (verified trap): `PC_RIG_TOOL_NAMES = TOOLS.map(...)` and ListTools returns `TOOLS` verbatim; `apps/server`'s pod-tool-catalog consumes `PC_RIG_TOOL_NAMES`. Inverting the source (registry → derive TOOLS) risks reordering the array (the comments at `server.ts:92-93` explicitly keep constants in place to preserve pre-split ordering) and silently drifting the pod catalog. A derived registry with a **parity test** (every TOOLS name ↔ every registry key) gets the lookup benefit with zero ordering/catalog risk.

## 8. @pc/contracts Dependency Decision (locked)

- **YES — `@pc/mcp` takes a dependency on `@pc/contracts`.** Justification: contracts are isomorphic/runtime-safe (zero runtime deps, no `node:` imports, pure `ParseResult` parsers — verified), already proven importable as `workspace:*` source by `@pc/app-services` under the same Bundler resolution `@pc/mcp` uses, and esbuild `bundle:true` inlines them with zero runtime footprint and no risk to the stdio bundle. This is the whole point of the slice (the roadmap row 11 constraint: "internals use shared contracts"). The one cross-check: `apps/server` typechecks against `@pc/mcp`'s TS source (it imports `PC_RIG_TOOL_NAMES` from the `src/server.ts` export), so the contracts dep must typecheck clean in the server build too — covered by the gate (`pnpm typecheck`).

## 9. DB

- **Migration needed: NO.** This slice adds no table, column, or migration. It is an adapter-internal refactor consuming existing contracts and routes.

## 10. Live Event / Canonical-Emit Compatibility (no-bypass gate stays green)

- **The MCP migration introduces NO new emit path.** Verified: `packages/mcp` has no `broadcast`/`live_outbox`/`@pc/db` import; every tool mutates via `ctx.postServer/...` against apps/server routes. Those routes are the slice-002/003/004/005/010 mutation gateways that write the canonical `live_outbox` door and (post-015) are drained by the relay. The typed client wraps the SAME HTTP calls — it does not call the gateways directly, does not emit, and does not touch the WS hub. So the slice-015c **no-bypass gate stays green** (no `broadcast*`/`fanoutMessage` added outside the relay; MCP remains a pure HTTP client of the server).
- No `/api/live-events` change. No legacy WS envelope touched.

## 11. Test Plan

Minimum automated tests (mirror the slice-002…010 style):

| Priority | Test | Purpose |
|---|---|---|
| P0 | `packages/mcp/test/capabilities.test.ts` | Registry ↔ TOOLS parity (every TOOLS name has a registry entry; every key is a TOOLS name); ListTools order == TOOLS order; `PC_RIG_TOOL_NAMES` derivation unchanged. |
| P0 | `packages/mcp/test/typed-client.test.ts` | Typed methods parse a well-formed server body into the right DTO; on non-2xx return the typed error AND the raw `{status, body}`; on a malformed body fall back to raw without throwing. |
| P0 | Result byte-compat tests (per family, 11C/D/E) | For representative success + failure responses, the migrated handler emits the EXACT same `ToolResult.content` text as the pre-migration handler (golden-string assertions — the agent-visible invariant). |
| P0 | `pod-mcp-config` validation test (11F) | Valid `command/args/env/url` shapes accepted; malformed shapes rejected with the same error messages; rewriter suffix-match behavior unchanged. |
| P0 | Bundle smoke (11G) | `dist/server.mjs` builds; spawned with fake `PC_*` env, ListTools returns the same names + order; no contracts-import boot failure. |
| P1 | Family request-shape tests | The HTTP payload/path each handler posts is unchanged after routing args through contracts (no wire drift). |

Gate commands (run from repo root; matches slices 002–010):

```powershell
pnpm --filter @pc/contracts test
pnpm --filter @pc/contracts typecheck
pnpm --filter @pc/mcp typecheck
pnpm --filter @pc/mcp build
pnpm --filter @pc/server test
pnpm --filter @pc/server typecheck
pnpm --filter @pc/web typecheck
pnpm typecheck
git diff --check
```

Notes: `@pc/mcp` has no `test` script today — add one (`tsx --test "test/*.test.ts"`, mirroring `@pc/contracts`/`@pc/app-services`). `pnpm typecheck` excludes `test/**` (known deferred defect) — type-check new test files via the package `tsx` runtime or a temp tsconfig. The `pnpm --filter @pc/mcp build` step IS the 11G gate.

Manual verification after implementation (batched to the human end-of-section pass; no dev-process restart by the build agent):

- In a live project chat, exercise one tool per family (`pc_get_work_item`, `pc_list_areas`, `pc_list_workflows`/`pc_fire_workflow`, `pc_invoke_agent`/`pc_list_my_runs`) and confirm the tool OUTPUT TEXT the agent sees is identical to before (rich-link hint intact, failure strings intact).
- Confirm the pod tool catalog still expands `mcp__pc-rig__*` (an agent boots with the full roster — proves `PC_RIG_TOOL_NAMES` ordering/contents unchanged).
- Confirm a mutating tool (`pc_create_work_item`, `pc_move_work_item`) still propagates live to a second tab (proves the server gateway/relay path is untouched — no second emit, no missing emit).
- Confirm a fresh-spawned agent's MCP server connects (handshake POST + ListTools) — proves the rebuilt bundle boots.

## 12. Migration Steps

1. Add `@pc/contracts` to `packages/mcp` deps; add the `test` script; confirm typecheck + build + `apps/server` typecheck green (no code yet).
2. Add `capabilities.ts` (derived registry) + the parity test.
3. Add `typed-client.ts` over the raw `ToolContext` helpers (parsed DTO + typed error + raw fallback) + its test.
4. 11C: migrate `work-items.ts` + `project-config.ts` internals; golden text-compat tests. (one commit)
5. 11D: migrate `workflows.ts`; golden text-compat tests. (one commit)
6. 11E: migrate `agents.ts` + `agent-runs.ts` (what contracts cover); golden text-compat tests. (one commit)
7. 11F: harden `pod-mcp-config.ts` / `mcp-config-rewrite.ts` validation + tests.
8. 11G: `pnpm --filter @pc/mcp build` + bundle smoke; re-confirm `apps/server` import.
9. Run automated verification.
10. Update trackers with implementation notes.

## 13. Rollback Plan

- The contracts dep is additive; reverting `package.json` + the new files removes it cleanly.
- The typed client is a wrapper with a raw fallback — a misbehaving family reverts call-site by call-site to the current hand-parse + raw `res.body`, no wire change.
- `TOOLS`/`PC_RIG_TOOL_NAMES`/ListTools are untouched, so the pod catalog never regresses regardless of migration state.
- The registry is a pure lookup; deleting it has no wire effect (the parity test goes with it).
- No DB migration to reverse. No server route or contract changed.

## 14. Stop Conditions

Stop and return to planning if implementation requires any of the following:

- Renaming a tool, changing ListTools ordering, changing an input JSON Schema, or changing any HTTP payload/path (frozen wire).
- Changing ANY agent-visible text result string (byte-compat is the headline invariant).
- Adding a broadcast / `live_outbox` / WS emit from `packages/mcp` (no-bypass gate, slice 015c).
- Adding a new DTO/parser to `@pc/contracts` (touches the shared browser-safe boundary — confirm first; default is leave the response raw + note it).
- Generating JSON Schema from contracts to replace the hand-written `inputSchema` literals (deferred).
- Building external-MCP-server capability discovery / dynamic tool listing (deferred).
- Deleting any raw-HTTP fallback or legacy path (slice 015c).
- A DB migration, or changing any apps/server route, app-service, or contract behavior.
- Making the registry the catalog source-of-truth (would risk reordering TOOLS / drifting the pod catalog).
- Restarting/killing dev processes.

## 15. Acceptance Criteria

This slice is ready to implement only when the user explicitly asks to build and these criteria are accepted:

- `@pc/mcp` depends on `@pc/contracts` (workspace source, esbuild-bundled); `pnpm --filter @pc/mcp typecheck` + `build` + `apps/server` typecheck stay green.
- A derived capability registry maps tool name → family/parser/text-builder metadata, parity-guarded against `TOOLS`; `TOOLS`/`PC_RIG_TOOL_NAMES`/ListTools ordering are unchanged.
- A typed localhost client wraps the raw `ToolContext` helpers, returns parsed DTOs + typed errors, and keeps the raw `{status, body}` fallback per family.
- Work-item/project (11C), workflow (11D), and agent/agent-run/pending (11E) handlers parse via contracts and emit BYTE-IDENTICAL text result strings (golden tests prove it).
- External MCP config validation (11F) is hardened with tests; capability discovery stays out.
- The esbuild bundle (11G) still produces a booting `dist/server.mjs`; ListTools returns the same names + order.
- No new emit path from MCP; the slice-015c no-bypass gate stays green; mutations remain route-only.
- No DB migration; no contract/route/app-service behavior change; no tool name/schema/payload/result-string change.
- Tracker marks this build-slice artifact `planned`.

## 16. Open Questions

| Question | Status |
|---|---|
| Does `@pc/mcp` take a dependency on `@pc/contracts`? | **Resolved: YES.** Contracts are isomorphic/zero-runtime-dep, already imported as workspace source by app-services under the same Bundler resolution, and esbuild-bundled with zero footprint. (§8) |
| Registry source of truth: TOOLS-derived registry, or registry-derived TOOLS? | **Resolved: TOOLS stays the sole source; the registry is a derived, parity-guarded lookup.** Inverting it risks reordering TOOLS + drifting `PC_RIG_TOOL_NAMES`/pod-tool-catalog. (§7) |
| Should the hand-written `inputSchema` JSON literals be generated from contracts? | **Deferred.** Contracts emit `ParseResult` parsers, not JSON Schema. Generating schemas is a separable follow-on; keep the hand schemas (they ARE the agent wire) this slice. |
| Where does the typed client live — `packages/mcp` or a shared package? | **Resolved: `packages/mcp`.** It is MCP-process-specific (localhost HTTP to `PC_SERVER_PORT`); a shared package would drag HTTP into a browser-safe boundary. |
| Agent-pod CRUD responses (`agents.ts`) have no dedicated parser beyond `pods.ts`. | Migrate what `pods.ts`/agent-run/pending contracts cover; leave pod-CRUD responses raw + note it. Adding a pod-response parser to `@pc/contracts` is STOP-and-confirm. |
| 11F: validate external MCP server *capabilities* (discover their tool list), or just the config shape? | **Resolved for this slice: config shape only.** Capability discovery is a larger, separable feature (MCP subsystem doc open question) — OUT here. |
| Does the no-bypass gate (015c) need an MCP-specific exemption? | **Resolved: NO.** MCP never emits; it's a pure HTTP client of the server. The gate already exempts pass-through (PTY/chunk/jsonl); MCP isn't an emitter at all. (§10) |

## 17. Notes for the Implementation Agent

- **The wire is frozen.** Tool names, ListTools order, input schemas, HTTP payloads/paths, and result-text strings do not change. The win is internal type-safety + a single capability lookup, not a behavior change. Write the golden text-compat tests FIRST (capture the current output strings), then migrate under them.
- **`TOOLS` is the source of truth — do not touch it.** Keep the constant ordering at `server.ts:84-126` verbatim; the registry is a separate derived map; the parity test protects the coupling.
- **Reuse the existing raw `ToolContext` helpers** for transport in the typed client — do not re-implement `node:http`. Inject the helpers; return parsed DTO + typed error + the raw `{status, body}` so the handler can fall back to its current string on any miss.
- **Keep the raw fallback per family** (compat column) — never let a parse miss change what the agent sees. The fallback is the rollback path baked in.
- **One commit per family** (11C → 11D → 11E) so a regression is bisectable; the dep + registry + client land first.
- **The esbuild bundle is the real boot artifact** — `pnpm --filter @pc/mcp build` is a hard gate (11G); a contracts dep that breaks the bundle is a stop condition, not a warning.
- **`apps/server` typechecks against the MCP TS source** (it imports `PC_RIG_TOOL_NAMES` from `@pc/mcp` = `src/server.ts`) — run `pnpm --filter @pc/server typecheck` after adding the contracts dep.
- Do not use `archive/` or `data/worktrees/**` as evidence or a source.
