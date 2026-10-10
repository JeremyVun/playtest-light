import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startSlowChat } from '../fixtures/slow-chat/server.ts';
import { recordStory } from '../src/run/record.ts';
import { explore } from '../src/run/explore.ts';
import { Evidence } from '../src/run/evidence.ts';
import { readBaseline } from '../src/run/baseline.ts';
import type { Project, Story } from '../src/types.ts';

const checks = [{ type: 'text', value: 'Your request is complete.' }, { type: 'enabled', role: 'button', name: 'Send' }];
const script = [
  { tool: 'act', args: { actions: [{ type: 'fill', target: { role: 'textbox', name: 'Message' }, value: 'Please respond' }, { type: 'press', key: 'Enter' }] } },
  { tool: 'wait_for', args: { until: checks, timeoutSeconds: 1200 } },
  { tool: 'done', args: { summary: 'Response completed', checks } },
];
const events = (path: string) => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));

async function fixture(fn: (project: Project, dir: string, app: Awaited<ReturnType<typeof startSlowChat>>) => Promise<void>, responseMs = 1400) {
  const dir = mkdtempSync(join(tmpdir(), 'pt-wait-run-'));
  const app = await startSlowChat(responseMs);
  const saved = process.env.PLAYTEST_MODEL;
  const file = join(dir, 'script.json');
  writeFileSync(file, JSON.stringify([script]));
  process.env.PLAYTEST_MODEL = 'script:' + file;
  mkdirSync(join(dir, 'stories'));
  const project: Project = { dir, cwd: dir, seedCwd: dir, runsDir: join(dir, '.runs'), config: { url: app.url, browser: { viewport: [1280, 800], widths: [1280], settleCapMs: 50 }, model: { name: 'script' } } };
  try { await fn(project, dir, app); }
  finally {
    if (saved === undefined) delete process.env.PLAYTEST_MODEL; else process.env.PLAYTEST_MODEL = saved;
    await app.close(); rmSync(dir, { recursive: true, force: true });
  }
}

function verifyOrder(path: string) {
  const log = events(path);
  const decision = log.findIndex(e => e.event === 'decision' && e.tool === 'wait_for');
  const action = log.findIndex(e => e.event === 'action' && e.action.type === 'wait');
  assert.ok(decision >= 0 && action > decision, 'model decision must finish before the browser wait');
  assert.ok(log[decision].ms < 500, 'wait tool held the model open');
  assert.ok(log[action].waitMs > 800, 'no real waiting happened');
  assert.equal(log.slice(decision + 1, action).some(e => e.event === 'decision'), false);
  assert.equal(log.filter(e => e.event === 'decision').length, 3, 'no polling model calls');
  const prompts = readFileSync(join(path, '../context.jsonl'), 'utf8');
  assert.doesNotMatch(prompts, /minutesLeft|time budget/);
}

test('recording waits outside the model decision and verifies the saved wait on two replays', async () => {
  await fixture(async (project, dir, app) => {
    const story: Story = { name: 'chat', path: join(dir, 'chat.md'), title: 'Chat', start: '/', prose: 'Send a message and wait for the complete response.', doneWhen: ['The response is complete'] };
    const evidence = new Evidence(dir);
    const result = await recordStory(project, story, { runDir: dir, evidence });
    assert.equal(result.deterministic, true, result.determinism.join('\n'));
    assert.equal(result.stats.actions, 3);
    assert.equal(app.submissions, 3, 'one submission per execution, no duplicates');
    assert.ok(result.stats.waitMs! > 800);
    assert.ok(result.stats.modelMs < result.stats.waitMs!);
    const baseline = readBaseline(result.baseline!);
    assert.equal(baseline.steps[2].action.type, 'wait');
    assert.equal(baseline.steps[2].settleMs, 0);
    assert.equal(baseline.checks[1].type, 'enabled');
    verifyOrder(join(dir, 'trajectory.jsonl'));
    assert.equal(evidence.model.length, 3);
    assert.match(evidence.sections[0].frames.at(-1)!.action, /^wait for/);
    assert.ok(evidence.sections.every(section => section.frames.every(frame => frame.checks.every(check => !check.startsWith('FAIL')))), 'wait predicates must not appear as failed assertions');
    assert.equal(evidence.sections[0].frames[2].checks.length, 0, 'submission has no polling assertions');
  });
});

test('Ctrl+C stops a twenty-minute wait and cleans up the browser', { timeout: 15_000 }, async () => {
  await fixture(async (project, dir) => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(project.config));
    writeFileSync(join(dir, 'stories/chat.md'), '# Chat\n\nSend a message and wait for the complete response.\n\n## Done when\n- The response is complete\n');
    const child = spawn(process.execPath, [join(import.meta.dirname, '../bin/playtest.js'), 'run', 'chat', '--project', dir], { cwd: dir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const closed = new Promise<number | null>(resolve => child.once('close', resolve));
    try {
      const deadline = Date.now() + 8000;
      while (!output.includes('wait for text') && Date.now() < deadline && child.exitCode === null) await delay(20);
      assert.match(output, /wait for text/);
      await delay(100);
      const pids = execFileSync('pgrep', ['-P', String(child.pid)], { encoding: 'utf8' }).trim().split('\n').join(',');
      const children = execFileSync('ps', ['-o', 'pid=,command=', '-p', pids], { encoding: 'utf8' });
      const browser = children.split('\n').find(line => line.includes('--remote-debugging-port'));
      assert.ok(browser, children);
      const pid = Number(browser.trim().split(/\s/)[0]);
      const profile = /--user-data-dir=(\S+)/.exec(browser)?.[1];
      assert.ok(profile && existsSync(profile));
      const started = performance.now();
      child.kill('SIGINT');
      assert.equal(await closed, 130, output);
      assert.ok(performance.now() - started < 5000);
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
      assert.equal(existsSync(profile), false);
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
      await closed;
    }
  }, 1_200_000);
});

test('exploration records waiting as a step and reproduces without model polling', async () => {
  await fixture(async (project, _dir, app) => {
    const result = await explore(project, { steps: 3, fresh: true, goal: 'Send one message and wait for it.' });
    assert.equal(result.session.outcome, 'done', result.session.error);
    assert.equal(result.session.steps[2].type, 'wait');
    assert.ok(result.session.stats.waitMs! > 800);
    assert.equal(result.findings.length, 0);
    assert.equal(app.submissions, 2);
    verifyOrder(join(result.session.runDir, 'trajectory.jsonl'));
  });
});
