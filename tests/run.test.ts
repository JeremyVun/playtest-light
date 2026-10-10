import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Evidence } from '../src/run/evidence.ts';
import { newRunDir } from '../src/env/runs.ts';
import { run as check } from '../src/commands/run.ts';
import { sampleTargets } from './sample.ts';
const targets = sampleTargets();
import { findProject, loadStory } from '../src/project.ts';
import { acceptStory, readBaseline } from '../src/run/baseline.ts';
import { recordStory, type RecordResult } from '../src/run/record.ts';
import type { ScriptTurn, TranscriptEntry } from '../src/model/script.ts';
import type { Project } from '../src/types.ts';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'playtest-run-')));
let project: Project;

const config = {
  browser: { viewport: [1280, 800], widths: [420, 1280], clock: '2026-04-01T12:00:00Z' },
};

const story = `---
start: /login
---
# Add a task

Sign in as admin@example.test with password admin-pass-1. Open "Northern Onboarding" and add a task called "Write launch email".

## Done when
- the task "Write launch email" is in the project's task list
`;

const signIn = (email = 'admin@example.test', password = 'admin-pass-1'): Record<string, unknown>[] => [
  { type: 'fill', target: 'e1', value: email },
  { type: 'fill', target: 'e2', value: password },
  { type: 'click', target: 'e3', expect: [{ type: 'url', value: '/projects' }] },
];

const addTask = [
  ...signIn(),
  { type: 'click', target: { role: 'link', name: 'Northern Onboarding' } },
  { type: 'click', target: { role: 'button', name: 'New task' } },
  { type: 'fill', target: { role: 'textbox', name: 'Title' }, value: 'Write launch email' },
  { type: 'click', target: { role: 'button', name: 'Save task' } },
];

