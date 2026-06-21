// path-guard.cjs — multi-mode CC hook for worktree binding + enforcement.
//
// Argv: node path-guard.cjs <mode>
//   gate-workflow — PreToolUse on Agent|Task: deny any Task call whose prompt
//                   doesn't carry the "[workflowRunId: ...]" token (i.e., not a
//                   workflow-runtime dispatch). Subagents are workflow-only
//                   (Section 3 D1); the orchestrator must route through
//                   pc_run_workflow. Runs BEFORE bind on the same matcher.
//   bind          — PreToolUse on Agent|Task: scan tool_input.prompt for the
//                   "[worktree: <abs-path>]" token; write a binding to
//                   <project-data-dir>/current-task-binding.json keyed by tool_use_id.
//   unbind        — PostToolUse on Agent|Task: drop that binding.
//   enforce       — PreToolUse on Read|Write|Edit|Bash|Glob|Grep|NotebookEdit.
//                   TWO protections (2026-06-03 incident — an agent destroyed
//                   uncommitted human work with git reset/checkout/clean in the
//                   MAIN repo):
//                   1. WORKTREE CONFINEMENT (workflow agents + bound subagents):
//                      every tool call must stay inside the bound worktree.
//                   2. GIT WRITE FENCE (AGENT SESSIONS ONLY — the orchestrator
//                      is exempt): for a dispatched agent, a git command that
//                      WRITES (anything beyond status/log/diff/show/…) aimed at
//                      a directory outside its fence root is denied. Fence root
//                      = the bound worktree, else the agent's session cwd. The
//                      ORCHESTRATOR is trusted to run git anywhere — it owns
//                      merges, landing, and cross-project work, so the fence
//                      never applies to it (detected by the absence of the
//                      agent-only env markers PC_AGENT_RUN_ID / PC_WORKFLOW_*).
//
// ⚠ CC ≥2.1 reports `agent_type` for the MAIN thread of --agent sessions, so
// payload.agent_type does NOT mean "inside a Task() subagent". Caught live
// 2026-06-03: every workflow agent took the subagent branch, found no binding,
// and SILENTLY SKIPPED enforcement. Workflow env is now checked FIRST; the
// binding branch only applies when a binding actually exists.
//
// Bash path scanning is best-effort string analysis, not a sandbox. It catches
// honest mistakes (the only observed failure class), not adversaries. Handles
// both Windows (`E:/…`, `E:\…`) and Git-Bash (`/e/…`) absolute path forms.

const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { dirname, resolve, join } = require('node:path');
const { homedir } = require('node:os');

const BINDING_FILE = '{{PROJECT_DATA_DIR}}/current-task-binding.json';

/** Playwright browser cache root — allowed for READ and BASH path references so
 *  QA agents can inspect/run browser binaries without path-guard denials.
 *  WRITE/EDIT to this path is still blocked (enforced separately per tool).
 *  Resolution order: env var → platform default. */
function getPlaywrightBrowsersRoot() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    return resolve(toWinPath(process.env.PLAYWRIGHT_BROWSERS_PATH));
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return resolve(join(localAppData, 'ms-playwright'));
  }
  if (process.platform === 'darwin') {
    return resolve(join(homedir(), 'Library', 'Caches', 'ms-playwright'));
  }
  // Linux / other POSIX
  const xdgCache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return resolve(join(xdgCache, 'ms-playwright'));
}

// Computed once at load time — safe since env vars don't change during a hook run.
const PLAYWRIGHT_BROWSERS_ROOT = getPlaywrightBrowsersRoot();

/** git subcommands that cannot destroy or rewrite work. Everything NOT in this
 *  set counts as a WRITE and is fenced. Deliberately conservative: `branch`,
 *  `config`, `worktree`, `fetch` all have writing forms, so they fence too —
 *  a PC session has no business running them outside its own fence root.
 *  (Declared before the mode dispatch below — consts don't hoist.) */
const GIT_READONLY = new Set([
  'status', 'log', 'show', 'diff', 'rev-parse', 'describe', 'blame', 'grep',
  'ls-files', 'ls-tree', 'ls-remote', 'cat-file', 'shortlog', 'reflog',
  'rev-list', 'show-ref', 'symbolic-ref', 'remote', 'version', 'help',
]);

