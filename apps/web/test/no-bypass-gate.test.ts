// T3.4 — the client NO-BYPASS static gate (Theme 3 capstone).
//
// Invariant: the relay live-event frame is delivered to the UI through ONE
// door — the WS handler feeds the identity-keyed live store, and views read the
// store via selectors. T3.1→T3.3 eliminated every "scan the chat `events[]`
// timeline looking for relay live-event frames" consumer (the root cause of
// live-UI staleness: the timeline re-derives on replay/snapshot, so a positional
// cursor over it silently skips frames during active sessions).
//
// This test statically scans the web SOURCE (not tests) and FAILS if any one
// file references BOTH:
//   (a) a chat-events ARRAY being scanned — the identifier `events`/`_events`
//       used as an array via an indexing/iteration op (`events[`, `[...events]`,
//       `events.length`, `.find/.reverse/.some/.map/.filter/.forEach/.reduce`,
//       a `.events[`/`.events.length` member access, etc.). Merely DECLARING or
//       RETURNING an `events` variable (useState, a param, a return) does NOT
//       count — only an actual scan.
//   (b) a relay live-event-FRAME detector — the string literal `'live-event'`,
//       the guard `isLiveEventFrame`, or any `is*ChangedLiveEventFrame` guard
//       (e.g. `isWorkItemChangedLiveEventFrame`, `isAttachmentChangedLiveEvent`,
//       `isProjectChangedLiveEventFrame`, …).
// BOTH in one file == a timeline scan of live-event frames == the banned bypass.
//
// Comments and import/export statements are stripped before matching, so a
// `'live-event'` mention in a doc comment or a guard imported by path
// (`from '.../live-events'`) does not trip the gate — only real code does.
//
// Matching is by file + pattern (regex), NOT line numbers, so it is robust to
// code moving within a file. A NEW view re-introducing a live-event timeline
// scan FAILS the gate. To extend the allowlist you MUST add a real
// justification here — do not widen it silently.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
// .../apps/web/test/no-bypass-gate.test.ts -> repo root
const repoRoot = join(here, '..', '..', '..', '..');
const WEB_SRC = join(repoRoot, 'apps', 'web', 'src');

