// Throwaway seed for README screenshots. Populates a CLEAN sandbox DB
// (PC_DATA_DIR) with realistic non-developer demo content: Sales / People Ops /
// Engineering / Growth projects, work items, past chat sessions, and one
// conversational workflow. NOT shipped — run against a sandbox data dir only.
//
//   PC_DATA_DIR=<sandbox> tsx scripts/seed-demo.ts

import { createHash } from 'node:crypto';

import {
  runMigrations,
  getRawDb,
  createProject,
  createWorkItem,
  workflowsRepo,
  newId,
} from '@pc/db';
import type { Stage } from '@pc/domain';
import { parseWorkflowV2Text } from '@pc/workflows';

const now = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;

function stages(labels: [string, string][]): Stage[] {
  // labels: [id, name]; first = isNew, second-to-last (before cancelled) = isDone.
  const work = labels;
  return [
    ...work.map(([id, name], i) => ({
      id,
      name,
      order: i,
      ...(i === 0 ? { isNew: true } : {}),
      ...(i === work.length - 1 ? { isDone: true } : {}),
    })),
    { id: 'cancelled', name: 'Cancelled', order: work.length, isCancelled: true },
  ];
}

function seedSessions(
  projectId: string,
  titles: { title: string; agoMin: number; active?: boolean }[],
): void {
  const db = getRawDb();
  const insert = db.prepare(
    `INSERT INTO orchestrator_sessions
       (id, project_id, provider, provider_session_id, model, title, status,
        ended_reason, started_at, ended_at, deleted_at, jsonl_path, jsonl_line_cursor)
     VALUES (@id, @projectId, 'claude', @psid, 'claude-opus-4-8', @title, @status,
        NULL, @startedAt, @endedAt, NULL, NULL, 0)`,
  );
  for (const t of titles) {
    const startedAt = now - t.agoMin * MIN;
    insert.run({
      id: newId(),
      projectId,
      psid: newId(),
      title: t.title,
      status: t.active ? 'active' : 'ended',
      startedAt,
      endedAt: t.active ? null : startedAt + 18 * MIN,
    });
  }
}

// ── boot ────────────────────────────────────────────────────────────────────
runMigrations();
console.log('[seed] migrations applied');

// ── 1. Sales (the hero) ───────────────────────────────────────────────────────
const sales = createProject({
  slug: 'sales',
  name: 'Sales',
  folderPath: 'C:\\Work\\Sales',
  stages: stages([
    ['follow-up', 'To follow up'],
    ['drafting', 'Drafting'],
    ['review', 'Needs review'],
    ['sent', 'Sent'],
  ]),
});

// Rich card for the inspector shot — body + children + activity.
const acme = createWorkItem({
  projectId: sales.id,
  stageId: 'follow-up',
  type: 'task',
  title: 'Follow-up — Acme Corp (Diana Reyes, VP Eng)',
  body: [
    '**Call:** 45-min discovery, Tue 10am. Diana + two staff engineers.',
    '',
    '**What they care about**',
    '- Rolling out to ~120 engineers in Q3 — wants SSO + SCIM before then.',
    '- Burned by a noisy tool last year; sensitive about alert volume.',
    '- Asked twice about our SOC 2 status.',
    '',
    '**Open questions to answer in the follow-up**',
    '1. SSO/SCIM timeline and which IdPs we support.',
    '2. How alert thresholds are tuned out of the box.',
    '3. Where the SOC 2 report lives + NDA process.',
    '',
    '**Next step:** send recap + pricing one-pager, propose a technical deep-dive next week.',
  ].join('\n'),
  initialHistory: [
    {
      ts: new Date(now - 2 * HOUR).toISOString(),
      kind: 'agent-invoke',
      agentName: 'researcher',
      note: 'researcher pulled Acme’s recent Series C funding + headcount growth for context',
    },
    {
      ts: new Date(now - 90 * MIN).toISOString(),
      kind: 'update',
      note: 'Logged call notes and tagged the three open questions',
    },
  ],
});

for (const childTitle of [
  'Draft recap email answering the 3 open questions',
  'Attach the latest pricing one-pager',
  'Pull SOC 2 report link + NDA template',
  'CC the account exec (Marcus)',
]) {
  createWorkItem({
    projectId: sales.id,
    stageId: 'follow-up',
    parentId: acme.id,
    type: 'task',
    title: childTitle,
  });
}

// Board fill across the other stages.
const salesCards: [string, string, string][] = [
  ['follow-up', 'Follow-up — Northwind Traders (pricing pushback)', 'They like the product, stuck on per-seat vs usage pricing. Need an ROI angle.'],
  ['follow-up', 'Follow-up — Globex (demo recap)', 'Champion: Sam. Loved the dashboards. Wants a recap to forward to their CFO.'],
  ['drafting', 'Riverbend renewal — check-in note', 'Renewal in 6 weeks. Draft a warm check-in + ask for a quick health call.'],
  ['drafting', 'Initech — answer security questionnaire follow-ups', 'Two leftover questions from their infosec review.'],
  ['review', 'Contoso — proposal email (draft ready)', 'Draft written in my voice; needs a once-over before it goes to their VP.'],
  ['sent', 'Hooli — sent recap + case study', 'Sent Mon 4pm. Booked the technical deep-dive for Thursday.'],
  ['sent', 'Stark Industries — intro follow-up', 'Replied within the hour with the one-pager. Awaiting their timeline.'],
];
for (const [stageId, title, body] of salesCards) {
  createWorkItem({ projectId: sales.id, stageId, type: 'task', title, body });
}