const mode = process.argv[2] ?? '';
const raw = readStdinSync();
let payload = {};
try { payload = JSON.parse(raw); } catch { /* keep empty */ }

if (mode === 'gate-workflow') gateWorkflow();
else if (mode === 'bind') bind();
else if (mode === 'unbind') unbind();
else if (mode === 'enforce') enforce();
process.exit(0);

function readStdinSync() {
  try { return readFileSync(0, 'utf-8'); } catch { return ''; }
}

function readBindings() {
  try { return JSON.parse(readFileSync(BINDING_FILE, 'utf-8')); } catch { return {}; }
}

function writeBindings(b) {
  try {
    mkdirSync(dirname(BINDING_FILE), { recursive: true });
    writeFileSync(BINDING_FILE, JSON.stringify(b, null, 2));
  } catch { /* best-effort */ }
}

/** Git-Bash drive form → Windows form: `/e/foo` → `e:/foo`. */
function toWinPath(p) {
  const m = /^\/([A-Za-z])(\/|$)/.exec(p);
  return m ? `${m[1]}:/${p.slice(3)}` : p;
}

function norm(p) {
  return resolve(toWinPath(p)).replace(/\\/g, '/').toLowerCase();
}

function isInside(p, root) {
  const pN = norm(p);
  const rootN = norm(root);
  return pN === rootN || pN.startsWith(rootN + '/');
}

/** Absolute path in either Windows or Git-Bash drive form? */
function isAbsoluteish(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\/[A-Za-z](\/|$)/.test(p) || p.startsWith('\\\\') || p.startsWith('/');
}

function resolveAgainst(cwd, p) {
  const w = toWinPath(p);
  return isAbsoluteish(w) ? resolve(w) : resolve(cwd, w);
}

function extractWorktree(prompt) {
  if (typeof prompt !== 'string') return null;
  const m = prompt.match(/\[worktree:\s*([^\]]+)\]/);
  return m ? resolve(m[1].trim()) : null;
}

function deny(reason) {
  const out = {
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(out));
}

function gateWorkflow() {
  // PC product policy: subagents inside PC-spawned claude.exe are
  // workflow-only (Section 3 D1). The workflow runtime emits a dispatch
  // envelope containing "[workflowRunId: <id>]"; a Task() call without it
  // is a direct orchestrator dispatch and we deny it.
  //
  // BUT: the same `.claude/settings.json` loads in any claude.exe that
  // opens this repo — including the engineer running Claude Code as a dev
  // tool. PC's policy doesn't apply there; Task() should work normally.
  // Distinguish via PC_PROJECT_ID, which apps/server sets on every spawn
  // (orchestrator + dispatched agent). Absent = outer/dev session = skip.
  if (!process.env.PC_PROJECT_ID) return;

  const prompt = payload.tool_input && payload.tool_input.prompt;
  if (typeof prompt === 'string' && prompt.includes('[workflowRunId:')) return;
  deny(
    'Direct Task() blocked. Subagents are workflow-only — author a workflow ' +
    'that dispatches the agent (via the conversational New Workflow modal), ' +
    'then call `pc_run_workflow` with its id.',
  );
}

function bind() {
  const tu = payload.tool_use_id;
  const wt = extractWorktree(payload.tool_input && payload.tool_input.prompt);
  if (!tu || !wt) return;
  const all = readBindings();
  all[tu] = { worktreePath: wt, startedAt: new Date().toISOString() };
  writeBindings(all);
}

function unbind() {
  const tu = payload.tool_use_id;
  if (!tu) return;
  const all = readBindings();
  if (all[tu]) {
    delete all[tu];
    writeBindings(all);
  }
}

// ── git write fence ───────────────────────────────────────────────────────────

function unquote(m2, m3, m4, m5) {
  return m2 || m3 || m4 || m5 || '';
}

/** Scan a shell command for git WRITE invocations whose effective directory
 *  sits outside `fence`. Tracks `cd` across `&&`/`;`/`|` segments and honors
 *  `git -C <path>`. Returns { sub, dir } for the first violation, else null. */
