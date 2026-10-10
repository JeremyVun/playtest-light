// Milestone 1, spike 2: a 20-step sample-app story replayed through the browser layer, timed by phase.
// Usage: node tools/spike-replay.ts [--warm N] [--base-url URL] [--json]
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { connectBrowser, fingerprintDistance, lastActTimings, launchBrowser, stopBrowser } from '../src/browser/index.ts';
import type { Action, Browser } from '../src/types.ts';

const APP_DIR = join(import.meta.dirname, '..', 'fixtures', 'sample-app');

const STORY: Action[] = [
  { type: 'fill', target: { role: 'textbox', name: 'Email' }, value: 'admin@example.test' },
  { type: 'fill', target: { role: 'textbox', name: 'Password' }, value: 'admin-pass-1' },
  { type: 'click', target: { role: 'button', name: 'Sign in' } },
  { type: 'fill', target: { role: 'searchbox', name: 'Search projects' }, value: 'Northern' },
  { type: 'select', target: { role: 'combobox', name: 'Status' }, option: 'Active' },
  { type: 'select', target: { role: 'combobox', name: 'Status' }, option: 'All statuses' },
  { type: 'fill', target: { role: 'searchbox', name: 'Search projects' }, value: '' },
  { type: 'click', target: { role: 'button', name: 'Next' } },
  { type: 'click', target: { role: 'button', name: 'Previous' } },
  { type: 'click', target: { role: 'link', name: 'Northern Onboarding' } },
  { type: 'click', target: { role: 'button', name: 'New task' } },
  { type: 'fill', target: { role: 'textbox', name: 'Title' }, value: 'Write launch email' },
  { type: 'select', target: { role: 'combobox', name: 'Priority' }, option: 'High' },
  { type: 'click', target: { role: 'button', name: 'Save task' } },
  { type: 'click', target: { role: 'checkbox', name: 'Mark "Write launch email" complete' } },
  { type: 'click', target: { role: 'link', name: 'Settings' } },
  { type: 'fill', target: { role: 'textbox', name: 'Display name' }, value: 'Ada Lovelace' },
  { type: 'click', target: { role: 'switch', name: 'Email notifications' } },
  { type: 'click', target: { role: 'button', name: 'Save settings' } },
  { type: 'click', target: { role: 'link', name: 'Projects' } },
];

const PAGE_OPTIONS = { viewport: [1280, 800] as [number, number], widths: [420, 1280], clock: '2026-04-01T12:00:00Z' };

type StepTiming = { action: number; settle: number; layout: number; snapshot: number; fingerprint: number; total: number };
type Run = { phases: Record<string, number>; steps: StepTiming[]; lines: string[][]; fingerprints: string[]; failures: string[]; issues: string[] };

