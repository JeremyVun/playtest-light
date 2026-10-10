import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, before, test } from 'node:test';
import { pruneRuns } from '../src/env/runs.ts';
import { sampleTargets } from './sample.ts';
const targets = sampleTargets();
import type { ScriptTurn, TranscriptEntry } from '../src/model/script.ts';
import { findProject, parseStory } from '../src/project.ts';
import { explore, type ExploreResult } from '../src/run/explore.ts';
import type { Project } from '../src/types.ts';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'playtest-explore-')));
let project: Project;

const config = {
  browser: { viewport: [1280, 800], widths: [420, 1280], clock: '2026-04-01T12:00:00Z' },
};

const story = `---
start: /login
---
# Add a task

Sign in as admin@example.test with password admin-pass-1 and add a task to a project.
`;

const signIn = [
  { type: 'fill', target: 'e1', value: 'admin@example.test' },
  { type: 'fill', target: 'e2', value: 'admin-pass-1' },
  { type: 'click', target: 'e3', expect: [{ type: 'url', value: '/projects' }] },
];

const addTask = [
  { type: 'click', target: { role: 'link', name: 'Northern Onboarding' } },
  { type: 'click', target: { role: 'button', name: 'New task' } },
  { type: 'fill', target: { role: 'textbox', name: 'Title' }, value: 'Write launch email' },
  { type: 'click', target: { role: 'button', name: 'Save task' } },
];

let scripts = 0;
async function session(turns: ScriptTurn[], opts: { env?: Record<string, string>; steps?: number; seed?: number; fresh?: boolean } = {}): Promise<{ result: ExploreResult; tools: Extract<TranscriptEntry, { event: 'tool' }>[]; sends: string[] }> {
  const n = ++scripts;
  const file = join(scratch, `script-${n}.json`);
  const transcript = join(scratch, `transcript-${n}.jsonl`);
  writeFileSync(file, JSON.stringify(turns));
  process.env.PLAYTEST_MODEL = `script:${file}`;
  process.env.PLAYTEST_MODEL_TRANSCRIPT = transcript;
  await targets.use(project, opts.env);
  const result = await explore(project, opts);
  const entries = existsSync(transcript) ? readFileSync(transcript, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TranscriptEntry) : [];
  return {
    result,
    tools: entries.filter((e): e is Extract<TranscriptEntry, { event: 'tool' }> => e.event === 'tool'),
    sends: entries.flatMap((e) => (e.event === 'send' ? [e.message] : [])),
  };
}

before(async () => {
  mkdirSync(join(scratch, 'playtest', 'stories'), { recursive: true });
  writeFileSync(join(scratch, 'playtest', 'config.json'), JSON.stringify(config));
  writeFileSync(join(scratch, 'playtest', 'stories', 'add-task.md'), story);
  project = findProject(scratch);
  await targets.use(project);
  writeFileSync(join(project.dir, 'config.json'), JSON.stringify(project.config));
});

after(async () => {
  await targets.close();
  rmSync(scratch, { recursive: true, force: true });
});

let first: ExploreResult;
let lastStaleList: ExploreResult;