// Sales workflow — the conversational "post-call follow-up".
const SALES_WF = `version: 2
id: post-call-follow-up
name: Post-call follow-up
description: Turn a call transcript into a ready-to-send follow-up email in your voice.
nodes:
  - id: extract
    kind: agent
    agent: extractor
    task: |
      Read the call transcript on this card. Pull out every question the prospect
      asked and every objection or concern they raised. Return a tidy list.
    next: [draft]
  - id: draft
    kind: agent
    agent: writer
    task: |
      Using the questions and objections from $extract.output, write a follow-up
      email in my voice. Answer each point, reference our standard responses, and
      propose a concrete next step.
    next: [approve]
  - id: approve
    kind: review
    reviewer: human
`;
const parsed = parseWorkflowV2Text(SALES_WF, { expectedId: 'post-call-follow-up' });
if (!parsed.ok) {
  console.error('[seed] sales workflow failed to parse:', (parsed as { errors?: string[] }).errors);
  process.exit(1);
}
workflowsRepo.createWorkflow(
  {
    slug: 'post-call-follow-up',
    scope: 'project',
    projectId: sales.id,
    name: parsed.workflow.name,
    description: parsed.workflow.description ?? null,
    yaml: SALES_WF,
    yamlHash: createHash('sha256').update(SALES_WF, 'utf-8').digest('hex'),
    parsedDefinition: parsed.workflow,
    status: 'active',
    disabled: false,
  },
  { actor: 'user', reason: 'demo seed' },
);

seedSessions(sales.id, [
  { title: 'Draft the Acme follow-up', agoMin: 5, active: true },
  { title: 'Which deals went quiet this week?', agoMin: 3 * 60 },
  { title: 'How should I answer Northwind’s pricing pushback?', agoMin: 6 * 60 },
  { title: 'Summarize yesterday’s 3 discovery calls', agoMin: 26 * 60 },
  { title: 'Update my follow-up email template', agoMin: 2 * 24 * 60 },
  { title: 'Weekly pipeline review', agoMin: 3 * 24 * 60 },
]);

// ── 2. People Ops (HR) ────────────────────────────────────────────────────────
const people = createProject({
  slug: 'people',
  name: 'People Ops',
  folderPath: 'C:\\Work\\People Ops',
  stages: stages([
    ['incoming', 'Incoming'],
    ['in-progress', 'In progress'],
    ['waiting', 'Waiting on me'],
    ['done', 'Done'],
  ]),
});
const peopleCards: [string, string][] = [
  ['incoming', 'Onboard — Jordan Rivera (Account Executive, starts Mon)'],
  ['incoming', 'Onboard — Priya Shah (Data Analyst, starts in 2 wks)'],
  ['in-progress', 'Q3 benefits open-enrollment comms — draft'],
  ['in-progress', 'Offboard — close out Alex Kim’s accounts'],
  ['waiting', 'New PTO policy — draft for leadership sign-off'],
  ['done', 'Onboard — Sam Carter (completed week-1 checklist)'],
];
for (const [stageId, title] of peopleCards) {
  createWorkItem({ projectId: people.id, stageId, type: 'task', title });
}
seedSessions(people.id, [
  { title: 'Set up Jordan Rivera’s onboarding', agoMin: 40, active: true },
  { title: 'Draft the open-enrollment announcement', agoMin: 5 * 60 },
  { title: 'What’s left on Priya’s pre-start checklist?', agoMin: 28 * 60 },
  { title: 'Rewrite the PTO policy in plain English', agoMin: 4 * 24 * 60 },
]);

// ── 3. Engineering (developer) ────────────────────────────────────────────────
const eng = createProject({
  slug: 'eng',
  name: 'Engineering',
  folderPath: 'C:\\Work\\Engineering',
  stages: stages([
    ['backlog', 'Backlog'],
    ['in-progress', 'In progress'],
    ['in-review', 'In review'],
    ['shipped', 'Shipped'],
  ]),
});
const engCards: [string, string, 'bug' | 'feature' | 'task'][] = [
  ['backlog', 'Login redirect drops the ?next param', 'bug'],
  ['backlog', 'Add CSV export to the reports page', 'feature'],
  ['backlog', 'Flaky test: checkout.spec retries 2–3x in CI', 'bug'],
  ['in-progress', 'Rate-limit the public search endpoint', 'feature'],
  ['in-review', 'Fix N+1 on the dashboard activity feed', 'bug'],
  ['shipped', 'Upgrade to Node 22 + drop the polyfill', 'task'],
];
for (const [stageId, title, type] of engCards) {
  createWorkItem({ projectId: eng.id, stageId, type, title });
}
seedSessions(eng.id, [
  { title: 'Fix the login redirect bug', agoMin: 15, active: true },
  { title: 'Plan the CSV export feature', agoMin: 4 * 60 },
  { title: 'Why is checkout.spec flaky?', agoMin: 22 * 60 },
]);

// ── 4. Growth (marketing) ─────────────────────────────────────────────────────
const growth = createProject({
  slug: 'growth',
  name: 'Growth',
  folderPath: 'C:\\Work\\Growth',
  stages: stages([
    ['ideas', 'Ideas'],
    ['drafting', 'Drafting'],
    ['review', 'Review'],
    ['published', 'Published'],
  ]),
});
const growthCards: [string, string][] = [
  ['ideas', 'Competitor watch — what shipped this week'],
  ['drafting', 'Blog: “How we cut onboarding time in half”'],
  ['review', 'Launch email for the v2 dashboards'],
  ['published', 'Case study — Hooli (live on the site)'],
];
for (const [stageId, title] of growthCards) {
  createWorkItem({ projectId: growth.id, stageId, type: 'task', title });
}
seedSessions(growth.id, [
  { title: 'Summarize what competitors shipped this week', agoMin: 50, active: true },
  { title: 'Draft the v2 dashboards launch email', agoMin: 7 * 60 },
]);

console.log('[seed] done — projects: sales, people, eng, growth');