// ── (b) the relay live-event-frame detector ───────────────────────────────────
// The `'live-event'` envelope-type literal, the `isLiveEventFrame` guard, or any
// `is…LiveEvent…Frame` changed-frame guard. The literal must be quoted so a bare
// word `live-event` (impossible in TS) or a `live-events` import path (plural)
// can never match.
const FRAME_DETECTOR_RE =
  /(['"]live-event['"])|(\bisLiveEventFrame\b)|(\bis\w*LiveEvent\w*Frame\b)/;

// ── (a) a chat-events ARRAY being scanned ──────────────────────────────────────
// An `events`/`_events` identifier (optionally a `.events` member) used in an
// indexing or iteration operation. Declaration/return forms (`const [events,…]`,
// `events: WsEnvelope[]`, `return { events }`) are intentionally NOT matched.
const EVENTS_SCAN_RES = [
  // indexing: events[i] / _events[i] / replay.events[i]
  /(?:\.)?\b_?events\s*\[/,
  // spread copy for scanning: [...events] / [..._events]
  /\[\s*\.\.\.\s*_?events\b/,
  // length read used by a positional/index scan: events.length / .events.length
  /(?:\.)?\b_?events\.length\b/,
  // array-scan methods on the events identifier
  /(?:\.)?\b_?events\.(?:find|findIndex|reverse|some|every|map|filter|forEach|reduce|slice|indexOf|includes|at)\b/,
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'archive' || name === 'test') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listSourceFiles(full));
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/**
 * Strip block comments, line comments, and import/export-with-string statements
 * from source — leaving only "real code" lines for pattern matching. Mirrors the
 * server gate's line-granular comment stripping.
 */
function codeLines(content: string): string[] {
  const out: string[] = [];
  const lines = content.split(/\r?\n/);
  let inBlockComment = false;
  for (let raw of lines) {
    let line = raw;
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    const open = line.indexOf('/*');
    if (open !== -1 && line.indexOf('*/', open) === -1) {
      inBlockComment = true;
      line = line.slice(0, open);
    }
    const lc = line.indexOf('//');
    if (lc !== -1) line = line.slice(0, lc);
    const trimmed = line.trim();
    if (!trimmed) continue;
    // import/export … from '…' — a guard imported by path is not a scan.
    if (/^(import|export)\b/.test(trimmed) && /['"]/.test(trimmed)) continue;
    out.push(line);
  }
  return out;
}

interface Match {
  scan?: { line: number; text: string };
  detector?: { line: number; text: string };
}

/** Scan one file's code (comments/imports stripped) for (a) and (b). */
function inspect(content: string): Match {
  const lines = codeLines(content);
  const result: Match = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!result.scan) {
      for (const re of EVENTS_SCAN_RES) {
        const m = re.exec(line);
        if (m) {
          result.scan = { line: i + 1, text: m[0].trim() };
          break;
        }
      }
    }
    if (!result.detector) {
      const m = FRAME_DETECTOR_RE.exec(line);
      if (m) result.detector = { line: i + 1, text: m[0].trim() };
    }
  }
  return result;
}

// ── The allowlist — files that DO scan an events array AND reference a
// live-event detector for a LEGITIMATE non-bypass reason. Keyed by repo-relative
// POSIX path. Each entry needs a real justification; the stale-check below
// deletes any entry that stops matching both patterns (keeps it honest).
//
// Currently EMPTY. The four files the spec pre-listed as candidates
// (use-project-ws.ts, use-all-projects-ws.ts, live-store.ts, and
// chat-session-reducer.ts) reference a live-event detector (b) but — after
// T3.1→T3.3 — do NOT scan an events array (a), so they never trip the main gate
// and do not need allowlisting:
//   • use-project-ws.ts / use-all-projects-ws.ts — WS message handlers; route the
//     frame INTO the store per-envelope; the `events[]` they expose is never
//     scanned for live frames.
//   • live-store.ts — the store; `isLiveEventFrame` gates what is applied. No scan.
//   • chat-session-reducer.ts — references `isProjectChangedLiveEventFrame` for the
//     project.changed refetch nonce (separate, non-store); does not scan `_events`
//     for live frames (the `_events` param is vestigial/unread after T3.3).
// The precise (a)∧(b) heuristic already excludes them — no allowlist needed.
const ALLOWLIST: Record<string, string> = {};

// ── Excludes: the guard/helper modules that DEFINE or wrap the frame guards.
// They legitimately scan an `events` array AND reference the detector because
// they ARE the detector — but they are not chat-timeline views. Any
// `**/live-events.ts` or `**/*-live-events.ts` module is excluded by path.
function isGuardModule(rel: string): boolean {
  return /(?:^|\/)([\w-]*live-events)\.ts$/.test(rel);
}

test('client no-bypass gate: no web view scans the chat timeline for relay live-event frames', () => {
  const offenders: string[] = [];
  const allowlistedHits = new Set<string>();

  for (const file of listSourceFiles(WEB_SRC)) {
    const rel = toPosix(relative(repoRoot, file));
    if (isGuardModule(rel)) continue; // guard/helper module — defines the detector
    const m = inspect(readFileSync(file, 'utf8'));
    if (!m.scan || !m.detector) continue; // needs BOTH to be a bypass
    if (rel in ALLOWLIST) {
      allowlistedHits.add(rel);
      continue;
    }
    offenders.push(
      `${rel} — events-scan @L${m.scan.line} (\`${m.scan.text}\`) + ` +
        `live-event-frame detector @L${m.detector.line} (\`${m.detector.text}\`)`,
    );
  }

  assert.equal(
    offenders.length,
    0,
    `Found ${offenders.length} client live-event TIMELINE-SCAN bypass(es). A web view ` +
      `must read relay live-event frames from the live store (useLiveEvents / ` +
      `useLiveEntitySignature), never by scanning the chat \`events[]\` array. ` +
      `Route the frame through use-project-ws -> the store, or (if genuinely a ` +
      `legitimate non-scan reference) add the file to ALLOWLIST with a justification:\n` +
      offenders.map((o) => `  - ${o}`).join('\n'),
  );

  // Self-maintaining: an allowlist entry that no longer matches BOTH patterns is
  // stale (likely self-cleaned by a later T3 slice) and must be removed.
  const stale = Object.keys(ALLOWLIST).filter((p) => !allowlistedHits.has(p));
  assert.equal(
    stale.length,
    0,
    `Stale allowlist entr${stale.length === 1 ? 'y' : 'ies'} — no longer matches both ` +
      `(a) an events-scan and (b) a live-event detector; delete from ALLOWLIST:\n` +
      stale.map((p) => `  - ${p}`).join('\n'),
  );
});

test('client no-bypass gate: would FAIL on a planted bypass (self-check)', () => {
  // A synthetic source string with BOTH patterns must be detected — proves the
  // gate has teeth. (We assert the detector logic, not a real file on disk.)
  const planted = [
    `import type { WsEnvelope } from '@/features/runtime/ws-types';`,
    `export function leak(events: WsEnvelope[]) {`,
    `  for (let i = events.length - 1; i >= 0; i--) {`,
    `    const env = events[i]!;`,
    `    if (env.type === 'live-event') return env;`,
    `  }`,
    `}`,
  ].join('\n');
  const m = inspect(planted);
  assert.ok(m.scan, 'detector must catch the planted events[] scan');
  assert.ok(m.detector, "detector must catch the planted 'live-event' literal");

  // And a guard-frame variant (named `*ChangedLiveEventFrame`) must also trip.
  const guardVariant = [
    `import { isWorkItemChangedLiveEventFrame } from '@/features/work-items/live-events';`,
    `export function leak2(events: unknown[]) {`,
    `  return events.find((e) => isWorkItemChangedLiveEventFrame(e));`,
    `}`,
  ].join('\n');
  const g = inspect(guardVariant);
  assert.ok(g.scan, 'detector must catch events.find scan');
  assert.ok(g.detector, 'detector must catch the *ChangedLiveEventFrame guard');

  // It must NOT trip on a scan WITHOUT a live-event detector (the allowed legacy
  // bare-envelope scanners: attachment-changed / setup-wizard-* / workflow-builder-*).
  const bareEnvelopeScan = [
    `export function legacy(events: unknown[]) {`,
    `  for (let i = events.length - 1; i >= 0; i--) {`,
    `    const env = events[i];`,
    `    if (env.type === 'attachment-changed') return env;`,
    `  }`,
    `}`,
  ].join('\n');
  const bare = inspect(bareEnvelopeScan);
  assert.ok(bare.scan, 'control: it should still see the events scan');
  assert.equal(bare.detector, undefined, 'a bare-envelope scan must NOT match the detector');

  // It must NOT trip on a detector mention that is only a comment or import path,
  // nor on a bare events DECLARATION (useState / return) without any scan.
  const declOnly = [
    `// the canonical {type:'live-event', event} frame is handled by the store`,
    `import { isLiveEventFrame } from '@/store/live-store';`,
    `export function holder() {`,
    `  const [events, setEvents] = useState<unknown[]>([]);`,
    `  return { events, setEvents };`,
    `}`,
  ].join('\n');
  const d = inspect(declOnly);
  assert.equal(d.scan, undefined, 'a bare events declaration/return must NOT count as a scan');
  assert.equal(
    d.detector,
    undefined,
    'a detector mention only in a comment + import path must NOT count',
  );
});
