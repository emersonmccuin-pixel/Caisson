# 016 MCP Capability Registry Unification (one canonical pc-rig tool registry)

## 1. Baseline and Decision

| Field | Value |
|---|---|
| Date | 2026-06-01 |
| Branch | `refactor/auto-pathway` |
| Commit | baseline `5bf64dff` (slices 001–011 + 015 spine landed + live-verified; 011 implemented row 40) |
| Artifact status | Planned build slice |
| Owning roadmap phase | Subsystem "MCP capability registry and external tool discovery" (tracker line 171; open question line 170 — registry home) |
| Slice subject | Collapse the THREE hand-maintained pc-rig tool sources (+ one derived names array) into ONE canonical, parity-guarded registry from which every view DERIVES — so adding a tool is ONE edit (or two parity-locked edits), and "added to one list, silently missing from the others" becomes structurally impossible |
| Execution order | **AHEAD of 013/014** (user in-session direction). Runs after 011 (this slice consolidates what 011 only started). |
| Implementation target | This repo. Do not create a parallel app. |
| Scope rule | Build plan only. Do not implement until the user explicitly asks to build. |

Decision (locked, justified in §7/§8):

- **Registry home = `@pc/domain`** (NOT `@pc/contracts`, NOT a new package). One `PC_RIG_TOOL_REGISTRY` array of plain METADATA per tool — `{ name, inputSchema, label, description, family, source: 'pc-rig' }` in canonical ListTools order. Browser-safe (`@pc/domain` has zero `node:`/SDK deps; web + mcp + runtime + server already import it). `@pc/contracts` is for wire DTOs/parsers, not UI labels; the catalog already lives in domain (`tool-catalog.ts`), so this is a consolidation in place, not a move across packages.
- **inputSchema moves INTO the registry (in).** The registry becomes the WHOLE agent-facing tool definition (name + inputSchema + description); `packages/mcp` keeps ONLY the executable HANDLER map keyed by name. Bigger one-time move (schemas are inline `as const` in `tools/*.ts` today) but it eliminates the last per-tool data that lives apart from metadata, so a new tool is genuinely ONE edit. Tradeoff vs leaving schemas in mcp (§9): leaving them out keeps the move small but leaves TWO parity-locked sources forever — rejected because the slice goal is "one edit".
- **`TOOLS` (mcp server objects), `PC_RIG_TOOL_NAMES`, `TOOL_CATALOG` (pc-rig entries), and `capabilities.ts` all DERIVE from the registry** by mapping in registry order. `TOOLS` is assembled by zipping `{ name, description, inputSchema }` (from registry) with the matching handler (from the mcp handler map), IN REGISTRY ORDER — so ListTools ordering is now GUARANTEED by the single ordered source instead of a hand-curated array.
- **Parity guard** (the thing that makes drift impossible): a test asserts `handlerMap keys === registry names === TOOL_CATALOG pc-rig slugs === capabilities keys === PC_RIG_TOOL_NAMES` (set equality) AND `TOOLS order === registry order === ListTools order`. A handler with no registry entry, or a registry tool with no handler, FAILS the build. There is no longer any array to half-edit.
- **WIRE FROZEN** (carried from 011): tool names, ListTools ordering, input JSON Schemas (byte-identical, just relocated), HTTP payloads/paths, agent-visible result strings — all unchanged. No new emit path. No DB migration. No contract/route behavior change.

## 2. Problem Statement

Verified facts (code-evidence, this checkout; `data/worktrees/**` ignored):

