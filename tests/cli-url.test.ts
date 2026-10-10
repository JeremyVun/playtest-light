import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const cli = join(import.meta.dirname, '../bin/playtest.js');
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'pt-url-cli-')));
let url: string;
let resets = 0;
let clicks = 0;
let buttonLabel = 'Add';
const visits: string[] = [];
const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/reset') { resets++; clicks = 0; return res.end('ok'); }
  if (req.method === 'POST' && req.url === '/click') { clicks++; return res.end(String(clicks)); }
  visits.push(req.url!);
  res.setHeader('content-type', 'text/html');
  res.end('<h1>Home</h1><button onclick="fetch(\'/click\',{method:\'POST\'}).then(r=>r.text()).then(n=>document.querySelector(\'h1\').textContent=\'Count \'+n)">' + buttonLabel + '</button>');
});
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  mkdirSync(join(cwd, 'cases'));
  mkdirSync(join(cwd, 'bin'));
  for (const name of ['open', 'xdg-open']) {
    const file = join(cwd, 'bin', name);
    writeFileSync(file, '#!/bin/sh\nprintf opened > opened\n');
    chmodSync(file, 0o755);
  }
  writeFileSync(join(cwd, 'cases/story.md'), '# Add once\n\nClick Add.\n\n## Done when\n- Count 1 is shown\n');
  writeFileSync(join(cwd, 'seed.mjs'), `const r = await fetch(new URL('/reset', process.env.PLAYTEST_URL), {method:'POST'}); if (!r.ok) throw new Error('seed failed'); console.log('seed output must not be on JSON stdout');`);
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(cwd, { recursive: true, force: true });
});

async function run(args: string[], calls?: unknown): Promise<{ code: number; value: any; stderr: string }> {
  const script = join(cwd, 'model.json');
  if (calls) writeFileSync(script, JSON.stringify(calls));
  try {
    const result = await execute(process.execPath, [cli, ...args, '--json'], { cwd, env: { ...process.env, PATH: `${join(cwd, 'bin')}:${process.env.PATH}`, PLAYTEST_MODEL: `script:${script}` } });
    return { code: 0, value: JSON.parse(result.stdout), stderr: result.stderr };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return { code: result.code, value: JSON.parse(result.stdout), stderr: result.stderr };
  }
}

test('URL-only run and view work with direct story paths and no config or Git', async () => {
  const record = await run(['run', './cases/story.md', '--url', url, '--seed', 'node seed.mjs', '--accept'], [[
    { tool: 'act', args: { actions: [{ type: 'navigate', url }, { type: 'click', target: { role: 'button', name: 'Add' } }] } },
    { tool: 'done', args: { summary: 'Added', checks: [{ type: 'text', value: 'Count 1' }] } },
  ]]);
  assert.equal(record.code, 0, JSON.stringify(record.value));
  assert.equal(record.stderr, '');
  const accepted = await run(['accept', './cases/story.md']);
  assert.equal(accepted.code, 0, JSON.stringify(accepted.value));
  assert.equal(accepted.value.to, join(cwd, 'cases/story.baseline.json'));
  assert.equal(resets, 3, 'initial play and both verification replays seed independently');
  const baseline = JSON.parse(readFileSync(join(cwd, 'cases/story.baseline.json'), 'utf8'));
  assert.equal(baseline.story, 'story');
  assert.equal(baseline.commit, undefined);
  assert.equal(baseline.steps[0].action.url, '/');
  assert.equal(existsSync(join(cwd, 'playtest/config.json')), false);
  assert.equal((await run(['run', './cases/story.md', '--url', url, '--seed', 'node seed.mjs'])).code, 0);
  const capture = await run(['run', './cases/story.md', '--url', url, '--seed', 'node seed.mjs', '--video', '--view']);
  assert.equal(capture.code, 0, JSON.stringify(capture.value));
  assert.equal(capture.stderr, '');
  assert.equal(existsSync(join(cwd, 'opened')), false, 'JSON capture must not launch a desktop app');
  assert.deepEqual(JSON.parse(readFileSync(join(capture.value.runDir, 'report.json'), 'utf8')), { kind: 'run', ...capture.value });
  const evidence = JSON.parse(readFileSync(join(capture.value.runDir, 'evidence.json'), 'utf8'));
  assert.equal(evidence.sections[0].frames.length, 3);
  assert.equal(evidence.stories[0].status, 'pass');
  assert.equal(evidence.stories[0].steps, 2);
  assert.deepEqual(evidence.stories[0].sectionIds, [evidence.sections[0].id]);
  assert.ok(evidence.stories[0].ms > 0);
  for (const frame of evidence.sections[0].frames) assert.ok(frame.durationMs >= frame.ms, JSON.stringify(frame));
  for (const frame of evidence.sections[0].frames) assert.equal(readFileSync(join(capture.value.runDir, frame.screenshot)).subarray(1, 4).toString(), 'PNG');
  const view = await run(['view', capture.value.runDir]);
  assert.equal(view.value.view, capture.value.view);
  assert.equal((await run(['view'])).value.view, capture.value.view);
  assert.equal(record.value.recordings.length, 1);
  assert.equal(existsSync(join(record.value.recordings[0].runDir, 'report.json')), false, 'one report belongs to the entire run');
  assert.equal(existsSync(join(record.value.recordings[0].runDir, 'report.md')), false);
  assert.equal(capture.value.recordings.length, 0, 'existing baselines never call the model');
  assert.equal(resets, 5);
  const failedSeed = await run(['run', './cases/story.md', '--url', url, '--seed', 'echo broken >&2; exit 9']);
  assert.equal(failedSeed.code, 2);
  assert.match(failedSeed.value.results[0].error, /seed failed.*exit 9/);
  const seedEvidence = JSON.parse(readFileSync(join(failedSeed.value.runDir, 'evidence.json'), 'utf8'));
  assert.equal(seedEvidence.stories[0].status, 'error');
  assert.deepEqual(seedEvidence.stories[0].sectionIds, []);
  assert.match(seedEvidence.details, /seed failed/);
  assert.equal(clicks, 1, 'seed failure prevents navigation and actions');
  assert.equal((await fetch(url)).status, 200, 'the CLI never owns this server');
});