test('a session yields mechanical and model findings, reproduced by a replay with no model', { timeout: 120_000 }, async () => {
  const { result, tools, sends } = await session(
    [
      [
        { tool: 'act', args: { actions: signIn } },
        { tool: 'act', args: { actions: [...addTask, { type: 'click', target: { role: 'button', name: 'Does not exist' } }] } },
        {
          tool: 'report_finding',
          args: {
            title: 'Saving a new task fails',
            kind: 'bug',
            severity: 'high',
            expected: 'the task "Write launch email" is saved and listed in the project',
            actual: 'the dialog says Internal server error',
            steps: [7],
            check: { type: 'text', value: 'Internal server error' },
            task: 'Sign in as admin@example.test (admin-pass-1), open "Northern Onboarding" and add a task called "Write launch email".',
          },
        },
        { tool: 'report_finding', args: { title: 'Made up', kind: 'bug', severity: 'low', expected: 'x', actual: 'y', steps: [], check: { type: 'text', value: 'Nothing like this' } } },
        { tool: 'report_finding', args: { title: 'Banner on sign in', kind: 'copy', severity: 'low', expected: 'no banner', actual: 'a banner', steps: [2], check: { type: 'text', value: 'Nothing like this' } } },
        { tool: 'set_width', args: { width: 420 } },
        { tool: 'done', args: { summary: 'Tried adding a task.' } },
        { text: 'Done.' },
      ],
    ],
    { env: { BUGS: 'console-error,save-500' } },
  );
  first = result;
  assert.match(sends[0], /## What the project's stories say users do/);
  assert.match(sends[0], /admin@example\.test/);
  assert.doesNotMatch(sends[0], /save-500|console-error|BUGS/);
  assert.match(tools[0].output, /^steps 1-3 done/m);
  assert.match(tools[0].output, /^left: 57 actions$/m);
  assert.match(tools[1].output, /FAIL click button "Does not exist"/);
  assert.match(tools[2].output, /^finding 1 recorded at step 7/);
  assert.match(tools[3].output, /^report refused: text "Nothing like this" is false/);
  assert.match(tools[4].output, /will be evaluated by replaying to step 2/);
  assert.match(tools[5].output, /^step 8: the window is now 420px wide/);

  const s = result.session;
  assert.equal(s.outcome, 'done');
  assert.equal(s.steps.length, 8);
  assert.equal(s.stats.failedActions, 1);
  const byTitle = (re: RegExp) => result.findings.find((f) => re.test(f.title));
  const saving = byTitle(/^Saving a new task fails$/)!;
  assert.equal(saving.reproduced, true, saving.confirmation);
  assert.equal(saving.at, 7);
  assert.ok(saving.evidence.snapshot.some((l) => l.includes('Internal server error')));
  const draft = parseStory(saving.story, saving.slug, 'draft.md');
  assert.deepEqual(draft.doneWhen, ['the task "Write launch email" is saved and listed in the project']);
  assert.equal(draft.start, '/');
  const banner = byTitle(/^Banner on sign in$/)!;
  assert.equal(banner.reproduced, false);
  assert.match(banner.confirmation, /did not hold/);
  assert.equal(saving.weak, undefined);
  assert.deepEqual(
    saving.merged?.map((m) => [m.title, m.reproduced]),
    [['POST /api/projects/prj-001/tasks returned 500 on /projects/prj-001', true]],
  );
  assert.ok(saving.issues?.some((i) => i.message === 'POST /api/projects/prj-001/tasks 500'));
  assert.equal(byTitle(/^POST /), undefined);
  const consoleError = byTitle(/^Console error on \/projects$/)!;
  assert.equal(consoleError.source, 'mechanical');
  assert.equal(consoleError.reproduced, true);
  assert.equal(consoleError.merged, undefined);
  const keys = result.findings.flatMap((f) => (f.issues ?? []).map((i) => i.key));
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(result.painPoints.some((p) => p.kind === 'failed-action' && /Does not exist/.test(p.title)));

  const md = readFileSync(result.markdown, 'utf8');
  assert.match(md, /^# pt explore: \d+ reproduced findings, 1 unreproduced/);
  assert.match(md, /^Random seed 0: main tasks first\.$/m);
  assert.match(md, /\| Saving a new task fails \| check \+ harness \| 7 \|/);
  assert.match(md, /^- Explains the harness finding: POST \/api\/projects\/prj-001\/tasks returned 500 on \/projects\/prj-001 \(reproduced: /m);
  assert.match(md, /## Not reproduced\n\n.*\n\n## F\d+: Banner on sign in/);
  assert.match(md, /````md\n---\nstart: \/\n---\n# Saving a new task fails\n\nSign in as admin@example\.test/);
  const json = JSON.parse(readFileSync(result.json, 'utf8'));
  assert.equal(json.kind, 'explore');
  assert.equal(json.findings.length, result.findings.length);
});

test('a click on a covered control is a finding, reproduced by trying it again on replay', { timeout: 120_000 }, async () => {
  const { result, tools } = await session(
    [
      [
        { tool: 'set_width', args: { width: 420 } },
        { tool: 'act', args: { actions: [...signIn, { type: 'click', target: { role: 'link', name: 'New project' } }] } },
        { tool: 'done', args: { summary: 'Phone.' } },
        { text: 'Done.' },
      ],
    ],
    { env: { BUGS: 'overlap' } },
  );
  assert.match(tools[1].output, /FAIL click link "New project": link "New project" is covered by button "Feedback"/);
  const about = result.findings.filter((f) => f.title.includes('"New project"'));
  assert.equal(about.length, 1, 'the failed click and the layout check are one finding');
  const covered = about[0];
  assert.equal(covered.then, 'click link "New project"');
  assert.equal(covered.title, 'link "New project" is covered by button "Feedback" on /projects at 420px wide');
  assert.equal(covered.reproduced, true, covered.confirmation);
  assert.equal(covered.at, 4);
  assert.equal(covered.merged?.length, 1);
  assert.ok(covered.issues?.some((i) => i.kind === 'covered' && i.width === 420));
  assert.match(covered.story, /^viewport: \[420, 800\]$/m);
  assert.match(covered.story, /^- click link "New project"$/m);
});

test('a model finding takes in the harness findings it explains, by the element it names', { timeout: 120_000 }, async () => {
  const { result } = await session(
    [
      [
        { tool: 'set_width', args: { width: 420 } },
        { tool: 'act', args: { actions: [...signIn, { type: 'click', target: { role: 'link', name: 'New project' } }] } },
        {
          tool: 'report_finding',
          args: {
            title: 'Feedback sits on top of New project on a phone',
            kind: 'bug',
            severity: 'high',
            expected: 'New project can be clicked at 420px wide',
            actual: 'the click lands on Feedback',
            steps: [4],
            checks: [{ type: 'element', role: 'button', name: 'Feedback' }],
            task: 'On a phone, sign in as admin@example.test (admin-pass-1) and click New project.',
          },
        },
        { tool: 'done', args: { summary: 'Phone.' } },
        { text: 'Done.' },
      ],
    ],
    { env: { BUGS: 'overlap' } },
  );
  assert.equal(result.findings.length, 1, result.findings.map((f) => f.title).join('; '));
  const [f] = result.findings;
  assert.equal(f.source, 'model');
  assert.equal(f.reproduced, true);
  assert.equal(f.weak, undefined, 'harness evidence outweighs a check that held before');
  assert.equal(f.merged?.length, 2);
  assert.equal(f.then, 'click link "New project"');
  assert.match(f.story, /^- click link "New project"$/m);
});

test('checks that already held before the cited step are weak; a paired check is not; the same title replaces', { timeout: 120_000 }, async () => {
  const notListed = { type: 'no-text', value: 'Write launch email' };
  const report = (title: string, checks: unknown[]) => ({
    tool: 'report_finding',
    args: { title, kind: 'bug', severity: 'high', expected: 'the new task is listed', actual: 'it is not', steps: [7], checks, task: 'Add a task.' },
  });
  const { result, tools } = await session(
    [
      [
        { tool: 'act', args: { actions: [...signIn, ...addTask] } },
        report('New task not listed', [notListed]),
        report('Saved task missing', [notListed]),
        report('Saved task missing', [{ type: 'text', value: 'Task created' }, notListed]),
        { tool: 'done', args: { summary: 'Added a task.' } },
        { text: 'Done.' },
      ],
    ],
    { env: { BUGS: 'stale-list' } },
  );
  lastStaleList = result;
  assert.match(tools[1].output, /^finding 1 recorded at step 7: New task not listed\. Note: every check says something is not there/);
  assert.match(tools[2].output, /^finding 2 recorded at step 7/);
  assert.match(tools[3].output, /^finding 2 updated at step 7: Saved task missing\. Keep exploring\.$/);
  assert.equal(result.session.reports.length, 2);
  const weak = result.findings.find((f) => f.title === 'New task not listed')!;
  assert.equal(weak.reproduced, true);
  assert.match(weak.weak ?? '', /already held after step 6/);
  const paired = result.findings.find((f) => f.title === 'Saved task missing')!;
  assert.equal(paired.reproduced, true, paired.confirmation);
  assert.equal(paired.weak, undefined);
  assert.equal(paired.checks?.length, 2);
  const md = readFileSync(result.markdown, 'utf8');
  assert.match(md, /^# pt explore: 2 reproduced findings \(1 on weak evidence\), 0 unreproduced/);
  assert.match(md, /\| Saved task missing \| check \| 7 \|\n\| F\d+ \| bug \| high \| New task not listed \| weak check \| 7 \|/);
  assert.match(md, /^- Weak evidence: it already held after step 6/m);
  assert.match(md, /^- Checks that show it: `text "Task created"` and `no text "Write launch email"`$/m);
});

test('the seed picks the plan; later sessions are told what earlier ones with the same target found', { timeout: 120_000 }, async () => {
  const quick = [[{ tool: 'act', args: { actions: signIn } }, { tool: 'done', args: { summary: 'Signed in.' } }, { text: 'Done.' }]];
  const env = { BUGS: 'stale-list' };
  const next = await session(quick, { env });
  assert.equal(next.result.session.seed, 1);
  assert.equal(next.result.session.flavour, 'beyond the stories');
  assert.deepEqual(next.result.session.earlier, [basename(lastStaleList.session.runDir)]);
  assert.match(next.sends[0], /## What earlier sessions did\nThe last explore session with these settings already reported these problems; do not spend steps finding them again:\n- New task not listed\n- Saved task missing\n/);
  assert.match(next.sends[0], /They spent their steps on these pages \(steps after which each was open\): \/projects\/:id \(4\), \/login \(2\), \/projects \(1\)\./);
  assert.match(readFileSync(next.result.markdown, 'utf8'), /^Random seed 1: beyond the stories, told what the last session with these settings found\.$/m);

  const pinned = await session(quick, { env, seed: 2, fresh: true });
  assert.equal(pinned.result.session.flavour, 'phone first');
  assert.deepEqual(pinned.result.session.earlier, []);
  assert.doesNotMatch(pinned.sends[0], /earlier sessions/);
});

test('the action budget stops the session and cuts a batch short', { timeout: 120_000 }, async () => {
  const { result, tools } = await session(
    [[{ tool: 'act', args: { actions: [...signIn, ...addTask] } }, { tool: 'act', args: { actions: [{ type: 'back' }] } }, { text: 'Out of budget.' }]],
    { steps: 4 },
  );
  assert.match(tools[0].output, /only the first 4 actions were run/);
  assert.match(tools[0].output, /^left: 0 actions/m);
  assert.match(tools[1].output, /^Nothing ran: the budget is spent \(all 4 actions are used\)/);
  assert.equal(result.session.steps.length, 4);
  assert.equal(result.session.outcome, 'steps');
});

test('every finding is saved automatically and survives run pruning', () => {
  const saved = JSON.parse(readFileSync(join(first.savedFindings, 'findings.json'), 'utf8'));
  assert.deepEqual(saved.findings, first.findings);
  assert.ok(saved.findings.some((f: { reproduced: boolean }) => !f.reproduced));
  assert.ok(saved.findings.every((f: { story: string }) => f.story.includes('## Done when')));
  assert.equal(existsSync(join(project.dir, 'stories', 'saving-a-new-task-fails.md')), false);
  pruneRuns(project.runsDir, 0);
  assert.equal(existsSync(first.session.runDir), false);
  assert.equal(existsSync(join(first.savedFindings, 'findings.md')), true);
  assert.deepEqual(JSON.parse(readFileSync(join(first.savedFindings, 'findings.json'), 'utf8')).findings, first.findings);
});