function gitWriteFenceViolation(cmd, fence, sessionCwd) {
  if (!/\bgit\b/.test(cmd)) return null;
  let cwd = sessionCwd ? resolve(toWinPath(sessionCwd)) : resolve(fence);
  const segments = cmd.split(/&&|\|\||;|\|/);
  for (const seg of segments) {
    const cdm = /(?:^|\s)cd\s+(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s&|;]+))/.exec(seg);
    if (cdm) {
      const target = unquote(cdm[1], cdm[2], cdm[3], cdm[4]);
      if (target && target !== '-') cwd = resolveAgainst(cwd, target);
    }
    const gm = /(?:^|\s|\()git\s+(.*)$/.exec(seg);
    if (!gm) continue;
    let rest = gm[1].trim();
    let gitDir = cwd;
    // Consume leading global flags that affect the target dir or precede the
    // subcommand: -C <path>, -c k=v, --git-dir[= ]<path>, --work-tree[= ]<path>.
    for (;;) {
      let m = /^-C\s+(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s&|;]+))\s+/.exec(rest);
      if (m) { gitDir = resolveAgainst(gitDir, unquote(m[1], m[2], m[3], m[4])); rest = rest.slice(m[0].length); continue; }
      m = /^-c\s+\S+\s+/.exec(rest);
      if (m) { rest = rest.slice(m[0].length); continue; }
      m = /^(?:--git-dir|--work-tree)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s&|;]+))\s*/.exec(rest);
      if (m) { gitDir = resolveAgainst(gitDir, unquote(m[1], m[2], m[3], m[4])); rest = rest.slice(m[0].length); continue; }
      break;
    }
    const subm = /^([a-z][a-z-]*)/.exec(rest);
    const sub = subm ? subm[1] : '';
    if (!sub || GIT_READONLY.has(sub)) continue;
    if (!isInside(gitDir, fence)) return { sub, dir: gitDir };
  }
  return null;
}

// ── enforce ───────────────────────────────────────────────────────────────────

