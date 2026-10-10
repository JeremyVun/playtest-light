import { fingerprintDistance, FINGERPRINT_THRESHOLD } from '../browser/index.ts';
import type { Baseline, BaselineStep, Check, Issue, Page, RecordedAction, Story } from '../types.ts';
import { BASELINE_VERSION, harnessVersion, orderAction, orderCheck, platformId } from './baseline.ts';
import { unifiedDiff } from './diff.ts';
import { describeAction } from './format.ts';
import { openStory, type Run } from './session.ts';

export const SLOW_FACTOR = 3;
export const SLOW_MIN_MS = 500;
export const SLOW_RERUNS = 2;
const DIFF_CONTEXT = 2;

export type StepResult = BaselineStep & { index: number; ok: boolean; error?: string };

export type CheckOutcome = { check: Check; ok: boolean; detail?: string };

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

export async function replaySteps(
  page: Page,
  actions: RecordedAction[],
  opts: { fingerprint?: boolean } = {},
): Promise<StepResult[]> {
  const steps: StepResult[] = [];
  for (const [index, action] of actions.entries()) {
    const result = await page.act(action);
    const snap = await page.snapshot();
    const step: StepResult = {
      index,
      ok: result.ok,
      action,
      url: pathOf(snap.url),
      snapshot: snap.lines,
      fingerprint: opts.fingerprint && result.ok ? await page.fingerprint() : '',
      settleMs: result.settleMs,
      issues: result.issues,
    };
    if (result.error) step.error = result.error;
    steps.push(step);
    if (!result.ok) break;
  }
  return steps;
}

export async function evaluateChecks(page: Page, checks: Check[]): Promise<CheckOutcome[]> {
  const out: CheckOutcome[] = [];
  for (const check of checks) {
    const r = await page.check(check);
    out.push(r.detail ? { check, ok: r.ok, detail: r.detail } : { check, ok: r.ok });
  }
  return out;
}

export type Built = { baseline: Baseline; failed?: StepResult; checks: CheckOutcome[] };

// Replays a candidate with no model and captures what the baseline stores. Recording-time
// snapshots are not used: the model's think time lets timers (toasts) fire that a replay at
// browser speed never waits for.
export async function buildBaseline(run: Run, story: Pick<Story, 'name' | 'start' | 'viewport'>, actions: RecordedAction[], checks: Check[]): Promise<Built> {
  run.evidence?.phase(`${story.name}: build baseline`);
  const { page, opened, viewport } = await openStory(run, story);
  try {
    const steps = await replaySteps(page, actions.map(orderAction), { fingerprint: true });
    const failed = steps.find((s) => !s.ok);
    const outcomes = failed ? [] : await evaluateChecks(page, checks);
    const baseline: Baseline = {
      version: BASELINE_VERSION,
      story: story.name,
      url: run.url,
      seeded: Boolean(run.project.config.seed),
      platform: platformId(),
      chrome: run.browser.version,
      harness: harnessVersion(),
      viewport,
      start: story.start,
      startIssues: opened.issues,
      steps: steps.filter((s) => s.ok).map(({ action, url, snapshot, fingerprint, settleMs, issues }) => ({ action, url, snapshot, fingerprint, settleMs, issues })),
      checks: checks.map(orderCheck),
    };
    return failed ? { baseline, failed, checks: outcomes } : { baseline, checks: outcomes };
  } finally {
    await page.close();
  }
}

export type SlowStep = { step: number; action: string; baselineMs: number; ms: number; rerunMs: number[] };

export type StoryResult = {
  story: string;
  status: 'pass' | 'fail' | 'error';
  ms: number;
  url: string;
  seeded: boolean;
  seedCommand?: string;
  seedCwd?: string;
  storyPath?: string;
  steps: number;
  ran: number;
  // 1-based step that could not run; the replay ends there.
  stopped?: { step: number; action: string; error: string };
  drift: { step: number; action: string; url: string; diff: string[] }[];
  checks: CheckOutcome[];
  // step 0 is opening `start`.
  newIssues: { step: number; issue: Issue }[];
  // Slow on the first run and on every re-run.
  slow: SlowStep[];
  // Present when slow steps were replayed again; cleared ones were not slow on a re-run.
  rerun?: { runs: number; ms: number; cleared: SlowStep[] };
  visual: { step: number; action: string; distance: number }[];
  visualCompared: boolean;
  error?: string;
};

export function failed(r: StoryResult): boolean {
  return Boolean(r.stopped || r.drift.length || r.checks.some((c) => !c.ok) || r.newIssues.length || r.slow.length);
}

