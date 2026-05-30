export const meta = {
  name: 'refactor-cohesion-pipeline',
  description:
    'Drive the next refactor-pathway sessions (plan/build/verify) under AGENTS.md gates; commit each, update trackers, and stop on a failed gate, a product question, or a slice needing human browser verification.',
  whenToUse:
    'Run from a fresh orchestrator session after reading refactor plan/orchestration/handoff.md, on branch refactor/auto-pathway, with a clean repo.',
  phases: [
    { title: 'Orient' },
    { title: 'Run session' },
    { title: 'Verify' },
  ],
}

// ---------------------------------------------------------------------------
// Schemas — every fact comes back from an agent; the script has no fs/git access.
// ---------------------------------------------------------------------------

const ORIENT = {
  type: 'object',
  additionalProperties: false,
  required: [
    'repoClean', 'currentBranch', 'onRunBranch', 'allSessionsDone',
    'sessionNumber', 'sessionType', 'sliceNumber', 'slicePlanReady', 'sessionPromptVerbatim',
  ],
  properties: {
    repoClean: { type: 'boolean', description: 'true only if `git status --short` is empty' },
    dirtyFiles: { type: 'array', items: { type: 'string' } },
    currentBranch: { type: 'string' },
    onRunBranch: { type: 'boolean', description: 'true if current branch is refactor/auto-pathway (NOT dev or main)' },
    allSessionsDone: { type: 'boolean', description: 'true if every row in the session tracker is checked' },
    sessionNumber: { type: 'integer', description: 'the first unchecked session row number; -1 if none' },
    sessionType: { type: 'string', enum: ['plan', 'build', 'verify', 'none'] },
    sliceNumber: { type: 'string', description: 'e.g. "002"; empty if not applicable' },
    slicePlanPath: { type: 'string', description: 'refactor plan/build-slices/00X-*.md, or empty' },
    slicePlanReady: { type: 'boolean', description: 'for build sessions: does the slice plan exist and is it marked planned/ready' },
    sessionPromptVerbatim: { type: 'string', description: 'the exact Prompt cell from the tracker row' },
  },
}

const SESSION_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['automatedGatesPassed', 'committed', 'needsHumanBrowserTest', 'evidence'],
  properties: {
    automatedGatesPassed: { type: 'boolean' },
    gatesRun: { type: 'array', items: { type: 'string' }, description: 'exact commands run' },
    committed: { type: 'boolean' },
    commitSha: { type: 'string' },
    needsHumanBrowserTest: { type: 'boolean', description: 'true if the slice gate calls for a two-client browser check this session could not run' },
    browserChecklist: { type: 'array', items: { type: 'string' }, description: 'plain steps the human should click to verify' },
    productQuestion: { type: ['string', 'null'], description: 'a decision only the human can make; null if none' },
    blocker: { type: ['string', 'null'], description: 'why a gate failed; null if none' },
    evidence: { type: 'string', description: 'short summary of what was done and gate output' },
    nextSessionHint: { type: 'string' },
  },
}

const LENS = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'inScope', 'verdict'],
  properties: {
    lens: { type: 'string' },
    inScope: { type: 'boolean', description: 'true if the committed diff stays within the named slice scope' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'detail'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          detail: { type: 'string' },
          file: { type: 'string' },
        },
      },
    },
    verdict: { type: 'string', enum: ['pass', 'fail'] },
  },
}

// ---------------------------------------------------------------------------
// Prompt builders. Each agent must follow AGENTS.md exactly. The script is a
// thin loop; the discipline lives in AGENTS.md + the pathway + the slice plan.
// ---------------------------------------------------------------------------

const RULES = `
HARD RULES (from AGENTS.md — non-negotiable):
- Start by running \`git status --short\`. Work only from a clean repo.
- Never restart or kill dev processes (Vite, tsx, Electron, Caisson, Node). Never call restart endpoints.
- Never read, search, or cite anything under archive/. Use rg --glob "!archive/**".
- Keep every change strictly inside the named slice scope. No adjacent-subsystem work.
- Do not push to main and do not merge. Work stays on branch refactor/auto-pathway.
- End by updating the trackers, committing completed work, and confirming \`git status --short\` is clean.
Return ONLY the structured result — your text IS the data, not a human message.`