function enforce() {
  // Resolve the bound worktree (FULL confinement scope):
  //   1. Any agent with a bound worktree — PC_WORKFLOW_WORKTREE env. Set at
  //      spawn by dag-run-service (workflow nodes) AND by the agent-runs invoke
  //      route for direct isolation:worktree dispatches. Checked FIRST:
  //      payload.agent_type is set on the MAIN thread of --agent sessions in
  //      CC ≥2.1, so it cannot be used to detect subagents (the 2026-06-03
  //      silent-skip regression). PC_WORKFLOW_WORKTREE is the single correct
  //      confinement signal — do NOT also require PC_WORKFLOW_RUN_ID: that
  //      gated out direct isolation:worktree dispatches, so their absolute-path
  //      writes to the main checkout went completely unguarded (pc-pty-chat-348).
  //   2. Task() subagents — most-recent binding written by 'bind' mode. Only
  //      applies when a binding actually exists.
  let wt = null;
  if (process.env.PC_WORKFLOW_WORKTREE) {
    wt = resolve(process.env.PC_WORKFLOW_WORKTREE);
  } else if (payload.agent_type) {
    const all = readBindings();
    const ids = Object.keys(all);
    const latest = ids.length ? all[ids[ids.length - 1]] : null;
    if (latest && latest.worktreePath) wt = resolve(latest.worktreePath);
  }

  const tool = payload.tool_name || '';
  const inp = payload.tool_input || {};

  // ── GIT WRITE FENCE — AGENT SESSIONS ONLY. The orchestrator owns merges,
  // landing, and cross-project git work, so it is NEVER git-fenced; only
  // dispatched agents are. An agent session is identified by a bound worktree
  // (wt) or the agent-only env markers set at spawn (PC_AGENT_RUN_ID by the
  // agent-run factory, PC_WORKFLOW_WORKTREE / PC_WORKFLOW_RUN_ID by the
  // workflow runtime). The orchestrator carries none of these. Fence root =
  // the bound worktree when one exists, else the agent's session cwd.
  // Outer/dev sessions (no PC_PROJECT_ID) are exempt.
  const isAgentSession = !!wt
    || !!process.env.PC_AGENT_RUN_ID
    || !!process.env.PC_WORKFLOW_WORKTREE
    || !!process.env.PC_WORKFLOW_RUN_ID;
  if (tool === 'Bash' && process.env.PC_PROJECT_ID && isAgentSession) {
    const fence = wt || (payload.cwd ? resolve(payload.cwd) : null);
    if (fence) {
      const v = gitWriteFenceViolation(String(inp.command || ''), fence, payload.cwd);
      if (v) {
        deny(
          `Blocked: \`git ${v.sub}\` would write to a repository outside your fence ` +
          `(${v.dir}). Your fence root: ${fence}. Writing git commands (add/commit/` +
          `reset/checkout/clean/…) are only allowed inside it. If you created files ` +
          `in the wrong place, STOP and report it in your deliverable — do NOT try ` +
          `to clean up directories outside your fence.`,
        );
        return;
      }
    }
  }

  // ── FULL WORKTREE CONFINEMENT — only for sessions with a bound worktree.
  if (!wt) return;

  // Pods with cross-worktree read permission: Read/Glob/Grep exempt from
  // worktree binding. Edit/Write/Bash/NotebookEdit stay bound. Add pod names
  // here as they earn the exemption.
  const agentName = process.env.PC_AGENT_NAME || payload.agent_type || '';
  const READ_ANYWHERE_PODS = new Set(['researcher']);
  if (READ_ANYWHERE_PODS.has(agentName) && (tool === 'Read' || tool === 'Glob' || tool === 'Grep')) {
    return;
  }

  const violations = [];

  /** Path is inside the worktree OR inside the Playwright browser cache (read
   *  exemption — QA agents need to inspect/execute browsers). Write/Edit use a
   *  stricter check that excludes the Playwright exemption so the write boundary
   *  is unchanged. */
  function isAllowedReadPath(p) {
    return isInside(p, wt) || isInside(p, PLAYWRIGHT_BROWSERS_ROOT);
  }

  function checkPath(p, allowPlaywrightRoot) {
    if (!p || typeof p !== 'string') return;
    const allowed = allowPlaywrightRoot ? isAllowedReadPath(p) : isInside(p, wt);
    if (!allowed) violations.push(p);
  }

  // Read / Glob / Grep: playwright cache reads allowed (agents may inspect
  // browser binary paths or read playwright output files).
  if (tool === 'Read') checkPath(inp.file_path, true);
  if ((tool === 'Glob' || tool === 'Grep') && inp.path) checkPath(inp.path, true);
  // Write / Edit / NotebookEdit: strict — no playwright exemption; write
  // boundary is unchanged.
  if (tool === 'Write' || tool === 'Edit') checkPath(inp.file_path, false);
  if (tool === 'NotebookEdit') checkPath(inp.notebook_path, false);
  if (tool === 'Bash') {
    const cmd = String(inp.command || '');
    // Best-effort: scan for absolute paths in BOTH Windows drive-letter form
    // (E:/… / E:\…) and Git-Bash form (/e/…). Quoted forms first so paths
    // containing spaces aren't truncated at the first whitespace.
    const re = /'([A-Za-z]:[\\/][^']+|\/[A-Za-z]\/[^']+)'|"([A-Za-z]:[\\/][^"]+|\/[A-Za-z]\/[^"]+)"|`([A-Za-z]:[\\/][^`]+|\/[A-Za-z]\/[^`]+)`|([A-Za-z]:[\\/][^\s'"`)]+|\/[A-Za-z]\/[^\s'"`):]+)/g;
    let m;
    while ((m = re.exec(cmd)) !== null) {
      const path = m[1] || m[2] || m[3] || m[4];
      // Playwright cache paths are read-allowed: QA agents run `playwright
      // install`, `dir <cache>`, or pass the browser executable path to the
      // launcher — none of these require the write boundary to move.
      if (path && !isAllowedReadPath(path)) violations.push(path);
    }
  }

  if (violations.length) {
    deny(
      `Out-of-worktree call blocked. Bound worktree: ${wt}. ` +
      `Violating path(s): ${violations.join(', ')}`,
    );
  }
}
