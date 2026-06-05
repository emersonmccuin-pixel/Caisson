# FD-2 spike — one shared HTTP MCP tools server

**Verdict: PASSED 6/6 (2026-06-03, claude.exe 2.1.162).** Full write-up in
`Sub-Systems/_Foundation-Decisions.md` → FD-2. Results: `spike-results.json`.

**Re-runs (FD-22 version bumps):** 2.1.163 — PASSED 6/6 (2026-06-04, pin bump for the
packaged-app rebuild).

- `server.mjs` — ONE Streamable-HTTP MCP server (`:4555/mcp`), three probe tools; every result
  echoes the per-call identity (X-PC-Probe header → `extra.requestInfo.headers`).
- `run-spike.mjs` — fully automated driver: 3 interactive claude.exe clients, identity / isolation /
  concurrency / turn-1-timing checks, then a server kill+restart recovery check. Positive receipts
  read from session JSONL transcripts; every wait has a deadline.

Run: `node run-spike.mjs` (~30s, spawns 3 real claude.exe sessions).

**Re-run this on every FD-22 Claude Code version bump** — it is the quirk-surface test for the
tools transport (headers-per-call, deferred_tools_delta turn-1 behavior, 404/-32001 reconnect).

Found by this spike: CC 2.1.162 encodes transcript dirs with `[^a-zA-Z0-9] → '-'` (dots too) —
PC's encoder diverged; fixed in `packages/runtime/src/path-resolver.ts` same day.
