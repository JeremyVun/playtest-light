import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { startSampleApp } from './spike-replay.ts';
import { findProject, loadStory } from '../src/project.ts';
import { recordStory } from '../src/run/record.ts';
import { Evidence } from '../src/run/evidence.ts';
import { explore } from '../src/run/explore.ts';

const { values } = parseArgs({ options: { out: { type: 'string' }, story: { type: 'string', default: 'busy-morning' }, long: { type: 'string' }, bugs: { type: 'string', default: '' }, explore: { type: 'boolean' } } });
if (!values.out) throw new Error('Pass --out <scratch-directory>');
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
const project = findProject(resolve('fixtures/sample-app'));
const count = values.long ? Number(values.long) : 0;
const story = count ? {
  name: 'long-context', path: join(out, 'story.md'), title: 'Prepare a large onboarding worklist', start: '/login',
  prose: `Sign in as admin@example.test with password admin-pass-1. Open Northern Onboarding. Read the exact title of its first existing task, then rename that task to Reference archived. Keep its original title for later; do not store it in another app field yet.
Create exactly ${count} new tasks named Context task 1 through Context task ${count}. Give every new task high priority and mark it complete. Do not create duplicates. Put the remembered original title in the Notes of Context task ${count}, exactly as it originally appeared. Work through the UI as a user would, using batches where predictable. If a saved task is missing, check after a reload before trying to create it again. Finally open the last new task for editing so its Notes and priority can be checked.`,
  doneWhen: [`All ${count} new tasks exist exactly once, have high priority and are complete`, 'The last task Notes contains the original title, and its edit dialog is open'],
} : loadStory(project, values.story!);
if (count) writeFileSync(story.path, story.prose);
const dbPath = join(out, 'app.sqlite');
const app = await startSampleApp({ DB_PATH: dbPath, BUGS: values.bugs! });
const before = new DatabaseSync(dbPath);
const original = before.prepare("SELECT title FROM tasks WHERE project_id='prj-001' ORDER BY id LIMIT 1").get()!.title;
before.close();
try {
  project.config.url = app.baseUrl + '/';
  project.config.seed = `node '${resolve('fixtures/sample-app/playtest/reset.ts')}'`;
  if (values.explore) {
    project.dir = join(out, 'playtest');
    project.runsDir = join(project.dir, '.runs');
    const result = await explore(project, { fresh: true, steps: 50, goal: 'Sign in as admin@example.test with password admin-pass-1. Test creating and editing tasks in Northern Onboarding, verify saves after reloading, and investigate errors or inconsistent results. Report problems you observe.', progress: console.log });
    writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ outcome: result.session.outcome, findings: result.findings.map(f => ({ title: f.title, reproduced: f.reproduced })), stats: result.session.stats, out }, null, 2));
  } else {
    const result = await recordStory(project, story, { runDir: out, evidence: new Evidence(out, false), progress: console.log });
    writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
    if (count) {
      const db = new DatabaseSync(dbPath);
      const rows = db.prepare("SELECT title, notes, priority, done FROM tasks WHERE project_id='prj-001' AND title LIKE 'Context task %' ORDER BY id").all();
      db.close();
      const expected = new Set(Array.from({length: count}, (_, i) => `Context task ${i + 1}`));
      const oracle = { count: rows.length, unique: new Set(rows.map(r => r.title)).size, allExpected: rows.every(r => expected.has(String(r.title))), allHigh: rows.every(r => r.priority === 'high'), allDone: rows.every(r => r.done === 1), remembered: rows.find(r => r.title === `Context task ${count}`)?.notes === original };
      writeFileSync(join(out, 'oracle.json'), JSON.stringify(oracle, null, 2));
      console.log('Independent state check:', oracle);
      assert.equal(rows.length, count); assert.equal(oracle.unique, count);
      assert.ok(oracle.allExpected && oracle.allHigh && oracle.allDone && oracle.remembered);
    }
    const prompts = readFileSync(join(out, 'context.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    console.log(JSON.stringify({ outcome: result.outcome, deterministic: result.deterministic, reason: result.reason, stats: result.stats, contexts: prompts.map(p => ({ decision: p.decision, epoch: p.epoch, prefixBytes: p.prefixBytes, shared: p.sharedPrefixBytes, pageBytes: p.pageBytes })), out }, null, 2));
  }
} finally { await app.stop(); }
