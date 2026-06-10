// Stage 0 guard for the JSONL-canonical chat refactor
// (docs/chat-canonical-source-redesign.md s2). The policy table is dormant.
// Run via:  pnpm --filter @pc/runtime test

import assert from "node:assert/strict";
import { test } from "node:test";

import type { JsonlEvent } from "../src/jsonl-tailer.ts";
import {
  CC_INTERNAL_USER_TEXT_RE,
  INTERNAL_TOOLS,
  ensureSystemTurnMarker,
  parseSystemTurnMarker,
  rowPolicy,
  stripSystemTurnMarkerLine,
} from "../src/chat-policy.ts";

const FIXTURES: Array<{ label: string; ev: JsonlEvent }> = [
  { label: "user", ev: { kind: "jsonl-user", text: "hi" } },
  { label: "user (isMeta)", ev: { kind: "jsonl-user", text: "injected", isMeta: true } },
  { label: "user (compact summary)", ev: { kind: "jsonl-user", text: "This session is being continued…", isCompactSummary: true } },
  { label: "user (command echo)", ev: { kind: "jsonl-user", text: "<command-name>/compact</command-name>\n<command-message>compact</command-message>" } },
  { label: "user (local stdout)", ev: { kind: "jsonl-user", text: "<local-command-stdout>Compacted</local-command-stdout>" } },
  { label: "user (caveat)", ev: { kind: "jsonl-user", text: "<local-command-caveat>Caveat: local commands</local-command-caveat>" } },
  { label: "turn-end (text)", ev: { kind: "jsonl-turn-end", text: "done", stopReason: null } },
  { label: "turn-end (empty)", ev: { kind: "jsonl-turn-end", text: "", stopReason: null } },
  { label: "tool-call (visible)", ev: { kind: "jsonl-tool-call", toolUseId: "t1", name: "Bash", input: {} } },
  { label: "tool-call (internal)", ev: { kind: "jsonl-tool-call", toolUseId: "t2", name: "TodoWrite", input: {} } },
  { label: "tool-result", ev: { kind: "jsonl-tool-result", toolUseId: "t1", result: "ok", isError: false } },
  { label: "tool-progress", ev: { kind: "jsonl-tool-progress", toolUseId: "t1", toolName: "Bash", parentToolUseId: null, elapsedSeconds: 1, taskId: null, raw: {} } },
  { label: "usage (standard)", ev: { kind: "jsonl-usage", inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, model: "opus", speed: "standard", cacheMissReason: null } },
  { label: "usage (non-standard)", ev: { kind: "jsonl-usage", inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, model: "opus", speed: "fast", cacheMissReason: null } },
  { label: "usage (cache miss)", ev: { kind: "jsonl-usage", inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0, model: "opus", speed: "standard", cacheMissReason: "expired" } },
  { label: "system", ev: { kind: "jsonl-system", subtype: "api_error", level: "error", message: "x", timestamp: null, raw: {} } },
  { label: "session-state", ev: { kind: "jsonl-session-state", state: "idle", permissionMode: null, timestamp: null, raw: {} } },
  { label: "compact", ev: { kind: "jsonl-compact", trigger: null, preTokens: null, messagesSummarized: null, timestamp: null, raw: {} } },
  { label: "microcompact", ev: { kind: "jsonl-microcompact", trigger: null, preTokens: null, tokensSaved: null, timestamp: null, raw: {} } },
  { label: "queue-enqueue", ev: { kind: "jsonl-queue-enqueue", timestamp: null } },
  { label: "queue-dequeue", ev: { kind: "jsonl-queue-dequeue", timestamp: null } },
  { label: "ai-title", ev: { kind: "jsonl-ai-title", title: "t" } },
  { label: "last-prompt", ev: { kind: "jsonl-last-prompt", uuid: null, raw: {} } },
  { label: "file-history", ev: { kind: "jsonl-file-history", snapshotId: null, raw: {} } },
  { label: "bridge-session", ev: { kind: "jsonl-bridge-session", bridgeSessionId: null, raw: {} } },
  { label: "sidechain", ev: { kind: "jsonl-sidechain", raw: {} } },
  { label: "turn-duration", ev: { kind: "jsonl-turn-duration", durationMs: null, budgetTokens: null, messageCount: null, timestamp: null, raw: {} } },
  { label: "post-turn-summary", ev: { kind: "jsonl-post-turn-summary", summarizesUuid: null, statusCategory: null, statusDetail: null, isNoteworthy: false, title: null, description: null, recentAction: null, needsAction: false, artifactUrls: null, timestamp: null, raw: {} } },
  { label: "stream-event", ev: { kind: "jsonl-stream-event", event: {}, parentToolUseId: null, raw: {} } },
  { label: "assistant-text (mid-loop)", ev: { kind: "jsonl-assistant-text", text: "preamble", midLoop: true } },
  { label: "assistant-text (empty)", ev: { kind: "jsonl-assistant-text", text: "", midLoop: false } },
  { label: "thinking", ev: { kind: "jsonl-thinking", text: "some reasoning" } },
  { label: "thinking (empty)", ev: { kind: "jsonl-thinking", text: "" } },
];

function suppressedToday(ev: JsonlEvent): boolean {
  switch (ev.kind) {
    case "jsonl-user":
      return ev.isMeta === true || ev.isCompactSummary === true ||
        CC_INTERNAL_USER_TEXT_RE.test(ev.text ?? "");
    case "jsonl-turn-end": return !ev.text;
    case "jsonl-tool-call": return INTERNAL_TOOLS.has(ev.name);
    case "jsonl-usage": return (!ev.speed || ev.speed === "standard") && !ev.cacheMissReason;
    case "jsonl-queue-enqueue":
    case "jsonl-queue-dequeue":
    case "jsonl-ai-title":
    case "jsonl-last-prompt":
    case "jsonl-file-history":
    case "jsonl-bridge-session":
    case "jsonl-turn-duration":
    case "jsonl-post-turn-summary":
    case "jsonl-stream-event": return true;
    case "jsonl-assistant-text": return !ev.text;
    case "jsonl-thinking": return !ev.text;
    default: return false;
  }
}