export async function startSampleApp(env: Record<string, string> = {}): Promise<{ baseUrl: string; stop(): Promise<void> }> {
  const port = 0;
  let baseUrl = '';
  const dir = mkdtempSync(join(tmpdir(), 'playtest-spike-'));
  const child: ChildProcess = spawn(process.execPath, ['server/main.ts'], {
    cwd: APP_DIR,
    env: { ...process.env, TEST_MODE: '1', TEST_NOW: '2026-04-01T12:00:00Z', PORT: String(port), DB_PATH: join(dir, 'app.sqlite'), ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`sample app exited with ${code}`)));
    child.stdout!.on('data', (chunk: Buffer) => {
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(chunk.toString());
      if (match) { baseUrl = match[1]; resolve(); }
    });
  });
  return {
    baseUrl,
    async stop() {
      child.removeAllListeners('exit');
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function replay(baseUrl: string, wsUrl: string, phases: Record<string, number>): Promise<Run> {
  const run: Run = { phases, steps: [], lines: [], fingerprints: [], failures: [], issues: [] };
  const time = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    const value = await fn();
    run.phases[name] = (run.phases[name] ?? 0) + performance.now() - start;
    return value;
  };
  const begin = performance.now();
  await time('app reset', () => fetch(`${baseUrl}/__test/reset`, { method: 'POST' }).then((r) => r.text()));
  const browser: Browser = await time('connect', () => connectBrowser(wsUrl));
  const page = await time('context + page', () => browser.newPage({ baseUrl, ...PAGE_OPTIONS }));
  const opened = await time('open start page', () => page.goto('/login'));
  if (!opened.ok) run.failures.push(`goto: ${opened.error}`);
  run.issues.push(...opened.issues.map((i) => `start: ${i.key}`));
  for (const [i, action] of STORY.entries()) {
    const start = performance.now();
    const result = await page.act(action);
    if (!result.ok) run.failures.push(`step ${i + 1}: ${result.error}`);
    run.issues.push(...result.issues.map((issue) => `step ${i + 1}: ${issue.key}`));
    const t = lastActTimings(page);
    const actEnd = performance.now();
    const snapshot = await page.snapshot();
    const snapEnd = performance.now();
    const fingerprint = await page.fingerprint();
    const end = performance.now();
    run.lines.push(snapshot.lines);
    run.fingerprints.push(fingerprint);
    run.steps.push({
      action: t?.actionMs ?? 0,
      settle: t?.settleMs ?? 0,
      layout: t?.layoutMs ?? 0,
      snapshot: snapEnd - actEnd,
      fingerprint: end - snapEnd,
      total: end - start,
    });
  }
  await time('close', async () => {
    await page.close();
    await browser.disconnect();
  });
  run.phases['steps total'] = run.steps.reduce((sum, s) => sum + s.total, 0);
  run.phases['run total'] = performance.now() - begin + (run.phases['browser launch'] ?? 0);
  return run;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const ms = (n: number | undefined) => (n === undefined ? '-' : n.toFixed(1));
const describe = (a: Action) => {
  const target = 'target' in a && a.target && 'role' in a.target ? ` ${a.target.role} "${a.target.name}"` : '';
  const extra = a.type === 'fill' ? ` = "${a.value}"` : a.type === 'select' ? ` = "${a.option}"` : '';
  return `${a.type}${target}${extra}`.slice(0, 58);
};

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { warm: { type: 'string', default: '5' }, 'base-url': { type: 'string' }, json: { type: 'boolean' } } });
  const app = values['base-url'] ? undefined : await startSampleApp();
  const baseUrl = values['base-url'] ?? app!.baseUrl;
  let launched: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    const launchStart = performance.now();
    launched = await launchBrowser();
    const cold = await replay(baseUrl, launched.wsUrl, { 'browser launch': performance.now() - launchStart });
    const warm: Run[] = [];
    for (let i = 0; i < Number(values.warm); i++) warm.push(await replay(baseUrl, launched.wsUrl, {}));

    const all = [cold, ...warm];
    const snapshotDiffs = all.slice(1).map((r) => r.lines.filter((l, i) => l.join('\n') !== cold.lines[i]?.join('\n')).length);
    const fpDistances = all.slice(1).flatMap((r) => r.fingerprints.map((f, i) => fingerprintDistance(f, cold.fingerprints[i])));
    const failures = all.flatMap((r) => r.failures);

    if (values.json) {
      console.log(JSON.stringify({ chrome: launched.version, cold, warm, snapshotDiffs, fpDistances, failures }));
      return;
    }
    console.log(`chrome-headless-shell ${launched.version}, ${process.platform}-${process.arch}, ${STORY.length} steps, 1 cold + ${warm.length} warm runs (ms)\n`);
    const phaseNames = ['browser launch', 'app reset', 'connect', 'context + page', 'open start page', 'steps total', 'close', 'run total'];
    console.log(`${'phase'.padEnd(18)}${'cold'.padStart(9)}${'warm med'.padStart(10)}${'warm min'.padStart(10)}${'warm max'.padStart(10)}`);
    for (const name of phaseNames) {
      const w = warm.map((r) => r.phases[name]).filter((x) => x !== undefined);
      console.log(`${name.padEnd(18)}${ms(cold.phases[name]).padStart(9)}${(w.length ? ms(median(w)) : '-').padStart(10)}${(w.length ? ms(Math.min(...w)) : '-').padStart(10)}${(w.length ? ms(Math.max(...w)) : '-').padStart(10)}`);
    }
    const cols = ['action', 'settle', 'layout', 'snapshot', 'fingerprint', 'total'] as const;
    console.log(`\nPer step, median of warm runs (cold in brackets for total)`);
    console.log(`${'#'.padStart(2)} ${'step'.padEnd(58)}${cols.map((c) => c.padStart(9)).join('')}${'cold'.padStart(9)}`);
    for (const [i, action] of STORY.entries()) {
      const row = cols.map((c) => ms(median(warm.map((r) => r.steps[i][c]))).padStart(9)).join('');
      console.log(`${String(i + 1).padStart(2)} ${describe(action).padEnd(58)}${row}${ms(cold.steps[i].total).padStart(9)}`);
    }
    const sums = cols.map((c) => ms(median(warm.map((r) => r.steps.reduce((sum, s) => sum + s[c], 0)))).padStart(9)).join('');
    console.log(`${''.padStart(2)} ${'sum (median of per-run sums)'.padEnd(58)}${sums}`);
    console.log(`\nDeterminism vs the cold run: snapshot steps differing per run [${snapshotDiffs.join(', ')}], fingerprint distance max ${Math.max(...fpDistances)}`);
    const issues = [...new Set(all.flatMap((r) => r.issues))];
    console.log(issues.length ? `Issues:\n  ${issues.join('\n  ')}` : 'Issues: none');
    if (failures.length) console.log(`Failures:\n  ${failures.join('\n  ')}`);
  } finally {
    if (launched) await stopBrowser(launched);
    await app?.stop();
  }
}

if (import.meta.main) await main();