test('URL-only exploration preserves initial path/query and explicitly reports no reset', async () => {
  const before = resets;
  const result = await run(['explore', url + 'area?q=one#section', '--view'], [[{ tool: 'done', args: { summary: 'Looked around' } }]]);
  assert.equal(result.code, 0, JSON.stringify(result.value));
  assert.equal(result.value.seeded, false);
  assert.equal(result.stderr, '');
  assert.equal(existsSync(join(cwd, 'opened')), false);
  assert.equal(resets, before);
  assert.ok(visits.includes('/area?q=one'));
  const findings = JSON.parse(readFileSync(join(result.value.runDir, 'findings.json'), 'utf8'));
  assert.equal(findings.start, '/area?q=one#section');
});

test('bad inputs and removed commands return JSON errors without starting a model', async () => {
  for (const args of [['up'], ['explore'], ['explore', '--steps', 'bad'], ['run', '--unknown'], ['run'], ['adopt'], ['record'], ['check'], ['render'], ['accept'], ['explore', url, '--seed', 'true', '--no-seed']]) {
    const result = await run(args);
    assert.equal(result.stderr, '');
    assert.equal(result.code, 2, String(args));
    assert.equal(typeof result.value.error, 'string');
  }
});

test('a regression keeps the baseline and captures the failed step without a model', async () => {
  const baseline = readFileSync(join(cwd, 'cases/story.baseline.json'), 'utf8');
  buttonLabel = 'Renamed';
  try {
    const result = await run(['run', './cases/story.md', '--url', url, '--seed', 'node seed.mjs'], []);
    assert.equal(result.code, 1, JSON.stringify(result.value));
    assert.equal(result.value.recordings.length, 0);
    assert.equal(readFileSync(join(cwd, 'cases/story.baseline.json'), 'utf8'), baseline);
    const evidence = JSON.parse(readFileSync(join(result.value.runDir, 'evidence.json'), 'utf8'));
    const last = evidence.sections[0].frames.at(-1);
    assert.match(last.error, /No button/);
    assert.ok(last.screenshot);
    assert.ok(evidence.sections[0].frames.some((f: any) => f.diff.length));
  } finally { buttonLabel = 'Add'; }
});

