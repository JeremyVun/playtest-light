import { displayPath } from '../project.ts';
import { describeCheck, describeIssue, seconds } from './format.ts';
import type { SlowStep, StoryResult } from './replay.ts';

const TERMINAL_DIFF_LINES = 14;

export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

function captureHint(r: StoryResult): string {
  const seed = r.seedCommand && r.seedCwd ? `cd ${shellQuote(r.seedCwd)} && ${r.seedCommand}` : r.seedCommand;
  return `pt run ${shellQuote(r.storyPath ?? r.story)} --view --url ${shellQuote(r.url)}${seed ? ` --seed ${shellQuote(seed)}` : ' --no-seed'}`;
}

type Drift = StoryResult['drift'][number];

// A change that repeats on every later step (a new nav link) is shown once with its steps.
export function groupDrift(drift: Drift[]): { first: Drift; steps: number[] }[] {
  const groups = new Map<string, { first: Drift; steps: number[] }>();
  for (const d of drift) {
    const key = d.diff.filter((line) => !line.startsWith('@@')).join('\n');
    const group = groups.get(key);
    if (group) group.steps.push(d.step);
    else groups.set(key, { first: d, steps: [d.step] });
  }
  return [...groups.values()];
}

// [3, 4, 5, 7] -> "3-5, 7"
export function stepList(steps: number[]): string {
  const sorted = [...new Set(steps)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    runs.push(j > i + 1 ? `${sorted[i]}-${sorted[j]}` : j === i + 1 ? `${sorted[i]}, ${sorted[j]}` : `${sorted[i]}`);
    i = j;
  }
  return runs.join(', ');
}

function measured(s: SlowStep): string {
  const again = s.rerunMs.length ? `, then ${s.rerunMs.map((ms) => `${ms}ms`).join(' and ')} on ${s.rerunMs.length > 1 ? 're-runs' : 'a re-run'}` : '';
  return `settled in ${s.ms}ms${again}, baseline ${s.baselineMs}ms`;
}

function headline(r: StoryResult): string {
  if (r.status === 'error') return `error: ${r.error}`;
  const parts: string[] = [];
  if (r.drift.length) parts.push(`snapshot drift at step ${r.drift[0].step}${r.drift.length > 1 ? ` (+${r.drift.length - 1} more)` : ''}`);
  if (r.stopped) parts.push(`stopped at step ${r.stopped.step}`);
  const failedChecks = r.checks.filter((c) => !c.ok).length;
  if (failedChecks) parts.push(`${failedChecks} check${failedChecks > 1 ? 's' : ''} failed`);
  if (r.newIssues.length) parts.push(`${r.newIssues.length} new issue${r.newIssues.length > 1 ? 's' : ''}`);
  if (r.slow.length) parts.push(`${r.slow.length} slow step${r.slow.length > 1 ? 's' : ''}`);
  return parts.join(', ');
}

// Short plain lines for agents: one per story, details only for failures.
export function checkSummary(results: StoryResult[], ms: number, reportPath: string): string[] {
  const width = Math.max(...results.map((r) => r.story.length));
  const out: string[] = [];
  for (const r of results) {
    const tag = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'ERROR';
    const steps = r.status === 'error' ? '' : `${r.ran}/${r.steps} steps `;
    const head = `${tag.padEnd(5)} ${r.story.padEnd(width)}  ${steps}${seconds(r.ms)}`;
    out.push(r.status === 'pass' ? head : `${head}: ${headline(r)}`);
    if (r.status === 'fail') {
      const first = r.drift[0];
      if (first) {
        out.push(`  step ${first.step} ${first.action} -> ${first.url}:`);
        const diff = first.diff.length > TERMINAL_DIFF_LINES ? [...first.diff.slice(0, TERMINAL_DIFF_LINES), `… ${first.diff.length - TERMINAL_DIFF_LINES} more lines in the report`] : first.diff;
        out.push(...diff.map((l) => `    ${l}`));
      }
      const [same, ...others] = groupDrift(r.drift);
      if (same?.steps.length > 1) out.push(`  also drifted the same way: steps ${stepList(same.steps.slice(1))}`);
      if (others.length) out.push(`  also drifted differently: steps ${stepList(others.flatMap((g) => g.steps))}`);
      if (r.stopped) out.push(`  stopped at step ${r.stopped.step} ${r.stopped.action}: ${r.stopped.error}`);
      for (const c of r.checks.filter((c) => !c.ok)) out.push(`  check failed: ${describeCheck(c.check)}: ${c.detail}`);
      for (const i of r.newIssues) out.push(`  new issue at ${i.step ? `step ${i.step}` : 'start'}: ${describeIssue(i.issue)}`);
      for (const s of r.slow) out.push(`  slow step ${s.step} ${s.action}: ${measured(s)}`);
      out.push(`  see it: ${captureHint(r)}`);
    }
    for (const s of r.rerun?.cleared ?? []) out.push(`  not slow on a re-run, step ${s.step} ${s.action}: ${measured(s)}`);
    if (r.visual.length) out.push(`  warning: visual drift at step${r.visual.length > 1 ? 's' : ''} ${r.visual.map((v) => `${v.step} (distance ${v.distance})`).join(', ')}`);
  }
  const passed = results.filter((r) => r.status === 'pass').length;
  const failedCount = results.filter((r) => r.status === 'fail').length;
  const errors = results.length - passed - failedCount;
  out.push(
    `${results.length} ${results.length === 1 ? 'story' : 'stories'}: ${passed} passed, ${failedCount} failed${errors ? `, ${errors} errored` : ''} in ${seconds(ms)}; report ${displayPath(reportPath)}`,
  );
  return out;
}