const orientPrompt = `Orient the refactor orchestration for THIS repo.

1. Run \`git status --short\`. Set repoClean=true only if it is empty; otherwise list dirtyFiles.
2. Report currentBranch. Set onRunBranch=true only if it is exactly "refactor/auto-pathway".
3. Read AGENTS.md and refactor plan/definitive-session-pathway.md.
4. Determine the next session MECHANICALLY — do NOT eyeball the tracker. The tracker has TWO markdown
   tables (Sessions 1-9, then Sessions 10-40 under "## Later Sessions"); a human read is error-prone,
   so you MUST derive the answer from the output of this EXACT command, run verbatim:

       grep -nE '^\\| \\[ \\] \\|' "refactor plan/refactor-session-tracker.md" | head -1

   - If that command prints a line, the FIRST unchecked row IS that line. Parse its Session number
     (the integer in the second pipe-delimited cell) into sessionNumber, set allSessionsDone=false,
     and set sessionType from that row's artifact text (plan | build | verify). Then Read the tracker
     to copy that row's Prompt cell verbatim into sessionPromptVerbatim and read its slice number.
   - Only if that command prints NOTHING (zero matches) may you set allSessionsDone=true,
     sessionNumber=-1, sessionType="none".
   Never set allSessionsDone=true while that grep returns a line. The grep output overrides any
   impression from reading the file. SANITY CHECK: the tracker must contain ~40 session rows across both
   tables. Run \`grep -c '^| \\[' "refactor plan/refactor-session-tracker.md"\`; if it returns far fewer
   than 40 (e.g. a handful), the tracker has been corrupted/truncated — do NOT declare the pathway
   complete. Instead set repoClean=false with dirtyFiles=["tracker truncated"] so the run stops for the
   human.
5. For a build session, check whether refactor plan/build-slices/00X-*.md for that slice exists and is
   marked planned/ready; set slicePlanReady and slicePlanPath accordingly.

Do NOT change any files. Do NOT advance anything. Only inspect and report.
${RULES}`

function sessionPrompt(o) {
  const kind = o.sessionType === 'plan'
    ? `This is a PLANNING session. You may update DOCS ONLY. Create or update the slice plan and trackers. Do not touch implementation code.`
    : `This is a BUILD session. Implement ONLY slice ${o.sliceNumber}. Run the slice's required focused tests, package typechecks, and the in-process two-client test. You cannot run real browser two-client checks (you must not restart the dev stack) — if the slice gate calls for browser verification, run the in-process equivalent and set needsHumanBrowserTest=true with a plain-English browserChecklist for the human.`

  return `You are running refactor pathway Session ${o.sessionNumber} (${o.sessionType}, slice ${o.sliceNumber}).

Follow AGENTS.md, refactor plan/definitive-session-pathway.md, and the slice plan
${o.slicePlanPath || '(named in the pathway)'} exactly.

The tracker prompt for this session, verbatim:
"""
${o.sessionPromptVerbatim}
"""

${kind}

If you hit a product or design choice, make the most reasonable decision, record it briefly as
productQuestion for later human review, and KEEP GOING — do not stop for it. Only stop by setting
automatedGatesPassed=false with a blocker when an automated gate genuinely fails. Human browser
verification is batched to the very end; never block on it.

TRACKER EDITS — STRICT: When you update refactor plan/refactor-session-tracker.md, edit ONLY this
session's own row: flip its Done cell from "[ ]" to "[x]" and fill its Completion Notes cell. Do NOT
rewrite, compress, restructure, re-summarize, reformat, or remove ANY other row or either table header.
The file MUST retain all ~40 session rows across both tables (top table Sessions 1-9, "## Later Sessions"
table Sessions 10-40). Same rule for refactor plan/refactor-tracker.md: change only the cells for this
session's slice, never rewrite the file. Truncating or rewriting a tracker breaks the whole pipeline —
a prior verify session did exactly that. Make each change as a single targeted in-place edit, never a
full-file rewrite. If gate output needs saving, write it under .gatelogs/ (gitignored), never into a tracker.

When done: update refactor plan/refactor-tracker.md and refactor plan/refactor-session-tracker.md, commit
completed work (code + docs), and confirm a clean repo. Report automatedGatesPassed honestly with the
exact gatesRun. If a gate fails, set automatedGatesPassed=false, do NOT mark the slice done, record the
blocker, and follow the pathway Failure Path (add a fix-and-reverify session for the same slice).
${RULES}`
}

function verifyLensPrompt(o, lens) {
  const focus = {
    scope: `Read the committed diff for slice ${o.sliceNumber} (e.g. \`git show\` / \`git diff\` against the slice's base) and the slice plan ${o.slicePlanPath}. Decide whether every change is inside the slice's declared scope. Flag any adjacent-subsystem or out-of-scope edits as blocker findings. Set inScope accordingly.`,
    gates: `Read the slice plan ${o.slicePlanPath} and the trackers' completion notes for slice ${o.sliceNumber}. Confirm the required automated gates (focused tests, package typechecks, in-process two-client) were actually run and reported green, with exact commands. Flag any gate that is claimed but not evidenced. Do NOT run the tests yourself.`,
    regression: `Reason about whether slice ${o.sliceNumber}'s changes could break previously-verified behavior or earlier slices. Read the diff and the relevant contracts/services. Flag plausible regressions as findings. Do NOT run tests; this is static analysis only.`,
  }[lens]

  return `Adversarial verification lens "${lens}" for refactor slice ${o.sliceNumber}.
${focus}
Be skeptical: your job is to find reasons this slice is NOT safe to mark implemented. This is read-only
analysis — do not edit files, do not run the test suite, do not restart anything.
${RULES}`
}

