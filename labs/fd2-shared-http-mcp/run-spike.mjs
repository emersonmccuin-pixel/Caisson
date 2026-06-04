// FD-2 spike driver. Fully automated, positive-receipt only:
//
//   phase 1  spawn the shared HTTP MCP server + THREE interactive claude.exe
//            clients (A/B/C), each with its own .mcp.json pointing at the ONE
//            URL with its own X-PC-Probe header. Prompt is sent AT banner-ready
//            (deliberately recreating the stdio turn-1 race) asking each to
//            call spike_whoami + spike_slow and paste the raw JSON.
//   phase 2  SIGKILL the server, restart it (new bootId), ask client A to call
//            spike_whoami again → a result carrying the NEW bootId proves
//            claude.exe re-initialized against the restarted server.
//
// Receipts are read from each session's on-disk JSONL transcript (tool results
// are server-stamped JSON), never inferred from terminal scrape. Every wait
// has a deadline → typed FAIL, no silent hang.
//
// Run:  node run-spike.mjs     (from this directory; takes ~2-4 minutes)

import { spawn as spawnChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireFromRuntime = createRequire(
  new URL('../../packages/runtime/package.json', import.meta.url),
);
const pty = requireFromRuntime('node-pty');

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CLAUDE_EXE = process.env.CLAUDE_EXE ?? join(homedir(), '.local', 'bin', 'claude.exe');
const URL_MCP = 'http://127.0.0.1:4555/mcp';
const WORK = resolve(HERE, '.work');
const PROBES = ['A', 'B', 'C'];

// ── helpers ──────────────────────────────────────────────────────────────────

const t0 = Date.now();
const ms = () => `${String(Date.now() - t0).padStart(6)}ms`;
function log(line) {
  console.log(`${ms()}  ${line}`);
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

/** CC encodes the absolute cwd as the transcript dir name. Pinned against CC
 *  source sessionStoragePortable.ts:311 — EVERY non-alphanumeric byte → '-'
 *  (dots too; `.work` → `-work` caught live in this spike's first run). */
function encodeCwd(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

const IDE_ENV_PREFIXES = ['VSCODE_', 'CLAUDE_CODE_'];
const IDE_ENV_KEYS = new Set(['TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'GIT_ASKPASS']);
function scrubbedEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (IDE_ENV_KEYS.has(k)) continue;
    if (IDE_ENV_PREFIXES.some((p) => k.startsWith(p))) continue;
    out[k] = v;
  }
  out.FORCE_COLOR = '0';
  out.DISABLE_AUTOUPDATER = '1';
  return out;
}

/** Poll `check()` every 400ms until truthy or deadline → null. */
async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > deadline) {
      log(`✘ TIMEOUT waiting for ${label} (${timeoutMs}ms)`);
      return null;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

// ── server management ────────────────────────────────────────────────────────

let serverChild = null;
function startServer() {
  serverChild = spawnChild(process.execPath, [join(HERE, 'server.mjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let bootId = null;
  serverChild.stdout.on('data', (d) => {
    const line = d.toString();
    const m = line.match(/\[boot ([0-9a-f]+)\]/);
    if (m && !bootId) bootId = m[1];
    process.stdout.write(`        [server] ${line.trimEnd()}\n`);
  });
  serverChild.stderr.on('data', (d) => process.stdout.write(`        [server!] ${d}`));
  return () => bootId;
}

// ── client session ───────────────────────────────────────────────────────────

class SpikeClient {
  constructor(probe) {
    this.probe = probe;
    this.sessionId = randomUUID();
    this.dir = join(WORK, `client-${probe}`);
    this.buf = '';
    this.trustSent = false;
    this.bannerAt = null;
    this.promptSentAt = null;
    mkdirSync(this.dir, { recursive: true });
    this.mcpPath = join(this.dir, 'mcp.json');
    writeFileSync(
      this.mcpPath,
      JSON.stringify(
        {
          mcpServers: {
            spike: { type: 'http', url: URL_MCP, headers: { 'X-PC-Probe': probe } },
          },
        },
        null,
        2,
      ),
    );
    this.transcript = join(
      homedir(),
      '.claude',
      'projects',
      encodeCwd(this.dir),
      `${this.sessionId}.jsonl`,
    );
  }

  spawn() {
    this.child = pty.spawn(
      CLAUDE_EXE,
      [
        '--session-id',
        this.sessionId,
        '--mcp-config',
        this.mcpPath,
        '--strict-mcp-config',
        '--dangerously-skip-permissions',
      ],
      { cwd: this.dir, env: scrubbedEnv(), cols: 120, rows: 30 },
    );
    this.child.onData((d) => {
      this.buf += d;
      const clean = stripAnsi(this.buf);
      if (
        !this.trustSent &&
        (/Quick\s*safety\s*check/i.test(clean) ||
          /Is\s*this\s*a\s*project\s*you\s*created/i.test(clean) ||
          /Yes,\s*I\s*trust\s*this\s*folder/i.test(clean))
      ) {
        this.trustSent = true;
        log(`[${this.probe}] trust prompt → Enter`);
        this.child.write('\r');
      }
      if (
        !this.bannerAt &&
        (/Welcome\s*back/i.test(clean.replace(/\s+/g, ' ')) ||
          /Tips\s*for\s*getting\s*started/i.test(clean) ||
          /What's\s*new/i.test(clean) ||
          /Try\s*"/i.test(clean))
      ) {
        this.bannerAt = Date.now();
        log(`[${this.probe}] banner ready`);
      }
    });
    log(`[${this.probe}] spawned claude.exe  session=${this.sessionId.slice(0, 8)}…`);
  }

  send(text) {
    this.promptSentAt = Date.now();
    this.child.write(text);
    // Submit, then nudge once more — Enter sent too soon after the banner can
    // be swallowed (observed live: client A's turn-1 text sat unsubmitted in
    // the composer). A second \r on an empty composer is a no-op.
    setTimeout(() => this.child.write('\r'), 300);
    setTimeout(() => this.child.write('\r'), 1800);
    log(`[${this.probe}] prompt sent`);
  }

  /** All spike-tool JSON payloads present in the transcript so far. Parse each
   *  JSONL line as JSON and WALK it (tool_result text blocks live at varying
   *  depths); extract every flat `{"tool":"spike_…"}` payload from the
   *  collected strings. */
  receipts() {
    if (!existsSync(this.transcript)) return [];
    const texts = [];
    const walk = (v) => {
      if (typeof v === 'string') {
        if (v.includes('{"tool":"spike_')) texts.push(v);
        return;
      }
      if (Array.isArray(v)) {
        for (const x of v) walk(x);
        return;
      }
      if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
    };
    for (const line of readFileSync(this.transcript, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        walk(JSON.parse(line));
      } catch {
        /* partial trailing line — next poll gets it */
      }
    }
    const out = [];
    for (const t of texts) {
      let idx = 0;
      for (;;) {
        const at = t.indexOf('{"tool":"spike_', idx);
        if (at < 0) break;
        const end = t.indexOf('}', at); // payloads are flat — first } closes
        if (end < 0) break;
        try {
          out.push(JSON.parse(t.slice(at, end + 1)));
        } catch {
          /* mid-stream fragment */
        }
        idx = at + 1;
      }
    }
    // De-dup (a payload can appear in the tool_result AND the model's echo).
    const seen = new Set();
    return out.filter((r) => {
      const k = JSON.stringify(r);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  kill() {
    try {
      this.child?.kill();
    } catch {
      /* already gone */
    }
  }
}

// ── the spike ────────────────────────────────────────────────────────────────

const results = { criteria: {}, notes: [] };
function verdict(key, pass, note) {
  results.criteria[key] = { pass, note };
  log(`${pass ? '✔ PASS' : '✘ FAIL'}  ${key} — ${note}`);
}

if (existsSync(WORK)) rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

if (!existsSync(CLAUDE_EXE)) {
  console.error(`claude.exe not found at ${CLAUDE_EXE} (set CLAUDE_EXE to override)`);
  process.exit(1);
}

log(`server: starting`);
const getBootId = startServer();
await waitFor(() => getBootId(), 10_000, 'server boot');
const bootId1 = getBootId();
log(`server boot 1 = ${bootId1}`);

const clients = PROBES.map((p) => new SpikeClient(p));
for (const c of clients) c.spawn();

// Send the phase-1 prompt AT banner (the historical stdio race window).
const PROMPT_1 =
  'Call the MCP tool spike_whoami, then call spike_slow. Then reply with the two raw JSON strings the tools returned and nothing else. If a tool is not available yet, say TOOLS-MISSING and stop.';

for (const c of clients) {
  const ok = await waitFor(() => c.bannerAt, 60_000, `[${c.probe}] banner`);
  if (ok) {
    // ~500ms after banner — still inside the historical race window, but past
    // the input-swallow zone observed at banner+1ms.
    await new Promise((r) => setTimeout(r, 500));
    c.send(PROMPT_1);
  }
}

// Collect phase-1 receipts: each client needs a whoami + a slow payload.
const phase1 = await waitFor(
  () =>
    clients.every((c) => {
      const r = c.receipts();
      return (
        r.some((x) => x.tool === 'spike_whoami') && r.some((x) => x.tool === 'spike_slow')
      );
    }),
  90_000,
  'phase-1 receipts from all clients',
);

// Retry once for clients that hit the turn-1 race (that's a finding, not a
// failure — record it).
if (!phase1) {
  for (const c of clients) {
    const r = c.receipts();
    if (!r.some((x) => x.tool === 'spike_whoami')) {
      results.notes.push(`[${c.probe}] turn-1 receipts missing — sent retry turn`);
      c.send('Try again now: call spike_whoami then spike_slow and paste both raw JSON results.');
    }
  }
  await waitFor(
    () =>
      clients.every((c) => {
        const r = c.receipts();
        return (
          r.some((x) => x.tool === 'spike_whoami') && r.some((x) => x.tool === 'spike_slow')
        );
      }),
    60_000,
    'phase-1 receipts after retry',
  );
}

// ── judge phase 1 ────────────────────────────────────────────────────────────

const all = clients.map((c) => ({ c, receipts: c.receipts() }));

// 1. connect + tools listed (any receipt at all proves list+call worked)
verdict(
  'connect',
  all.every((x) => x.receipts.length > 0),
  all.map((x) => `${x.c.probe}:${x.receipts.length} receipts`).join('  '),
);

// 2. identity — every receipt for client X carries probe X
const identityOk = all.every((x) => x.receipts.every((r) => r.probe === x.c.probe));
verdict(
  'identity',
  identityOk && all.every((x) => x.receipts.length > 0),
  all
    .map((x) => `${x.c.probe}→[${[...new Set(x.receipts.map((r) => r.probe))].join(',')}]`)
    .join('  ') +
    `  (source: ${[...new Set(all.flatMap((x) => x.receipts.map((r) => r.identitySource)))].join(',')})`,
);

// 3. session isolation — distinct MCP sessions per client
const sessions = all.map((x) => new Set(x.receipts.map((r) => r.mcpSessionId)));
const flat = sessions.flatMap((s) => [...s]);
verdict(
  'session-isolation',
  new Set(flat).size === flat.length || sessions.every((s, i) =>
    [...s].every((sid) => sessions.every((o, j) => i === j || !o.has(sid))),
  ),
  `mcp sessions per client: ${sessions.map((s) => s.size).join('/')}, no cross-sharing`,
);

// 4. concurrency — the three spike_slow windows overlap (server slept 2s each;
//    serialized they'd be ≥6s end-to-end, parallel ≈2s)
const slows = all
  .flatMap((x) => x.receipts.filter((r) => r.tool === 'spike_slow'))
  .map((r) => ({ s: Date.parse(r.startedAt), e: Date.parse(r.finishedAt) }));
const overlap =
  slows.length === 3 &&
  Math.max(...slows.map((w) => w.s)) < Math.min(...slows.map((w) => w.e));
verdict(
  'concurrency',
  overlap,
  slows.length === 3
    ? `slow-call windows ${overlap ? 'OVERLAP (parallel)' : 'do not overlap (serialized?)'}`
    : `only ${slows.length}/3 slow receipts`,
);

// 5. timing — banner→first whoami receipt per client
for (const x of all) {
  const first = x.receipts.find((r) => r.tool === 'spike_whoami');
  if (first && x.c.promptSentAt) {
    const dt = Date.parse(first.finishedAt) - x.c.promptSentAt;
    results.notes.push(`[${x.c.probe}] prompt→whoami-served: ${dt}ms`);
    log(`[${x.c.probe}] prompt→whoami-served ${dt}ms`);
  }
}
verdict(
  'turn1-tools',
  results.notes.every((n) => !n.includes('retry turn')),
  results.notes.some((n) => n.includes('retry turn'))
    ? 'some client needed a retry turn (turn-1 race still exists over HTTP)'
    : 'all clients called tools on turn 1, no warmup needed',
);

// ── phase 2: server restart ──────────────────────────────────────────────────

log('phase 2: killing server…');
serverChild.kill('SIGKILL');
await new Promise((r) => setTimeout(r, 1500));
log('phase 2: restarting server…');
const getBootId2 = startServer();
await waitFor(() => getBootId2() && getBootId2() !== bootId1, 10_000, 'server boot 2');
const bootId2 = getBootId2();
log(`server boot 2 = ${bootId2}`);

const a = clients[0];
const before = a.receipts().length;
a.send('The tools server was restarted. Call spike_whoami once more and paste the raw JSON.');
const recovered = await waitFor(
  () => a.receipts().slice(before).find((r) => r.tool === 'spike_whoami' && r.serverBootId === bootId2),
  120_000,
  'post-restart whoami with new bootId',
);
verdict(
  'restart-recovery',
  Boolean(recovered),
  recovered
    ? `client A got a receipt from boot ${bootId2} (was ${bootId1}) — reconnect + re-init works`
    : 'no post-restart receipt with the new bootId',
);

// ── wrap up ──────────────────────────────────────────────────────────────────

for (const c of clients) c.kill();
serverChild?.kill('SIGKILL');

results.bootIds = [bootId1, bootId2];
results.finishedAt = new Date().toISOString();
writeFileSync(join(HERE, 'spike-results.json'), JSON.stringify(results, null, 2));

const passes = Object.values(results.criteria).filter((c) => c.pass).length;
const total = Object.keys(results.criteria).length;
log(`DONE — ${passes}/${total} criteria pass. Full detail: spike-results.json`);
process.exit(passes === total ? 0 : 1);