// Issue timing can shift by a step (a late response lands after the next action), so a key
// counts as accepted when the baseline saw it at that step, a neighbour, or on opening.
function acceptedKeys(baseline: Baseline, step: number): Set<string> {
  const keys = new Set(baseline.startIssues.map((i) => i.key));
  for (let s = step - 1; s <= step + 1; s++) for (const i of baseline.steps[s - 1]?.issues ?? []) keys.add(i.key);
  return keys;
}

function isSlow(ms: number, baselineMs: number): boolean {
  return ms > baselineMs * SLOW_FACTOR && ms - baselineMs > SLOW_MIN_MS;
}

// Settle times of the first `count` steps from a reset; shorter when a step fails.
async function settleTimes(run: Run, baseline: Baseline, count: number): Promise<number[]> {
  run.evidence?.phase(`${baseline.story}: slow-step retry`, baseline);
  const { page } = await openStory(run, { start: baseline.start, viewport: baseline.viewport });
  try {
    const steps = await replaySteps(page, baseline.steps.slice(0, count).map((s) => s.action));
    return steps.filter((s) => s.ok).map((s) => s.settleMs);
  } finally {
    await page.close();
  }
}

// Disk contention on a loaded machine stalls single writes for a second or two, so a slow step
// fails the story only when it is slow again on every re-run.
async function rerunSlow(run: Run, baseline: Baseline, result: StoryResult): Promise<void> {
  const started = performance.now();
  const cleared: SlowStep[] = [];
  let slow = result.slow;
  let runs = 0;
  while (slow.length && runs < SLOW_RERUNS) {
    runs++;
    const times = await settleTimes(run, baseline, Math.max(...slow.map((s) => s.step)));
    const still: SlowStep[] = [];
    for (const s of slow) {
      const ms = times[s.step - 1];
      if (ms !== undefined) s.rerunMs.push(ms);
      (ms === undefined || isSlow(ms, s.baselineMs) ? still : cleared).push(s);
    }
    slow = still;
  }
  result.slow = slow;
  result.rerun = { runs, ms: Math.round(performance.now() - started), cleared };
}

export async function checkStory(run: Run, baseline: Baseline): Promise<StoryResult> {
  run.evidence?.phase(`${baseline.story}: replay`, baseline);
  const started = performance.now();
  const result: StoryResult = {
    story: baseline.story,
    status: 'pass',
    ms: 0,
    url: run.url,
    seeded: Boolean(run.project.config.seed),
    seedCommand: run.project.config.seed,
    seedCwd: run.project.config.seed ? run.project.seedCwd : undefined,
    steps: baseline.steps.length,
    ran: 0,
    drift: [],
    checks: [],
    newIssues: [],
    slow: [],
    visual: [],
    visualCompared: baseline.platform === platformId() && baseline.chrome === run.browser.version,
  };
  try {
    const { page, opened } = await openStory(run, { start: baseline.start, viewport: baseline.viewport });
    try {
      const start = acceptedKeys(baseline, 0);
      for (const issue of opened.issues) if (!start.has(issue.key)) result.newIssues.push({ step: 0, issue });
      const steps = await replaySteps(
        page,
        baseline.steps.map((s) => s.action),
        { fingerprint: result.visualCompared },
      );
      for (const step of steps) {
        const n = step.index + 1;
        const want = baseline.steps[step.index];
        const action = describeAction(want.action);
        if (!step.ok) {
          result.stopped = { step: n, action, error: step.error ?? 'failed' };
          break;
        }
        result.ran = n;
        const diff = unifiedDiff(want.snapshot, step.snapshot, DIFF_CONTEXT);
        if (diff.length) result.drift.push({ step: n, action, url: step.url, diff });
        const accepted = acceptedKeys(baseline, n);
        for (const issue of step.issues)
          if (!accepted.has(issue.key) && !result.newIssues.some((i) => i.issue.key === issue.key)) result.newIssues.push({ step: n, issue });
        if (isSlow(step.settleMs, want.settleMs)) result.slow.push({ step: n, action, baselineMs: want.settleMs, ms: step.settleMs, rerunMs: [] });
        if (result.visualCompared && want.fingerprint && step.fingerprint) {
          const distance = fingerprintDistance(want.fingerprint, step.fingerprint);
          if (distance > FINGERPRINT_THRESHOLD) result.visual.push({ step: n, action, distance });
        }
      }
      if (!result.stopped) result.checks = await evaluateChecks(page, baseline.checks);
    } finally {
      await page.close();
    }
    if (result.slow.length && !failed({ ...result, slow: [] })) await rerunSlow(run, baseline, result);
    result.status = failed(result) ? 'fail' : 'pass';
  } catch (error) {
    result.status = 'error';
    result.error = (error as Error).message;
  }
  result.ms = Math.round(performance.now() - started);
  return result;
}