function verifySynthPrompt(o, lensResults) {
  return `You are running refactor pathway Session ${o.sessionNumber}: verify/close slice ${o.sliceNumber}.

Lens analyses (read-only) from parallel reviewers:
"""
${JSON.stringify(lensResults, null, 2)}
"""

Follow AGENTS.md and refactor plan/definitive-session-pathway.md. Verify/close session rules: you may fix
ONLY defects inside slice ${o.sliceNumber}; broader work becomes a new planned slice.

Steps:
1. Run the slice's required automated gates (focused tests, package typechecks, in-process two-client).
   Record exact gatesRun.
2. If the lens reviewers raised in-scope blocker/major findings OR a gate fails: fix only in-scope
   defects and re-run gates. If it still fails, set automatedGatesPassed=false, record the blocker, and
   follow the pathway Failure Path (add a fix-and-reverify session for the same slice). Do NOT mark the
   slice implemented.
3. If gates pass and no blocking findings remain: mark slice ${o.sliceNumber} implemented in
   refactor plan/refactor-tracker.md, check the session row in refactor plan/refactor-session-tracker.md,
   and tag the verified slice so the human can back up to it: \`git tag slice-${o.sliceNumber}-verified\`.
   Set needsHumanBrowserTest=true and provide a plain-English browserChecklist; note in the tracker that
   the slice is automated-verified, browser pending (the human browser-tests every section at the end).
4. Commit all completed changes and confirm a clean repo.

TRACKER EDITS — STRICT: In BOTH refactor plan/refactor-session-tracker.md and
refactor plan/refactor-tracker.md, edit ONLY the cells belonging to THIS session/slice (flip this
session's Done cell "[ ]"→"[x]", fill its Completion Notes, set this slice's status to done). Do NOT
rewrite, compress, restructure, re-summarize, reformat, or remove ANY other row, cell, or table header.
The session tracker MUST retain all ~40 session rows across both tables. Make a single targeted in-place
edit per file, never a full-file rewrite. Save any gate output under .gatelogs/ (gitignored), never into
a tracker. A previous verify session truncated both trackers to stubs and broke the pipeline — do not
repeat that.
${RULES}`
}

// ---------------------------------------------------------------------------
// The loop.
// ---------------------------------------------------------------------------

const cap = (args && Number(args.maxSessions)) || 40
const advanced = []
const awaitingBrowser = []
const openQuestions = []
let stop = null

for (let i = 0; i < cap && !stop; i++) {
  phase('Orient')
  const o = await agent(orientPrompt, { schema: ORIENT, label: `orient #${i + 1}` })

  if (!o.repoClean) { stop = { reason: 'dirty repo', detail: o.dirtyFiles || [] }; break }
  if (!o.onRunBranch) { stop = { reason: 'not on run branch refactor/auto-pathway', detail: o.currentBranch }; break }
  if (o.allSessionsDone || o.sessionType === 'none' || o.sessionNumber < 0) { stop = { reason: 'pathway complete — all sessions checked' }; break }
  if (o.sessionType === 'build' && !o.slicePlanReady) { stop = { reason: `build blocked: slice ${o.sliceNumber} plan not ready`, detail: o.slicePlanPath }; break }

  let r
  if (o.sessionType === 'verify') {
    phase('Verify')
    const lenses = ['scope', 'gates', 'regression']
    const lensResults = (await parallel(
      lenses.map((l) => () => agent(verifyLensPrompt(o, l), { schema: LENS, label: `verify:${l} ${o.sliceNumber}`, phase: 'Verify' })),
    )).filter(Boolean)
    r = await agent(verifySynthPrompt(o, lensResults), { schema: SESSION_RESULT, label: `verify/close ${o.sliceNumber}`, phase: 'Verify' })
  } else {
    phase('Run session')
    r = await agent(sessionPrompt(o), { schema: SESSION_RESULT, label: `${o.sessionType} ${o.sliceNumber}` })
  }

  if (!r.committed || !r.automatedGatesPassed) {
    stop = { reason: `Session ${o.sessionNumber} (${o.sessionType}) gate failed`, blocker: r.blocker, evidence: r.evidence }
    break
  }

  advanced.push({ session: o.sessionNumber, type: o.sessionType, slice: o.sliceNumber, commit: r.commitSha || null })
  if (r.needsHumanBrowserTest) awaitingBrowser.push({ slice: o.sliceNumber, checklist: r.browserChecklist || [] })
  log(`Session ${o.sessionNumber} (${o.sessionType} ${o.sliceNumber}) committed; gates green.`)

  if (r.productQuestion) openQuestions.push({ session: o.sessionNumber, slice: o.sliceNumber, question: r.productQuestion })
}

if (!stop) stop = { reason: `safety cap reached (${cap} sessions this run)` }

return {
  advanced,
  awaitingBrowser,
  openQuestions,
  stop,
  humanNextStep:
    awaitingBrowser.length > 0
      ? 'Test the awaiting-browser slices on branch refactor/auto-pathway, then re-run this workflow to continue.'
      : 'Review the stop reason. If it is a gate failure or product question, resolve it, then re-run this workflow.',
}