test('a recording in progress cannot expose an older pending baseline', { timeout: 15_000 }, async () => {
  const baseline = readFileSync(join(cwd, 'cases/story.baseline.json'), 'utf8');
  writeFileSync(join(cwd, 'wait-seed.mjs'), `import {writeFileSync} from 'node:fs';writeFileSync('seed-waiting','yes');setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, [cli, 'run', './cases/story.md', '--record', '--url', url, '--seed', 'node wait-seed.mjs', '--json'], {
    cwd, env: { ...process.env, PLAYTEST_MODEL: `script:${join(cwd, 'model.json')}` }, stdio: 'ignore',
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(join(cwd, 'seed-waiting')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(existsSync(join(cwd, 'seed-waiting')), 'recording reached the seed');
    const pending = await run(['accept', './cases/story.md']);
    assert.equal(pending.code, 2, 'do not accept the previous recording while a replacement is running');
  } finally { child.kill('SIGTERM'); await closed; }
  const accepted = await run(['accept', './cases/story.md']);
  assert.equal(accepted.code, 2, 'do not accept the previous recording after interruption');
  assert.equal(readFileSync(join(cwd, 'cases/story.baseline.json'), 'utf8'), baseline);
});

test('explicit recording replaces a baseline only when accepted', async () => {
  const baseline = readFileSync(join(cwd, 'cases/story.baseline.json'), 'utf8');
  const pending = await run(['run', './cases/story.md', '--record', '--url', url, '--seed', 'node seed.mjs'], [[
    { tool: 'act', args: { actions: [{ type: 'click', target: { role: 'button', name: 'Add' } }] } },
    { tool: 'done', args: { summary: 'Added directly', checks: [{ type: 'text', value: 'Count 1' }] } },
  ]]);
  assert.equal(pending.code, 0, JSON.stringify(pending.value));
  assert.equal(readFileSync(join(cwd, 'cases/story.baseline.json'), 'utf8'), baseline);
  const evidence = JSON.parse(readFileSync(join(pending.value.runDir, 'evidence.json'), 'utf8'));
  assert.equal(evidence.sections.length, 3);
  assert.ok(evidence.sections.every((s: any) => s.frames.every((f: any) => f.screenshot)));
  assert.equal((await run(['accept', './cases/story.md'])).code, 0);
  assert.equal(JSON.parse(readFileSync(join(cwd, 'cases/story.baseline.json'), 'utf8')).steps.length, 1);
  const failed = await run(['run', './cases/story.md', '--record', '--url', url, '--seed', 'exit 9']);
  assert.equal(failed.code, 2);
  assert.equal((await run(['accept', './cases/story.md'])).code, 2, 'do not fall back to an older recording after the latest one failed');
  const saved = readFileSync(join(cwd, 'cases/story.baseline.json'), 'utf8');
  writeFileSync(join(failed.value.runDir, 'report.json'), 'invalid json');
  assert.equal((await run(['accept', './cases/story.md'])).code, 2, 'corrupt recent reports must not silently revive an older recording');
  assert.equal(readFileSync(join(cwd, 'cases/story.baseline.json'), 'utf8'), saved);
});

test('findings survive a failed reproduction seed and are marked unreproduced', async () => {
  writeFileSync(join(cwd, 'fail-second.mjs'), `import {existsSync,writeFileSync} from 'node:fs'; if(existsSync('seeded'))process.exit(9);writeFileSync('seeded','yes');`);
  const result = await run(['explore', url, '--seed', 'node fail-second.mjs'], [[
    { tool: 'report_finding', args: { title: 'Home copy is unclear', kind: 'copy', severity: 'low', expected: 'Explain the task', actual: 'Only Home is shown', steps: [], checks: [{type:'text',value:'Home'}], task: 'Open the home page' } },
    { tool: 'done', args: { summary: 'One copy suggestion' } },
  ]]);
  assert.equal(result.code, 2, JSON.stringify(result.value));
  assert.match(result.value.error, /Reproduction failed.*seed failed/);
  assert.equal(result.value.findings.length, 1);
  assert.equal(result.value.findings[0].reproduced, false);
  const stored = JSON.parse(readFileSync(join(result.value.savedFindings, 'findings.json'), 'utf8'));
  assert.equal(stored.findings[0].title, 'Home copy is unclear');
  assert.ok(stored.findings[0].story);
  assert.equal(existsSync(result.value.view), true);
});