test("rowPolicy is exhaustive", () => {
  const seen = new Set<string>();
  for (const { ev } of FIXTURES) {
    const p = rowPolicy(ev);
    assert.ok(["shown", "collapsed", "hidden"].includes(p.visibility), );
    assert.ok(["chat", "tools", "system", "internal"].includes(p.lane), );
    seen.add(ev.kind);
  }
  assert.equal(seen.size, 22, "fixture set drifted from the JsonlEvent kind union");
});

test("hidden set matches suppressed set", () => {
  for (const { label, ev } of FIXTURES) {
    const isHidden = rowPolicy(ev).visibility === "hidden";
    assert.equal(isHidden, suppressedToday(ev), );
  }
});

test("internal tools are hidden, ordinary tools are visible", () => {
  assert.equal(rowPolicy({ kind: "jsonl-tool-call", toolUseId: "a", name: "TodoWrite", input: {} }).visibility, "hidden");
  assert.notEqual(rowPolicy({ kind: "jsonl-tool-call", toolUseId: "b", name: "Read", input: {} }).visibility, "hidden");
});

// ── FD-3 / FD-6 — system-injected turn marker ─────────────────────────────

test("parseSystemTurnMarker: composer headers, fallback header, plain text", () => {
  // kind= attribute wins over the token
  assert.deepEqual(
    parseSystemTurnMarker("[pc:agent-event kind=agent-completed version=1]\nbody"),
    { kind: "agent-completed" },
  );
  // no kind= attribute → the token is the kind
  assert.deepEqual(
    parseSystemTurnMarker("[pc:workflow-review run=R1 node=gate flavor=human]\nbody"),
    { kind: "workflow-review" },
  );
  assert.deepEqual(parseSystemTurnMarker("[pc:system kind=workflow-run-failed]\nbody"), {
    kind: "workflow-run-failed",
  });
  // ordinary human text — including bracket-y text — is NOT a marker
  assert.equal(parseSystemTurnMarker("hello world"), null);
  assert.equal(parseSystemTurnMarker("[PC:agent-event]"), null);
  assert.equal(parseSystemTurnMarker(" [pc:agent-event]"), null);
  assert.equal(parseSystemTurnMarker("[pc-other] text"), null);
});

test("ensureSystemTurnMarker: passthrough when marked, fallback header otherwise", () => {
  const marked = "[pc:workflow-review run=R1]\nbody";
  assert.equal(ensureSystemTurnMarker(marked, "workflow-review"), marked);
  assert.equal(
    ensureSystemTurnMarker("Workflow failed: X\nreason", "workflow-run-failed"),
    "[pc:system kind=workflow-run-failed]\nWorkflow failed: X\nreason",
  );
  // kind is sanitised, never breaks the header shape
  assert.equal(
    ensureSystemTurnMarker("body", "Weird Kind!!"),
    "[pc:system kind=weird-kind]\nbody",
  );
  assert.equal(ensureSystemTurnMarker("body", ""), "[pc:system kind=notice]\nbody");
});

test("stripSystemTurnMarkerLine: drops only the marker line", () => {
  assert.equal(stripSystemTurnMarkerLine("[pc:system kind=x]\nline1\nline2"), "line1\nline2");
  assert.equal(stripSystemTurnMarkerLine("[pc:system kind=x]\n\nline1"), "line1");
  assert.equal(stripSystemTurnMarkerLine("[pc:system kind=x]"), "");
  assert.equal(stripSystemTurnMarkerLine("plain text\nstays"), "plain text\nstays");
});

test("rowPolicy: CC-internal user rows are hidden, human text survives", () => {
  // flags
  assert.equal(rowPolicy({ kind: "jsonl-user", text: "x", isMeta: true }).visibility, "hidden");
  assert.equal(rowPolicy({ kind: "jsonl-user", text: "This session is being continued…", isCompactSummary: true }).visibility, "hidden");
  // XML plumbing wrappers — leading whitespace tolerated
  for (const text of [
    "<command-name>/compact</command-name>",
    "  <local-command-stdout>ok</local-command-stdout>",
    "<local-command-caveat>Caveat</local-command-caveat>",
    "<bash-stdout>ls output</bash-stdout>",
    "<tick/>",
    "<task-notification>\n<task-id>t1</task-id>",
    "<system-reminder>bg</system-reminder>",
  ]) {
    assert.deepEqual(rowPolicy({ kind: "jsonl-user", text }), { visibility: "hidden", lane: "internal" }, text);
  }
  // a human pasting XML mid-message (or unknown tags) still renders as chat
  assert.equal(rowPolicy({ kind: "jsonl-user", text: "look at this: <command-name>x</command-name>" }).visibility, "shown");
  assert.equal(rowPolicy({ kind: "jsonl-user", text: "<div>my html question</div>" }).visibility, "shown");
});

test("rowPolicy: marked user rows are system-lane and SHOWN; plain user rows stay chat-lane", () => {
  assert.deepEqual(rowPolicy({ kind: "jsonl-user", text: "[pc:agent-event kind=agent-completed]\nResult" }), {
    visibility: "shown",
    lane: "system",
  });
  assert.deepEqual(rowPolicy({ kind: "jsonl-user", text: "hi" }), {
    visibility: "shown",
    lane: "chat",
  });
});