export function checkMarkdown(results: StoryResult[], meta: { ms: number; seeded: boolean; app: string; chrome: string }): string {
  const out: string[] = ['# pt run', ''];
  out.push(`App ${meta.app} (${meta.seeded ? 'seeded before each replay' : 'no seed; existing data'}), chrome ${meta.chrome}, ${seconds(meta.ms)}.`, '');
  out.push('| Story | Result | Steps | Time |', '|---|---|---|---|');
  for (const r of results) out.push(`| ${r.story} | ${r.status === 'pass' ? 'pass' : `**${r.status}**: ${headline(r)}`} | ${r.ran}/${r.steps} | ${seconds(r.ms)} |`);
  for (const r of results) {
    if (r.status === 'pass' && !r.visual.length && !r.rerun?.cleared.length) continue;
    out.push('', `## ${r.story}: ${r.status}`, '');
    if (r.error) out.push(`Error: ${r.error}`, '');
    for (const { first: d, steps } of groupDrift(r.drift)) {
      out.push(`### Step ${d.step}: ${d.action} -> ${d.url}`, '');
      if (steps.length > 1) out.push(`The same change again at steps ${stepList(steps.slice(1))}.`, '');
      out.push('Snapshot drift (baseline `-`, now `+`):', '', '```diff', ...d.diff, '```', '');
    }
    if (r.stopped) out.push(`Stopped at step ${r.stopped.step}, \`${r.stopped.action}\`: ${r.stopped.error}`, '');
    const failedChecks = r.checks.filter((c) => !c.ok);
    if (failedChecks.length) out.push('Failed checks:', '', ...failedChecks.map((c) => `- ${describeCheck(c.check)}: ${c.detail}`), '');
    if (r.newIssues.length) out.push('New mechanical issues:', '', ...r.newIssues.map((i) => `- ${i.step ? `step ${i.step}` : 'start'}: ${describeIssue(i.issue)}`), '');
    if (r.slow.length) out.push('Slow steps:', '', ...r.slow.map((s) => `- step ${s.step} \`${s.action}\`: ${measured(s)}`), '');
    if (r.rerun) {
      const { runs, ms, cleared } = r.rerun;
      out.push(`Slow steps were replayed again ${meta.seeded ? 'after seeding' : 'without resetting data'} ${runs === 1 ? 'once' : `${runs} times`} (${seconds(ms)}) to rule out load on the machine.`, '');
      if (cleared.length) out.push('Not slow on a re-run, so not failures:', '', ...cleared.map((s) => `- step ${s.step} \`${s.action}\`: ${measured(s)}`), '');
    }
    if (r.visual.length) out.push('Visual drift (warning only):', '', ...r.visual.map((v) => `- step ${v.step} \`${v.action}\`: fingerprint distance ${v.distance}`), '');
    else if (!r.visualCompared && r.status !== 'error') out.push('Visual drift not compared: the baseline was recorded on another platform or Chrome.', '');
    if (r.status !== 'error') out.push(`Capture every step: \`${captureHint(r)}\``);
  }
  return `${out.join('\n')}\n`;
}