let scripts = 0;
async function record(turns: ScriptTurn[], env: Record<string, string> = {}): Promise<{ result: RecordResult; tools: Extract<TranscriptEntry, { event: 'tool' }>[]; sends: string[] }> {
  const n = ++scripts;
  const file = join(scratch, `script-${n}.json`);
  const transcript = join(scratch, `transcript-${n}.jsonl`);
  writeFileSync(file, JSON.stringify(turns));
  process.env.PLAYTEST_MODEL = `script:${file}`;
  process.env.PLAYTEST_MODEL_TRANSCRIPT = transcript;
  await targets.use(project, env);
  const runDir = newRunDir(project, 'run');
  const result = await recordStory(project, loadStory(project, 'add-task'), { runDir, evidence: new Evidence(runDir, true) });
  const entries = existsSync(transcript) ? readFileSync(transcript, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TranscriptEntry) : [];
  return {
    result,
    tools: entries.filter((e): e is Extract<TranscriptEntry, { event: 'tool' }> => e.event === 'tool'),
    sends: entries.flatMap((e) => (e.event === 'send' ? [e.message] : [])),
  };
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
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

test('record refuses done without passing checks, proves determinism, accepts, and check passes', { timeout: 120_000 }, async () => {
  const { result, tools } = await record([
    [
      { tool: 'act', args: { actions: addTask } },
      { tool: 'done', args: { summary: 'added', checks: [] } },
      { tool: 'done', args: { summary: 'added', checks: [{ type: 'text', value: 'Write the launch email' }] } },
      { tool: 'done', args: { summary: 'added', checks: [{ type: 'element', role: 'checkbox', name: 'Mark "Write launch email" complete' }, { type: 'url', value: '/projects/prj-001' }] } },
      { text: 'Added the task.' },
    ],
  ]);
  assert.match(tools[1].output, /^done refused: give at least one check/);
  assert.match(tools[2].output, /^done refused: 1 of 1 checks failed/);
  assert.match(tools[2].output, /FAIL text "Write the launch email"/);
  assert.match(tools[3].output, /^done accepted/);
  assert.equal(result.outcome, 'done');
  assert.equal(result.deterministic, true, result.determinism.join('\n'));
  assert.equal(result.stats.actions, 7);

  const accepted = acceptStory(project, loadStory(project, 'add-task'), result.baseline);
  const baseline = readBaseline(accepted.to);
  assert.equal(baseline.steps.length, 7);
  assert.deepEqual(baseline.steps[3].action, { type: 'click', target: { role: 'link', name: 'Northern Onboarding' } });
  assert.deepEqual(baseline.steps[0].action, { type: 'fill', target: { role: 'textbox', name: 'Email' }, value: 'admin@example.test' });
  assert.equal(baseline.steps[6].url, '/projects/prj-001');
  assert.ok(baseline.steps[6].snapshot.includes('      checkbox "Mark \\"Write launch email\\" complete"'));
  assert.equal(baseline.checks.length, 2);

  const code = await quietly(() => check({ positionals: [], values: { json: true, project: project.dir } }));
  assert.equal(code, 0);
});

test('a changed app fails check with a snapshot diff, and stops where a target is gone', { timeout: 120_000 }, async () => {
  let out = '';
  const log = console.log;
  console.log = (line: string) => (out += `${line}\n`);
  let code: number;
  try {
    code = await check({ positionals: ['add-task'], values: { url: (await targets.use(project, { VARIANT: 'rename-cta' })).baseUrl, seed: project.config.seed, json: true, project: project.dir } });
  } finally {
    console.log = log;
  }
  assert.equal(code, 1);
  const [r] = JSON.parse(out).results;
  assert.equal(r.status, 'fail');
  assert.equal(r.drift[0].step, 4);
  assert.ok(r.drift[0].diff.includes('-  button "New task"'));
  assert.ok(r.drift[0].diff.includes('+  button "Add task"'));
  assert.equal(r.stopped.step, 5);
  assert.match(r.stopped.error, /No button "New task"/);
});

test('a new issue seen on several steps is reported once, at its first step', { timeout: 120_000 }, async () => {
  const stories = join(scratch, 'playtest', 'stories');
  const baseline = readBaseline(join(stories, 'add-task.baseline.json'));
  const back = { ...baseline.steps[2], action: { type: 'click' as const, target: { role: 'link', name: '← All projects' } } };
  writeFileSync(join(stories, 'twice.md'), story);
  writeFileSync(join(stories, 'twice.baseline.json'), JSON.stringify({ ...baseline, story: 'twice', steps: [...baseline.steps.slice(0, 4), back] }));
  let out = '';
  const log = console.log;
  console.log = (line: string) => (out += `${line}\n`);
  try {
    await check({ positionals: ['twice'], values: { url: (await targets.use(project, { BUGS: 'console-error' })).baseUrl, seed: project.config.seed, json: true, project: project.dir } });
  } finally {
    console.log = log;
    rmSync(join(stories, 'twice.md'));
    rmSync(join(stories, 'twice.baseline.json'));
  }
  const [r] = JSON.parse(out).results;
  assert.equal(r.ran, 5);
  const consoleIssues = r.newIssues.filter((i: { issue: { kind: string } }) => i.issue.kind === 'console');
  assert.deepEqual(consoleIssues.map((i: { step: number }) => i.step), [3]);
});

test('act stops at an unmet expectation and reports what did not run', { timeout: 120_000 }, async () => {
  const actions = [...signIn(), { type: 'click', target: { role: 'link', name: 'Plan' } }];
  actions[2] = { ...actions[2], expect: [{ type: 'url', value: '/nowhere' }] };
  const { result, tools } = await record([[{ tool: 'act', args: { actions } }, { tool: 'give_up', args: { reason: 'testing' } }, { text: 'Gave up.' }]]);
  const out = tools[0].output;
  assert.match(out, /^3 ok {3}click button "Sign in"$/m);
  assert.match(out, /^not run: 4$/m);
  assert.match(out, /^stopped after 3: expectation not met: url "\/nowhere" \(URL is \/projects\)$/m);
  assert.equal(result.outcome, 'give_up');
  assert.equal(result.reason, 'testing');
  assert.equal(result.deterministic, false);
});

test('act stops after an irreversible-looking click with no expect', { timeout: 120_000 }, async () => {
  const actions = [
    ...signIn(),
    { type: 'click', target: { role: 'link', name: 'Northern Onboarding' } },
    { type: 'click', target: { role: 'button', name: 'Delete "Draft the kickoff brief"' } },
    { type: 'click', target: { role: 'button', name: 'Cancel' } },
  ];
  const { tools } = await record([[{ tool: 'act', args: { actions } }, { tool: 'give_up', args: { reason: 'testing' } }, { text: '' }]]);
  const out = tools[0].output;
  assert.match(out, /^stopped after 5: button "Delete \\"Draft the kickoff brief\\"" looks irreversible and had no expect/m);
  assert.match(out, /^not run: 6$/m);
  assert.match(out, /dialog "Delete task\?"/);
});

test('a session that never finishes is nudged twice, then fails', { timeout: 120_000 }, async () => {
  const { result, sends, tools } = await record([
    [{ tool: 'act', args: { actions: [] } }, { text: 'Looking around.' }],
    [{ text: 'Still looking.' }],
    [{ text: 'Hmm.' }],
  ]);
  assert.equal(sends.length, 4);
  assert.match(sends[2], /without calling a tool/);
  assert.match(tools[0].output, /^page \/login title "Tracker"\n/);
  assert.equal(result.outcome, 'unfinished');
  assert.equal(result.deterministic, false);
});