- **THREE hand-maintained sources + one derived array, all at 52 entries today, kept in sync by hand:**
  1. `packages/mcp/src/server.ts:84-126` → `TOOLS` — the real MCP server tool objects (`name` + `description` + `inputSchema`), assembled from per-tool `*_TOOL` consts spread across `packages/mcp/src/tools/*.ts` (52 consts: work-items 11, agents 15, agent-runs 9, workflows 11, project-config 6 — verified `rg -c`). `AGENT_MANAGEMENT_TOOLS` (`agents.ts:270-285`, 14 of the 15) spreads in at `server.ts:94`; `LIST_AGENTS_TOOL` is listed separately at `:104`. **ListTools returns `TOOLS` verbatim (`server.ts:233-235`) → ordering is observable + load-bearing.**
  2. `packages/domain/src/tool-catalog.ts:29-417` → `TOOL_CATALOG` — friendly `label` + `description` + `source` per tool (52 `source: 'pc-rig'` entries — verified `rg -c`), PLUS 9 `cc-builtin` + the `mcp-server` fall-through. **HAND-MAINTAINED and HAS DRIFTED:** the inline comment at `:150-153` documents a prior remediation where `pc_node_failed` + 8 live tools were "never added to this catalog"; `pc_list_areas` was missing until a fix THIS session (slice 010). Consumed at runtime by `pod-materializer.ts:253` (`descriptionOf` injects the description into every rendered pod prompt's tool list) and by the web tool-picker / agent-designer surfaces.
  3. `packages/mcp/src/capabilities.ts:28-92` → `CAPABILITIES` (slice 011) — `name → { family }`, parity-guarded against `TOOLS` (`test/capabilities.test.ts`, 5/5 green). Slice 011 ADDED this but kept the three sources separate — this slice finishes the job.
  - Derived array: `PC_RIG_TOOL_NAMES = TOOLS.map(t => \`mcp__pc-rig__${t.name}\`)` (`server.ts:134`).
- **The drift trap, end to end:** `apps/server/src/services/pod-tool-catalog.ts:13` re-exports `PC_RIG_TOOL_NAMES` from `@pc/mcp`; `pod-spawn.ts:124` feeds it as `mcpToolCatalog: { 'pc-rig': PC_RIG_TOOL_NAMES }`; `pod-materializer.ts` expands `mcp__pc-rig__*` wildcards against it. So `TOOLS` order/contents → pod allowlist expansion. The Section-36 comments at `server.ts:80-83,128-133` and `pod-tool-catalog.ts:7-11` document the bug class: the previous TWO hand-lists drifted on every new tool (the `pc-rig-catalog-drift` invisibility bug) until 011 made `PC_RIG_TOOL_NAMES` derive from `TOOLS`. That fixed names↔names. It did NOT fix `TOOLS`↔`TOOL_CATALOG` (still two hand-sources of the SAME 52 tools). `pc_list_areas`-missing-from-`TOOL_CATALOG` is exactly this residual gap.
- **Dependency graph (verified `package.json`):** `@pc/contracts` deps `{}`; `@pc/domain` deps `{ yaml }` only (no `node:` builtins, no SDK); `@pc/mcp` deps `{ @modelcontextprotocol/sdk, @pc/contracts, @pc/domain }`; `apps/web` imports `@pc/contracts` + `@pc/domain` + `@pc/runtime` (NOT `@pc/mcp`). So **web → domain → contracts**, **mcp → domain**, **web must NOT import mcp**. `@pc/mcp` already imports `@pc/domain` (it imports nothing from it yet for tools, but the dep exists), so the registry in domain is importable by mcp with zero new dep.
- **The handler is executable server-side code and CANNOT move to a browser-safe package:** dispatch is the ordered `handleXTool(name,args,ctx)` chain (`server.ts:237-251`): `handleWorkItemTool → handleAgentTool → handleWorkflowTool → handleProjectConfigTool → handleAgentRunTool`; each is a `switch(name)` issuing localhost HTTP via `ctx.postServer/...` + the slice-011 `ctx.client`. This lives in `packages/mcp` and stays there.
- **The metadata is plain data and CAN move:** `name` (string), `inputSchema` (JSON Schema literal — plain browser-safe object, e.g. `work-items.ts:7-26`), `label`/`description` (strings), `family` (string union). None reference `node:`/SDK/HTTP.
- **So a single literal holding handler+metadata is impossible across the boundary** — hence the split: registry (metadata, in domain) + handler map (functions, in mcp), zipped in mcp into `TOOLS`.

Synthesis — the cartridge for this slice:

```text
ONE registry (@pc/domain: name + inputSchema + label + description + family + order)
  -> TOOL_CATALOG pc-rig entries DERIVE (label/description/source map, in order)
  -> PC_RIG_TOOL_NAMES DERIVES (mcp__pc-rig__ prefix map, in order)
  -> capabilities.ts family lookup DERIVES (name -> family)
  -> packages/mcp HANDLER MAP (name -> handleX fn) zips with registry -> TOOLS (server objects, in order)
  -> parity test: handlerMap keys === registry names === every derived view; order preserved
```

## 3. Current-State Evidence

| Label | Finding | Evidence |
|---|---|---|
| Verified fact | THREE sources of the SAME 52 pc-rig tools, hand-kept in sync. | `server.ts:84-126` (TOOLS via 52 `*_TOOL` consts); `tool-catalog.ts` (52 `source:'pc-rig'`); `capabilities.ts` (52 keys, parity-guarded) |
| Verified fact | `TOOL_CATALOG` HAS DRIFTED — documented + reproduced this session. | `tool-catalog.ts:150-153` (8 tools + `pc_node_failed` "never added"); `pc_list_areas` (`:264-269`) added only in slice 010 |
| Verified fact | ListTools returns `TOOLS` verbatim; ordering observable + load-bearing. | `server.ts:233-235`; `PC_RIG_TOOL_NAMES = TOOLS.map(...)` `:134` |
| Verified fact | `PC_RIG_TOOL_NAMES` → pod-tool-catalog → pod-spawn → materializer wildcard expansion. | `pod-tool-catalog.ts:13`; `pod-spawn.ts:124`; `pod-materializer.ts:152,445` |
| Verified fact | `TOOL_CATALOG` description is injected into rendered pod prompts at spawn. | `pod-materializer.ts:253` (`descriptionOf` per granted tool) |
| Verified fact | Dep graph: web→domain→contracts, mcp→{domain,contracts}; web does NOT import mcp. | `package.json` of mcp/domain/contracts/web (deps dumped) |
| Verified fact | `@pc/domain` is browser-safe (deps `{yaml}` only, no `node:`/SDK). | `packages/domain/package.json`; web imports `@pc/domain` today |
| Verified fact | Handler = `switch(name)` chain issuing localhost HTTP; not browser-safe. | `server.ts:237-251`; `work-items.ts:287`, `agents.ts:393`, `workflows.ts:218`, `agent-runs.ts:222`, `project-config.ts` |
| Verified fact | inputSchema is an inline `as const` JSON-Schema literal per tool. | `work-items.ts:3-27`, `:29-...`; same shape across all `tools/*.ts` |
| Verified fact | 011 added `capabilities.ts` parity-guarded to TOOLS but kept three sources. | `capabilities.ts:1-9` (header: "It is NOT the catalog") |
| Verified fact | `REQUIRED_AGENT_TOOLS` + `mergeRequiredAgentTools` live in `tool-catalog.ts` and are NOT a catalog of the 52. | `tool-catalog.ts:437-454` |

## 4. The Pivotal Design Constraint (resolved)

Restating the boundary problem the planner must resolve, and the resolution:

- A pc-rig tool needs FOUR pieces: `name`, `inputSchema`, `label`/`description`, `family` (all plain data) + a `handler` (executable HTTP-issuing function).
- The handler CANNOT live in a browser-safe package (it imports `node:http` / the slice-011 typed client). The four data pieces CAN.
- Therefore one literal object spanning the boundary is impossible.
- **Resolution: split by purity.** Registry of the four data pieces in `@pc/domain`; handler map keyed by name in `packages/mcp`; mcp zips them into `TOOLS` in registry order. The single ORDERED registry is the source of truth for the agent wire; mcp owns only execution.

## 5. Registry Home: domain vs contracts (locked)

**`@pc/domain`. Justification:**

- `TOOL_CATALOG` (label/description/source/`friendlyName`/`descriptionOf`/`lookupTool`/`REQUIRED_AGENT_TOOLS`/`mergeRequiredAgentTools`) ALREADY lives in `@pc/domain`. The registry is a consolidation of that file, not a new cross-package thing.
- `@pc/contracts` is the WIRE-DTO/parser layer (zero deps, `ParseResult<T>` over `unknown`). Tool LABELS/DESCRIPTIONS are UI/prompt copy, not wire shapes — putting them in contracts mixes concerns and bloats the parser package. inputSchema (JSON Schema) is wire-shaped, but it is the agent's TOOL-CALL schema (an MCP concept), not a server-response DTO; pairing it with label/description in one tool-definition record is the natural grouping, and that record's home is domain alongside the existing catalog.
- Both domain and contracts are browser-safe, so either SATISFIES the boundary. Domain WINS on cohesion (catalog already there) + minimizing churn (no new contracts surface, no new dep for web/runtime/server which already import domain).
- `@pc/mcp` already deps `@pc/domain` — zero new dependency to consume the registry from the handler side.

Rejected alternatives: (a) a new browser-safe `@pc/tool-registry` package — unjustified ceremony for ~52 records that already have a home; (b) contracts — concern-mixing + parser-package bloat (above).

## 6. inputSchema: in or out (locked = IN)

**inputSchema moves INTO the registry.** Each registry record is the full agent-facing definition:

```ts
interface PcRigToolDef {
  name: string;                 // bare tool name (pc_create_work_item)
  inputSchema: JsonSchemaObject; // the MCP input schema literal (moved verbatim from tools/*.ts)
  label: string;               // friendly UI label (from TOOL_CATALOG)
  description: string;         // agent-facing + UI description (from the *_TOOL const / TOOL_CATALOG)
  family: CapabilityFamily;    // from capabilities.ts
}
export const PC_RIG_TOOL_REGISTRY: readonly PcRigToolDef[] = [ /* canonical order */ ];
```

Tradeoff (must be shown):

| | inputSchema IN registry (CHOSEN) | inputSchema stays in `packages/mcp` |
|---|---|---|
| Add-a-tool touch points | **1** (registry) + 1 handler = effectively 1 data edit | 2 parity-locked (registry metadata + mcp schema) |
| Move size this slice | Bigger — relocate ~52 inline `as const` schemas from `tools/*.ts` into the registry | Smaller — schemas stay put |
| Residual drift surface | None — schema lives with name/label/family | TWO ordered sources forever (registry ↔ mcp schemas) |
| `TOOLS` assembly | zip `{name,description,inputSchema}` (registry) + handler (mcp) | zip name/desc (registry) + schema+handler (mcp) |

**Chosen: IN.** The slice's headline promise is "adding a tool is a single edit." Leaving schemas in mcp keeps a second ordered source and forfeits that promise. The relocation is mechanical (cut `as const` literal → paste into the registry record; description currently duplicated between the `*_TOOL` const and `TOOL_CATALOG` collapses to one). Risk is contained by golden ListTools byte-identity (§11). NOTE on `description`: today the `*_TOOL` const description (agent-facing) and the `TOOL_CATALOG` description (UI/prompt) are SEPARATE strings for the same tool and are NOT always identical — see Open Questions; the registry must preserve BOTH where they differ (one `description` agent-facing field used by `TOOLS`/ListTools + the existing `label`; the UI-facing copy stays the `description` consumed by `descriptionOf`). Default: keep two fields if a diff exists, collapse to one only where byte-identical. This is the single highest-risk detail — golden tests gate it.

## 7. Derivation Plan (every view derives, order preserved)

| Derived view | Today | After slice | Order source |
|---|---|---|---|
| `TOOLS` (mcp server objects) | hand array of 52 `*_TOOL` consts | `PC_RIG_TOOL_REGISTRY.map(def => ({ name, description, inputSchema, handler: HANDLER_MAP[def.name] }))` in mcp | registry order |
| `PC_RIG_TOOL_NAMES` | `TOOLS.map(...)` | `PC_RIG_TOOL_REGISTRY.map(d => \`mcp__pc-rig__${d.name}\`)` (or keep `TOOLS.map` — same order) | registry order |
| `TOOL_CATALOG` pc-rig entries | 52 hand entries | derived: `PC_RIG_TOOL_REGISTRY.map(d => ({ slug: \`mcp__pc-rig__${d.name}\`, label: d.label, description: <ui desc>, source: 'pc-rig' }))` spread into the catalog ALONGSIDE the hand-kept `cc-builtin` + `mcp-server` entries | registry order |
| `capabilities.ts` family lookup | hand `Record<name,{family}>` | derived: `Object.fromEntries(PC_RIG_TOOL_REGISTRY.map(d => [d.name, { family: d.family }]))` (or registry IS the lookup) | n/a (map) |

- **ListTools ordering preserved:** the registry is initialized in the EXACT current `TOOLS` order (`server.ts:84-126`); `TOOLS` derives by mapping it; a golden test asserts post-slice ListTools names+order === a captured pre-slice snapshot. Do NOT reorder.
- **`TOOL_CATALOG` three-source partitioning preserved:** only the `pc-rig` partition derives; `cc-builtin` (9) + the `mcp-server` fall-through stay hand-authored exactly as today. The picker's `source`-based partitioning is unchanged.
- **`REQUIRED_AGENT_TOOLS` / `mergeRequiredAgentTools` UNCHANGED** — they are a grant-merge concern, not a catalog of the 52; keep them in `tool-catalog.ts` verbatim. They reference pc-rig slugs that the registry now owns, but the merge logic is independent.

## 8. Handler Map Plan (packages/mcp)

- Add `packages/mcp/src/tools/handlers.ts` (or extend `index.ts`): `export const PC_RIG_HANDLERS: Record<string, (args, ctx) => Promise<ToolResult> | ToolResult | null>` keyed by bare tool name.
- The existing `handleXTool(name,args,ctx)` `switch` chain stays (smallest diff) — the handler map can either (a) wrap the chain (`(args,ctx) => firstNonNull(handleWorkItemTool(name,...), ...)` per name) OR (b) be the new dispatch primitive (map lookup replaces the chain). **Recommend (b) as a stretch / (a) as the safe default** — start with (a) (map → existing chain) so dispatch behavior is byte-identical; the chain-collapse is a separable cleanup. Decide at build; (a) is the stop-condition-safe path.
- `server.ts` `CallTool` handler keeps calling dispatch; only `TOOLS` construction changes (zip registry + handler map).
- mcp imports `PC_RIG_TOOL_REGISTRY` from `@pc/domain` (existing dep). No new dep.

Files likely affected:

```text
packages/domain/src/tool-registry.ts          (NEW — PC_RIG_TOOL_REGISTRY + PcRigToolDef + CapabilityFamily moved here)
packages/domain/src/tool-catalog.ts           (TOOL_CATALOG pc-rig partition now derived from the registry; cc-builtin/mcp-server kept; REQUIRED_* kept)
packages/domain/src/index.ts                   (export the registry)
packages/mcp/src/server.ts                      (TOOLS + PC_RIG_TOOL_NAMES now derive from registry + handler map; ordering identical)
packages/mcp/src/tools/handlers.ts             (NEW — PC_RIG_HANDLERS name->fn map)
packages/mcp/src/tools/work-items.ts           (drop inline inputSchema/description literals OR keep handler-only; schemas relocated to registry)
packages/mcp/src/tools/agents.ts               (same)
packages/mcp/src/tools/agent-runs.ts           (same)
packages/mcp/src/tools/workflows.ts            (same)
packages/mcp/src/tools/project-config.ts       (same)
packages/mcp/src/capabilities.ts               (family lookup now derives from registry, or re-exports it)
packages/runtime/src/pod-materializer.ts       (NO change — still calls descriptionOf; description now sourced from derived catalog)
apps/server/src/services/pod-tool-catalog.ts   (NO change — still re-exports PC_RIG_TOOL_NAMES)
```

## 9. Contract / DB

- **No `@pc/contracts` change.** This slice does NOT touch wire DTOs/parsers. The slice-011 typed client + per-family parsers are untouched.
- **No DB migration.** The WHOLE POINT is code-not-DB: tool defs stay in code. Do NOT propose a DB-backed tool table. The DB keeps owning tool GRANTS (`pods.tools_json`) + external `mcp-server` configs only — unchanged.

## 10. Live Event / No-Bypass Gate (015c stays green)

- **No new emit path.** This slice relocates static metadata + rebuilds derivation; it adds no `broadcast*`/`fanoutMessage`/`live_outbox`/`@pc/db` to `packages/mcp` or `@pc/domain`. The 015c no-bypass gate is unaffected (neither package is an emitter).
- mcp remains a pure HTTP client of the server; the gateways still own the canonical door + relay.

## 11. Test Plan

| Priority | Test | Purpose |
|---|---|---|
| P0 | `packages/mcp/test/registry-parity.test.ts` (extend `capabilities.test.ts`) | **The drift-killer:** `PC_RIG_HANDLERS` keys === registry names === `TOOL_CATALOG` pc-rig slugs (stripped) === `capabilities` keys === `PC_RIG_TOOL_NAMES` (stripped) — SET EQUALITY. A handler with no registry entry / a registry tool with no handler / a catalog slug not in the registry FAILS. |
| P0 | ListTools order + byte-identity (golden) | Captured PRE-slice ListTools `{name, description, inputSchema}[]` snapshot === POST-slice. Names, ORDER, and every inputSchema byte-identical. This proves the relocation didn't mutate the wire. |
| P0 | `PC_RIG_TOOL_NAMES` snapshot | Exact array (order + contents) === pre-slice (52 `mcp__pc-rig__*` in order) — proves pod-catalog expansion unaffected. |
| P0 | `TOOL_CATALOG` derived-partition test | pc-rig partition === pre-slice (slug/label/description/source per entry, in order); `cc-builtin` + `mcp-server` entries unchanged; `descriptionOf`/`friendlyName`/`lookupTool` return identical values for every slug. |
| P0 | Bundle smoke (mirror 011 11G) | `pnpm --filter @pc/mcp build` → `dist/server.mjs` builds (registry from `@pc/domain` bundles in); spawned with fake `PC_*`, initialize→tools/list returns the same names+order. |
| P1 | Dispatch parity | A representative tool per family still dispatches through the handler map to the same HTTP call (no behavior change) — reuse/extend the 011 family request-shape tests. |
| P1 | `pod-materializer` render parity | `renderAvailableTools([...required])` output byte-identical pre/post (descriptions now from derived catalog). |

Gate commands (mirror 011; run from repo root):

```powershell
pnpm --filter @pc/contracts test
pnpm --filter @pc/contracts typecheck
pnpm --filter @pc/domain typecheck
pnpm --filter @pc/mcp typecheck
pnpm --filter @pc/mcp build
pnpm --filter @pc/server test
pnpm --filter @pc/server typecheck
pnpm --filter @pc/web typecheck
pnpm typecheck
git diff --check
```

Notes: `@pc/mcp` test script already exists (011 added `tsx --test "test/*.test.ts"`). `@pc/domain` has no test script today — add one (mirror contracts/mcp) for the registry tests, OR colocate the registry tests in `@pc/mcp` (it imports both). `pnpm typecheck` excludes `test/**` (known deferred defect) — type-check new test files via the package `tsx` runtime. `apps/server` typechecks against `@pc/mcp` source (imports `PC_RIG_TOOL_NAMES`) — the server typecheck is the cross-boundary guard.

Manual verification (batched to the human review pass; no dev-process restart by the build agent):

- Start Chat → orchestrator `pc-rig` MCP comes up with the same tool COUNT (52) and `mcp-status.json` lists the same names in order.
- A fresh agent boots with the full `mcp__pc-rig__*` roster (proves `PC_RIG_TOOL_NAMES` unchanged) AND its rendered prompt tool list shows the same descriptions (proves `descriptionOf`/derived catalog unchanged).
- Exercise one tool per family; output text byte-identical to before.
- Web tool-picker / agent surfaces render the same pc-rig labels+descriptions.

## 12. Migration Steps (one logical commit per coherent move)

1. **Registry skeleton (domain).** Add `tool-registry.ts` with `PcRigToolDef` + `CapabilityFamily` + an EMPTY-then-populated `PC_RIG_TOOL_REGISTRY` seeded in exact current `TOOLS` order, copying name+inputSchema+description from the `*_TOOL` consts + label+ui-description+family from `TOOL_CATALOG`/`capabilities`. Export from `index.ts`. No consumers rewired yet; add the snapshot/golden tests capturing CURRENT behavior FIRST. (commit)
2. **Derive `TOOL_CATALOG` pc-rig partition from the registry** (domain); keep cc-builtin/mcp-server hand-authored; `descriptionOf`/`friendlyName`/`lookupTool` parity test green. (commit)
3. **Derive `capabilities.ts`** from the registry (or re-export); 011 parity test still green. (commit)
4. **mcp: handler map + derive `TOOLS`/`PC_RIG_TOOL_NAMES`** from registry + `PC_RIG_HANDLERS`; remove inline inputSchema/description literals from `tools/*.ts` (keep handler fns). ListTools golden byte-identity green. (commit)
5. **Parity test** (handlerMap === registry === catalog === capabilities === names; order). (commit, may fold into 4)
6. **11G-style bundle smoke** + `apps/server` typecheck re-confirm. (commit)
7. Run the full gate suite.
8. Update trackers with implementation notes.

## 13. Rollback Plan

- Each derivation is additive-then-swap; reverting a commit restores the hand-source.
- Until step 4, `TOOLS`/ListTools are untouched, so the pod catalog never regresses mid-migration.
- The relocation is data-only (no logic change) — a misbehaving schema reverts by restoring its inline `as const` literal in `tools/*.ts` and removing it from the registry.
- No DB migration, no contract/route change to reverse.

## 14. Stop Conditions

Stop and return to planning if implementation requires any of:

- Renaming a tool, changing ListTools ordering, or any inputSchema BYTE (relocation must be verbatim) — frozen wire.
- Changing any agent-visible result string or any `TOOL_CATALOG` label/description value (relocation preserves them; a genuine copy change is a separate slice).
- A DB-backed tool table / any DB migration (code-not-DB is locked).
- Adding a `broadcast`/`live_outbox`/`@pc/db`/`node:http` import to `@pc/domain` (would break browser-safety) or any emit path to `packages/mcp`.
- Moving the handler (executable) into a browser-safe package, or importing `@pc/mcp` from `@pc/domain`/`apps/web` (boundary violation).
- Adding a `@pc/contracts` DTO/parser (out of scope; 011 owns the typed client).
- External-MCP-server capability discovery / dynamic tool listing (deferred — tracker line 171 open question).
- Discovering the two `description` strings (agent-facing vs UI) differ in a way that can't be losslessly represented by the registry's fields → STOP, confirm the field model before collapsing.
- Restarting/killing dev processes.

## 15. Acceptance Criteria

Ready to implement only when the user asks to build and these are accepted:

- ONE `PC_RIG_TOOL_REGISTRY` in `@pc/domain` holds name + inputSchema + label + description + family per pc-rig tool, in canonical ListTools order.
- `TOOLS`, `PC_RIG_TOOL_NAMES`, `TOOL_CATALOG` pc-rig entries, and `capabilities.ts` all DERIVE from the registry; ordering preserved; cc-builtin/mcp-server catalog entries + `REQUIRED_AGENT_TOOLS`/`mergeRequiredAgentTools` unchanged.
- `packages/mcp` owns ONLY the handler map (name→fn); `TOOLS` is zipped from registry + handler map in registry order.
- A parity test makes handler/registry/catalog/capabilities/names a single bijection in registry order — half-adding a tool fails the build.
- ListTools names + order + inputSchemas + result strings byte-identical (golden tests prove it); `descriptionOf`/`friendlyName`/`lookupTool` return identical values.
- esbuild bundle still produces a booting `dist/server.mjs`; `apps/server` typecheck green.
- No new emit path; 015c no-bypass gate stays green; no DB migration; no contract/route change.
- **Headline metric: adding a new pc-rig tool requires ONE registry edit + ONE handler addition (two parity-locked touch points in two packages), down from FOUR (TOOLS const+spread, TOOL_CATALOG, capabilities, and the implicit description) today.** The parity test fails if either half is missing.
- Tracker marks this slice `planned`.

## 16. Open Questions

| Question | Status |
|---|---|
| Registry home: domain or contracts? | **Resolved: `@pc/domain`** — catalog already there; contracts is wire-DTO/parser only; both browser-safe so domain wins on cohesion + zero new dep (mcp already deps domain). (§5) |
| inputSchema IN the registry or stays in mcp? | **Resolved: IN** — the slice goal is "one edit"; leaving schemas in mcp keeps a second ordered source. Bigger one-time move, contained by golden byte-identity. (§6) |
| Are the `*_TOOL` const `description` (agent-facing) and `TOOL_CATALOG` `description` (UI/prompt) the same string per tool? | **OPEN — verify per tool during build.** They are populated independently today and may diverge. Registry keeps BOTH fields where they differ (agent `description` for `TOOLS`/ListTools; UI description for `descriptionOf`), collapses to one only where byte-identical. STOP-and-confirm if a clean field model isn't possible losslessly. |
| Dispatch: keep the `handleXTool` chain (wrap in the map) or collapse to a pure name→fn map? | **Recommend: WRAP (chain stays) this slice** for byte-identical dispatch; the chain-collapse is a separable cleanup. Decide at build; wrap is the stop-safe default. (§8) |
| External MCP-server capability discovery / dynamic tool listing? | **OUT** (tracker line 171; 011 §14 deferred). This slice unifies the pc-rig family registry only. |
| Should the web ever get a registry-fed tool PICKER (vs today's freeform `tools` textarea in SettingsTab)? | **OUT** — the registry makes it possible (browser-safe, has labels) but building the picker is a separate UI slice. Note as a future enabler. |

## 17. Notes for the Implementation Agent

- **The wire is frozen.** Relocating inputSchema must be VERBATIM (cut/paste the `as const` literal). Write the ListTools golden snapshot test FIRST (capture current names+order+schemas), then migrate under it.
- **Initialize the registry in EXACT current `TOOLS` order** (`server.ts:84-126`, remembering `AGENT_MANAGEMENT_TOOLS` expands 14 in-place at `:94` and `LIST_AGENTS_TOOL` sits at `:104`). The registry array order IS the ListTools order now.
- **`@pc/domain` must stay browser-safe** — no `node:`/SDK/HTTP imports may enter `tool-registry.ts`. inputSchema is plain data; that's fine.
- **mcp imports the registry from `@pc/domain`** (existing dep). The handler map is the ONLY tool data left in `packages/mcp`.
- **Preserve the two `description` strings** if they differ (agent-facing vs UI) — this is the single highest-risk detail; golden tests on BOTH ListTools and `descriptionOf` gate it.
- **`TOOL_CATALOG` cc-builtin + mcp-server entries + `REQUIRED_AGENT_TOOLS` stay hand-authored** — only the pc-rig partition derives.
- **esbuild bundle is the boot artifact** — `pnpm --filter @pc/mcp build` is a hard gate; a domain import that breaks the bundle is a stop condition.
- **`apps/server` typechecks against `@pc/mcp` source** — run `pnpm --filter @pc/server typecheck` after rewiring `TOOLS`/`PC_RIG_TOOL_NAMES`.
- Do not use `archive/` or `data/worktrees/**` as evidence.
