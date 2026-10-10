import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { resizePage } from '../browser/index.ts';
import { displayPath } from '../project.ts';
import type { ActResult, CheckResult, Issue, Locator, Page, Project } from '../types.ts';
import { captureResize } from './evidence.ts';
import { parseCheck } from './actor.ts';
import { unifiedDiff } from './diff.ts';
import type { Attempt, ExploreSession, ExploreStep, FindingCheck, FindingKind, Report, Severity } from './explore.ts';
import { describeAction, describeCheck, describeIssue, seconds } from './format.ts';
import { openStory, type Run } from './session.ts';

export const SLOW_NOTE_MS = 1000;
// A step this slow is a perf finding without the model.
export const SLOW_STEP_MS = 2000;
const EXCERPT_CONTEXT = 6;
const EXCERPT_MAX = 24;
const PAIN_POINTS_SHOWN = 12;

export type Finding = {
  id: string;
  source: 'model' | 'mechanical';
  title: string;
  kind: FindingKind;
  severity: Severity;
  expected: string;
  actual: string;
  steps: number[];
  // Replayed to this step (0: on opening) to confirm it.
  at: number;
  checks?: FindingCheck[];
  // Mechanical: the issue at each width it was seen at; merged: the harness issues it explains.
  issues?: Issue[];
  task?: string;
  // An action after step `at` that is part of the problem (a click that failed).
  then?: string;
  reproduced: boolean;
  confirmation: string;
  // Reproduced, but every check already held before the step it reports, so it shows no change.
  weak?: string;
  // Harness findings folded into this one because it explains them.
  merged?: { title: string; reproduced: boolean; confirmation: string }[];
  evidence: { url: string; snapshot: string[]; issues: string[] };
  slug: string;
  story: string;
};

export type PainPoint = {
  kind: 'failed-action' | 'unmet-expectation' | 'slow' | 'backtrack' | 'revisit' | 'finding';
  title: string;
  // Session steps involved; a failed action counts as the step it followed.
  steps: number[];
  actions: number;
  ms: number;
};

export type Built = {
  findings: Finding[];
  painPoints: PainPoint[];
  // Requests the app answered 4xx: it rejecting input explore provoked on purpose, so not findings.
  noted: Issue[];
  // Page path before step 1 (index 0) and after each step.
  urls: string[];
  replay: { ms: number; ran: number; stopped?: { step: number; error: string } };
};

type ReplayStep = { url: string; lines: string[]; settleMs: number; issues: Issue[] };
type Replayed = {
  ms: number;
  start: { url: string; lines: string[]; issues: Issue[] };
  steps: ReplayStep[];
  stopped?: { step: number; error: string };
  checks: Map<Report, CheckResult>;
  // Whether every check of the report already held at its prior step.
  before: Map<Report, boolean>;
};

export function parseFindingCheck(raw: unknown): FindingCheck | string {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
  if (o?.type === 'no-text') return typeof o.value === 'string' && o.value ? { type: 'no-text', value: o.value } : 'no-text check needs a value';
  return parseCheck(raw);
}

export function describeFindingCheck(c: FindingCheck): string {
  return c.type === 'no-text' ? `no text ${JSON.stringify(c.value)}` : describeCheck(c);
}

export function describeFindingChecks(checks: FindingCheck[]): string {
  return checks.map(describeFindingCheck).join(' and ');
}

export async function evaluateFindingCheck(page: Page, c: FindingCheck): Promise<CheckResult> {
  if (c.type !== 'no-text') return page.check(c);
  const r = await page.check({ type: 'text', value: c.value });
  return r.ok ? { ok: false, detail: `Text ${JSON.stringify(c.value)} is on the page` } : { ok: true };
}

export async function evaluateFindingChecks(page: Page, checks: FindingCheck[]): Promise<CheckResult> {
  const failed: string[] = [];
  for (const c of checks) {
    const r = await evaluateFindingCheck(page, c);
    if (!r.ok) failed.push(checks.length > 1 ? `${describeFindingCheck(c)}: ${r.detail}` : (r.detail ?? 'false'));
  }
  return failed.length ? { ok: false, detail: failed.join('; ') } : { ok: true };
}

// The step whose page a report is compared with: just before the latest step it cites.
export function priorStep(r: Pick<Report, 'steps' | 'at'>): number {
  const cited = r.steps.filter((s) => s <= r.at);
  return (cited.length ? Math.max(...cited) : r.at) - 1;
}

export function describeStep(s: ExploreStep): string {
  return s.type === 'resize' ? `resize the window to ${s.width}px wide` : describeAction(s);
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

export const bare = (url: string) => url.split('?')[0];

// Evaluate claims at their cited step, even when the actor continued afterwards.
async function replaySession(run: Run, session: ExploreSession): Promise<Replayed> {
  run.evidence?.phase('Exploration: reproduction');
  const started = performance.now();
  const due = new Map<number, Report[]>();
  const dueBefore = new Map<number, Report[]>();
  for (const r of session.reports) {
    due.set(r.at, [...(due.get(r.at) ?? []), r]);
    const prior = priorStep(r);
    if (prior >= 0) dueBefore.set(prior, [...(dueBefore.get(prior) ?? []), r]);
  }
  const checks = new Map<Report, CheckResult>();
  const before = new Map<Report, boolean>();
  const { page, opened } = await openStory(run, { start: session.start, viewport: session.viewport });
  try {
    const evaluate = async (n: number) => {
      for (const r of dueBefore.get(n) ?? []) before.set(r, (await evaluateFindingChecks(page, r.checks)).ok);
      for (const r of due.get(n) ?? []) checks.set(r, await evaluateFindingChecks(page, r.checks));
    };
    const first = await page.snapshot();
    const out: Replayed = { ms: 0, start: { url: pathOf(first.url), lines: first.lines, issues: opened.issues }, steps: [], checks, before };
    await evaluate(0);
    for (const [i, step] of session.steps.entries()) {
      const result = await runStep(page, step, session);
      if (!result.ok) {
        out.stopped = { step: i + 1, error: result.error ?? 'failed' };
        break;
      }
      const snap = await page.snapshot();
      out.steps.push({ url: pathOf(snap.url), lines: snap.lines, settleMs: result.settleMs, issues: result.issues });
      await evaluate(i + 1);
    }
    out.ms = Math.round(performance.now() - started);
    return out;
  } finally {
    await page.close();
  }
}

function provoked(issue: Issue): boolean {
  if (issue.kind !== 'request') return false;
  const m = /^\w+ (\S+) 4\d\d$/.exec(issue.message);
  return Boolean(m && bare(m[1]) !== issue.path);
}

// `seen`: every step a harness issue showed at.
export type Draft = Omit<Finding, 'id' | 'slug' | 'story'> & { seen?: number[] };

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 };
const LAYOUT = new Set(['page-overflow', 'content-overflow', 'covered']);
// Shorter names ("Save", "Edit") are too common to tie two findings together.
const MIN_SUBJECT = 8;

function serverError(issue: Issue): boolean {
  return issue.kind === 'request' && /^\w+ \S+ (5\d\d|failed\b.*)$/.test(issue.message);
}

function subjectOfDraft(d: Draft): string | undefined {
  const name = subjectOf(d.issues?.[0]?.message ?? d.title);
  return name && name.length >= MIN_SUBJECT ? name.toLowerCase() : undefined;
}

function isLayout(d: Draft): boolean {
  return d.then !== undefined || LAYOUT.has(d.issues?.[0]?.kind ?? '');
}

// How strongly a model finding explains a harness one: lower is closer; undefined when it does not.
// A server error on the model's page within a step of a step its bug cites, a slow step likewise
// for its perf finding, or a layout issue about an element the model's finding names.
function explains(model: Draft, harness: Draft, page: (d: Draft) => string, urls: string[]): number | undefined {
  if (page(model) !== page(harness)) return undefined;
  const anchors = [model.at, ...model.steps];
  const distance = Math.min(...(harness.seen ?? harness.steps.concat(harness.at)).flatMap((s) => anchors.map((a) => Math.abs(s - a))));
  const issue = harness.issues?.[0];
  if (issue && serverError(issue)) {
    const here = bare(urls[model.at] ?? '');
    return model.kind === 'bug' && distance <= 1 && harness.issues!.some((i) => i.path === here) ? distance : undefined;
  }
  if (harness.kind === 'perf' && !issue) return model.kind === 'perf' && distance <= 1 ? distance : undefined;
  const name = isLayout(harness) ? subjectOfDraft(harness) : undefined;
  if (!name) return undefined;
  const text = [model.title, model.actual, model.expected, ...(model.checks ?? []).map(describeFindingCheck)].join(' ').toLowerCase();
  return text.includes(name) ? distance : undefined;
}

function fold(into: Draft, from: Draft): void {
  into.issues = [...(into.issues ?? []), ...(from.issues ?? [])];
  into.merged = [...(into.merged ?? []), { title: from.title, reproduced: from.reproduced, confirmation: from.confirmation }];
  if (SEVERITY_RANK[from.severity] > SEVERITY_RANK[into.severity]) into.severity = from.severity;
  if (from.then && !into.then && from.at === into.at) into.then = from.then;
  if (from.reproduced) delete into.weak;
  if (from.reproduced && !into.reproduced) {
    into.reproduced = true;
    into.confirmation = `${from.title}: ${from.confirmation}; the model's check: ${into.confirmation}`;
  }
  const own = new Set((from.issues ?? []).map(describeIssue));
  into.evidence.issues = into.evidence.issues.filter((i) => !own.has(i));
}

// One defect, one finding: a model finding takes in the harness findings it explains, and harness
// layout findings about the same element on the same page become one.
export function mergeExplained(drafts: Draft[], urls: string[]): Draft[] {
  const pages = new Map(drafts.map((d) => [d, pattern(bare((d.source === 'model' ? undefined : d.issues?.[0]?.path) ?? urls[d.at] ?? ''))]));
  const page = (d: Draft) => pages.get(d) ?? '';
  const models = drafts.filter((d) => d.source === 'model');
  const kept: Draft[] = [...models];
  for (const h of drafts.filter((d) => d.source === 'mechanical')) {
    let best: { d: Draft; distance: number } | undefined;
    for (const m of models) {
      const distance = explains(m, h, page, urls);
      if (distance !== undefined && (!best || distance < best.distance)) best = { d: m, distance };
    }
    const twin = best ? undefined : kept.find((k) => k.source === 'mechanical' && isLayout(k) && isLayout(h) && page(k) === page(h) && subjectOfDraft(k) !== undefined && subjectOfDraft(k) === subjectOfDraft(h));
    if (best) fold(best.d, h);
    else if (twin) {
      const [into, from] = SEVERITY_RANK[h.severity] > SEVERITY_RANK[twin.severity] ? [h, twin] : [twin, h];
      fold(into, from);
      kept[kept.indexOf(twin)] = into;
    } else kept.push(h);
  }
  return kept;
}

function widthsText(widths: number[]): string {
  return widths.length ? ` at ${widths.map((w) => `${w}px`).join(' and ')} wide` : '';
}

function mechanicalText(issues: Issue[]): Pick<Finding, 'title' | 'kind' | 'severity' | 'expected' | 'actual'> {
  const issue = new Set(issues.map((i) => i.path)).size > 1 ? { ...issues[0], path: pattern(issues[0].path), message: pattern(issues[0].message) } : issues[0];
  const widths = [...new Set(issues.flatMap((i) => (i.width ? [i.width] : [])))].sort((a, b) => a - b);
  const at = `${issue.path}${widthsText(widths)}`;
  const actual = issue.message;
  switch (issue.kind) {
    case 'console':
      return { title: `Console error on ${issue.path}`, kind: 'bug', severity: 'medium', expected: `${issue.path} logs no console errors`, actual };
    case 'exception':
      return { title: `Uncaught exception on ${issue.path}`, kind: 'bug', severity: 'high', expected: `${issue.path} throws no uncaught exceptions`, actual };
    case 'request': {
      const m = /^(\w+ \S+) (.*)$/.exec(issue.message);
      const request = m?.[1] ?? issue.message;
      const server = /^5\d\d$/.test(m?.[2] ?? '') || /failed/.test(m?.[2] ?? '');
      return { title: `${request} returned ${m?.[2] ?? 'an error'} on ${issue.path}`, kind: 'bug', severity: server ? 'high' : 'medium', expected: `${request} succeeds on ${issue.path}`, actual };
    }
    case 'page-overflow':
      return { title: `Page scrolls sideways on ${at}`, kind: 'ux', severity: 'medium', expected: `${issue.path} fits the window${widthsText(widths)} with no sideways scrolling`, actual };
    case 'content-overflow': {
      const element = issue.message.split(': content is')[0];
      return { title: `${element} overflows its box on ${at}`, kind: 'ux', severity: 'low', expected: `${element} stays inside its box on ${at}`, actual };
    }
    case 'covered': {
      const element = issue.message.split(' is covered by ')[0];
      return { title: `${issue.message} on ${at}`, kind: 'bug', severity: 'medium', expected: `${element} can be clicked on ${at}; nothing covers it`, actual };
    }
    case 'broken-image':
      return { title: `Broken image on ${issue.path}`, kind: 'bug', severity: 'low', expected: `every image on ${issue.path} loads`, actual };
  }
}

// The same issue at several widths is one finding.
// URL segments with a digit in them are usually ids: /projects/prj-001 and /projects/prj-017 are one page.
export function pattern(text: string): string {
  return text.replace(/\/[^\s/?#"]*\d[^\s/?#"]*/g, '/:id');
}

// One finding per issue whatever the width it showed at or the record it was on.
function groupKey(issue: Issue): string {
  const [kind, path, , ...element] = issue.key.split('|');
  return [kind, pattern(path), pattern(element.join('|'))].join('|');
}

// Layout messages cut long names to 60 characters and an ellipsis; the snapshot has them whole.
function needleOf(f: { checks?: FindingCheck[]; message?: string }): string | undefined {
  const c = f.checks?.find((c) => c.type !== 'url');
  if (c?.type === 'text' || c?.type === 'no-text') return c.value;
  if (c && 'locator' in c) return `${c.locator.role} ${JSON.stringify(c.locator.name)}`;
  return f.message ? subjectOf(f.message) : undefined;
}

// The first quoted name in a harness message: the element the issue is about.
function subjectOf(message: string): string | undefined {
  return /"([^"]+)"/.exec(message)?.[1].replace(/…$/, '');
}

// The lines around what the finding is about, else what changed at that step.
function excerpt(lines: string[], previous: string[] | undefined, needle: string | undefined): string[] {
  const hit = needle ? lines.findIndex((l) => l.includes(needle)) : -1;
  if (hit >= 0) return lines.slice(Math.max(0, hit - EXCERPT_CONTEXT), hit + EXCERPT_CONTEXT + 1);
  if (previous) {
    const changed = unifiedDiff(previous, lines, 1).filter((l) => !l.startsWith('@@'));
    if (changed.length) return changed.slice(0, EXCERPT_MAX);
  }
  return lines.slice(0, EXCERPT_MAX);
}

function evidence(replay: Replayed, at: number, f: { checks?: FindingCheck[]; message?: string; own?: Issue[] }): Finding['evidence'] {
  const step = at === 0 ? replay.start : replay.steps[at - 1];
  if (!step) return { url: '', snapshot: [], issues: [] };
  const previous = at === 0 ? undefined : at === 1 ? replay.start.lines : replay.steps[at - 2]?.lines;
  const own = new Set(f.own?.map((i) => i.key));
  return { url: step.url, snapshot: excerpt(step.lines, previous, needleOf(f)), issues: step.issues.filter((i) => !own.has(i.key)).map(describeIssue) };
}

const COVERED = /^(\S+) ("(?:[^"\\]|\\.)*")(?: #(\d+))? is covered by (.+)$/;

function widthAt(session: ExploreSession, step: number): number {
  const resize = session.steps.slice(0, step).findLast((s) => s.type === 'resize');
  return resize?.type === 'resize' ? resize.width : session.viewport[0];
}

// A click that failed because something sits on top of its target is a bug whatever the model thinks.
function coveredClick(a: Attempt, session: ExploreSession, urls: string[]) {
  const m = a.error ? COVERED.exec(a.error) : null;
  if (!m) return undefined;
  const target: Locator = { role: m[1], name: JSON.parse(m[2]) as string };
  if (m[3]) target.nth = Number(m[3]);
  const element = `${m[1]} ${m[2]}${m[3] ? ` #${m[3]}` : ''}`;
  const width = widthAt(session, a.after);
  const path = bare(urls[a.after] ?? '');
  return { key: `${path}|${width}|${element}|${m[4]}`, target, element, cover: m[4], width, path };
}

async function runStep(page: Page, step: ExploreStep, session: ExploreSession): Promise<ActResult> {
  if (step.type !== 'resize') return page.act(step);
  const started = performance.now();
  await resizePage(page, [step.width, session.viewport[1]]);
  await captureResize(page, step.width, Math.round(performance.now() - started));
  return { ok: true, settleMs: 0, issues: [] };
}

// Its own replay, since a click that works on replay changes the page.
async function probeClick(run: Run, session: ExploreSession, after: number, target: Locator): Promise<{ reproduced: boolean; confirmation: string }> {
  run.evidence?.phase('Exploration: covered-control probe');
  const { page } = await openStory(run, { start: session.start, viewport: session.viewport });
  try {
    for (const [i, step] of session.steps.slice(0, after).entries()) {
      const r = await runStep(page, step, session);
      if (!r.ok) return { reproduced: false, confirmation: `the replay could not run step ${i + 1} (${r.error})` };
    }
    const r = await page.act({ type: 'click', target });
    if (!r.ok && r.error?.includes(' is covered by ')) return { reproduced: true, confirmation: `the click failed the same way on a replay ${session.seedCommand ? 'after seeding' : 'without resetting data'} with no model` };
    return { reproduced: false, confirmation: r.ok ? `the click worked on a replay ${session.seedCommand ? 'after seeding' : 'without resetting data'} with no model` : `on a replay the click failed another way: ${r.error}` };
  } finally {
    await page.close();
  }
}

function stoppedBefore(replay: Replayed, at: number): string | undefined {
  return replay.stopped && replay.stopped.step <= at ? `the replay could not run step ${replay.stopped.step} (${replay.stopped.error}), before step ${at}` : undefined;
}

export function slugify(title: string): string {
  const words = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  let slug = '';
  for (const w of words) {
    if (slug && slug.length + w.length + 1 > 60) break;
    slug = slug ? `${slug}-${w}` : w;
  }
  return slug;
}

function stepLines(session: ExploreSession, at: number, then?: string): string[] {
  const lines = session.steps.slice(0, at).flatMap((s) => (s.type === 'resize' ? [] : [`- ${describeAction(s)}`]));
  return then ? [...lines, `- ${then}`] : lines;
}

// The model's task when it gave one, with the explorer's own steps kept as a reference so the
// story stays recordable when the task leaves out an account or a value.
function storyProse(f: Pick<Finding, 'task' | 'at' | 'then'>, session: ExploreSession, urls: string[]): string {
  const lines = stepLines(session, f.at, f.then);
  if (!lines.length) return f.task ?? `Open ${session.start} and look at the page.`;
  if (f.task) return `${f.task}\n\nThe steps the explorer took, for reference (not all may be needed):\n\n${lines.join('\n')}`;
  return `Starting at ${session.start}, do exactly this:\n\n${lines.join('\n')}${f.then ? '' : `\n\nThe page is then ${urls[f.at] ?? 'the last one reached'}.`}`;
}

export function draftStory(f: Pick<Finding, 'title' | 'expected' | 'task' | 'at' | 'then'>, session: ExploreSession, urls: string[]): string {
  const width = session.steps.slice(0, f.at).findLast((s) => s.type === 'resize');
  const front = ['---', `start: ${session.start}`];
  if (width?.type === 'resize') front.push(`viewport: [${width.width}, ${session.viewport[1]}]`);
  front.push('---');
  return [...front, `# ${f.title}`, '', storyProse(f, session, urls), '', '## Done when', `- ${f.expected}`, ''].join('\n');
}

function painPoints(session: ExploreSession, findings: Finding[], urls: string[]): PainPoint[] {
  const groups = new Map<string, PainPoint>();
  const add = (key: string, kind: PainPoint['kind'], title: string, step: number, ms: number) => {
    const g = groups.get(key) ?? { kind, title, steps: [], actions: 0, ms: 0 };
    g.actions++;
    g.ms += ms;
    if (!g.steps.includes(step)) g.steps.push(step);
    groups.set(key, g);
  };
  const byStep = new Map<number, Attempt>();
  for (const a of session.attempts) {
    if (a.step !== undefined) byStep.set(a.step, a);
    const where = bare(urls[a.step ?? a.after] ?? '');
    if (!a.ok) add(`failed|${a.action}|${a.error}`, 'failed-action', `${a.action} failed on ${bare(urls[a.after] ?? '')}: ${a.error}`, a.after, a.ms);
    if (a.unmet) add(`unmet|${a.unmet}`, 'unmet-expectation', `after ${a.action}, expected ${a.unmet}`, a.step ?? a.after, a.ms);
    if (a.ok && a.settleMs >= SLOW_NOTE_MS) add(`slow|${where}`, 'slow', `slow to load: ${where}`, a.step!, a.settleMs);
  }
  const msOf = (step: number) => byStep.get(step)?.ms ?? 0;

  const stays: { path: string; steps: number[] }[] = [];
  session.steps.forEach((s, i) => {
    if (s.type === 'resize') return;
    const path = bare(urls[i + 1] ?? '');
    const last = stays.at(-1);
    if (last?.path === path) last.steps.push(i + 1);
    else stays.push({ path, steps: [i + 1] });
  });
  for (let i = 1; i < stays.length - 1; i++) {
    const [a, b, c] = [stays[i - 1], stays[i], stays[i + 1]];
    if (a.path !== c.path || b.steps.length > 2) continue;
    for (const step of [...b.steps, c.steps[0]]) add(`backtrack|${b.path}`, 'backtrack', `went to ${b.path} and straight back to ${a.path}`, step, msOf(step));
  }
  const visits = new Map<string, number[]>();
  for (const s of stays) visits.set(s.path, [...(visits.get(s.path) ?? []), s.steps[0]]);
  for (const [path, arrivals] of visits) {
    if (arrivals.length < 3) continue;
    for (const step of arrivals.slice(1)) add(`revisit|${path}`, 'revisit', `came back to ${path} ${arrivals.length - 1} times`, step, msOf(step));
  }
  for (const f of findings) {
    if (f.source !== 'model' || (f.kind !== 'ux' && f.kind !== 'copy')) continue;
    for (const step of f.steps.length ? f.steps : [f.at]) add(`finding|${f.id}`, 'finding', `${f.id} (${f.kind}): ${f.title}`, step, msOf(step));
  }
  return [...groups.values()].map((g) => ({ ...g, steps: g.steps.sort((x, y) => x - y) })).sort((x, y) => y.ms - x.ms || y.actions - x.actions);
}

export async function buildFindings(run: Run, session: ExploreSession): Promise<Built> {
  const replay = await replaySession(run, session).catch((error): Replayed => {
    const message = `Reproduction failed: ${(error as Error).message}`;
    session.error = session.error ? `${session.error}; ${message}` : message;
    return { ms: 0, start: { url: session.start, lines: [], issues: [] }, steps: [], checks: new Map(), before: new Map(), stopped: { step: 0, error: message } };
  });
  const urls = [replay.start.url];
  session.steps.forEach((_, i) => urls.push(replay.steps[i]?.url ?? session.stepUrls[i] ?? urls[i]));

  const drafts: Draft[] = [];
  for (const r of session.reports) {
    const result = replay.checks.get(r);
    const check = describeFindingChecks(r.checks);
    const confirmation = result
      ? result.ok
        ? `replayed ${r.at} steps ${session.seedCommand ? 'after seeding' : 'without resetting data'} with no model: ${check} ${r.checks.length > 1 ? 'hold' : 'holds'}`
        : `replayed ${r.at} steps ${session.seedCommand ? 'after seeding' : 'without resetting data'} with no model: ${check} did not hold (${result.detail})`
      : (stoppedBefore(replay, r.at) ?? 'the replay did not reach its step');
    const draft: Draft = {
      source: 'model',
      title: r.title,
      kind: r.kind,
      severity: r.severity,
      expected: r.expected,
      actual: r.actual,
      steps: r.steps,
      at: r.at,
      checks: r.checks,
      reproduced: result?.ok === true,
      confirmation,
      evidence: evidence(replay, r.at, { checks: r.checks }),
    };
    if (draft.reproduced && replay.before.get(r)) draft.weak = `${r.checks.length > 1 ? 'they' : 'it'} already held after step ${priorStep(r)}, before what it reports, so ${r.checks.length > 1 ? 'they show' : 'it shows'} no change`;
    if (r.task) draft.task = r.task;
    drafts.push(draft);
  }

  const noted = new Map<string, Issue>();
  const groups = new Map<string, { issues: Issue[]; step: number; seen: number[] }>();
  const note = (issue: Issue, step: number) => {
    if (provoked(issue)) return noted.set(issue.key, issue);
    const group = groups.get(groupKey(issue)) ?? groups.set(groupKey(issue), { issues: [], step, seen: [] }).get(groupKey(issue))!;
    if (!group.issues.some((i) => i.key === issue.key)) group.issues.push(issue);
    if (!group.seen.includes(step)) group.seen.push(step);
  };
  for (const issue of session.startIssues) note(issue, 0);
  for (const a of session.attempts) for (const issue of a.issues) note(issue, a.step ?? a.after);
  const replayed = new Set([...replay.start.issues, ...replay.steps.flatMap((s) => s.issues)].map((i) => i.key));
  for (const { issues, step, seen } of groups.values()) {
    const back = issues.filter((i) => replayed.has(i.key)).length;
    drafts.push({
      source: 'mechanical',
      ...mechanicalText(issues),
      steps: step ? [step] : [],
      at: step,
      seen,
      issues,
      reproduced: back > 0,
      confirmation: back
        ? `the same issue came back on a replay ${session.seedCommand ? 'after seeding' : 'without resetting data'} with no model${back < issues.length ? ` (at ${back} of its ${issues.length} widths)` : ''}`
        : (stoppedBefore(replay, step) ?? `the issue did not come back on a replay ${session.seedCommand ? 'after seeding' : 'without resetting data'} with no model`),
      evidence: evidence(replay, step, { message: issues[0].message, own: issues }),
    });
  }

  const probed = new Set<string>();
  for (const a of session.attempts) {
    const covered = a.ok ? undefined : coveredClick(a, session, urls);
    if (!covered || probed.has(covered.key)) continue;
    probed.add(covered.key);
    const stopped = stoppedBefore(replay, a.after);
    const probe = stopped ? { reproduced: false, confirmation: stopped } : await probeClick(run, session, a.after, covered.target).catch((error) => ({ reproduced: false, confirmation: `Reproduction failed: ${(error as Error).message}` }));
    drafts.push({
      source: 'mechanical',
      title: `${covered.element} is covered by ${covered.cover} on ${covered.path} at ${covered.width}px wide`,
      kind: 'bug',
      severity: 'high',
      expected: `${covered.element} can be clicked on ${covered.path} at ${covered.width}px wide; nothing covers it`,
      actual: `clicking it after step ${a.after} failed: ${a.error}`,
      steps: a.after ? [a.after] : [],
      at: a.after,
      then: `click ${covered.element}`,
      ...probe,
      evidence: evidence(replay, a.after, { message: covered.element }),
    });
  }

  const slowSeen = new Map<string, { steps: number[]; paths: Set<string>; ms: number }>();
  for (const a of session.attempts) {
    if (!a.ok || a.step === undefined || a.settleMs < SLOW_STEP_MS) continue;
    const path = bare(urls[a.step]);
    const group = slowSeen.get(pattern(path)) ?? slowSeen.set(pattern(path), { steps: [], paths: new Set(), ms: 0 }).get(pattern(path))!;
    group.steps.push(a.step);
    group.paths.add(path);
    group.ms = Math.max(group.ms, a.settleMs);
  }
  for (const [key, { steps, paths, ms }] of slowSeen) {
    const path = paths.size > 1 ? key : [...paths][0];
    const step = steps[0];
    const again = replay.steps.find((s) => pattern(bare(s.url)) === key && s.settleMs >= SLOW_STEP_MS);
    drafts.push({
      source: 'mechanical',
      title: `${path} takes ${seconds(ms)} to load`,
      kind: 'perf',
      severity: 'medium',
      expected: `${path} is ready within ${seconds(SLOW_STEP_MS)}`,
      actual: `slow at ${steps.length === 1 ? `step ${step} (${describeStep(session.steps[step - 1])})` : `steps ${steps.join(', ')} (${[...paths].join(', ')})`}, up to ${seconds(ms)} to settle`,
      steps,
      at: step,
      reproduced: Boolean(again),
      confirmation: again
        ? `slow again on a replay ${session.seedCommand ? 'after seeding' : 'without resetting data'} with no model (${seconds(again.settleMs)})`
        : (stoppedBefore(replay, step) ?? `not slow on a replay ${session.seedCommand ? 'after seeding' : 'without resetting data'} with no model`),
      evidence: evidence(replay, step, {}),
    });
  }

  const merged = mergeExplained(drafts, urls);
  merged.sort((a, b) => a.at - b.at || (a.source === b.source ? 0 : a.source === 'model' ? -1 : 1));
  const findings = merged.map(({ seen, ...d }, i): Finding => {
    const id = `F${i + 1}`;
    return { id, ...d, slug: slugify(d.title) || `finding-${id.toLowerCase()}`, story: draftStory(d, session, urls) };
  });
  return {
    findings,
    painPoints: painPoints(session, findings, urls),
    noted: [...noted.values()],
    urls,
    replay: replay.stopped ? { ms: replay.ms, ran: replay.steps.length, stopped: replay.stopped } : { ms: replay.ms, ran: replay.steps.length },
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function lastSessions(n: number): string {
  return n === 1 ? 'the last session' : `the last ${n} sessions`;
}


function outcomeText(session: ExploreSession): string {
  switch (session.outcome) {
    case 'done':
      return 'the model called done';
    case 'steps':
      return 'the action budget was spent';
    case 'minutes':
      return 'the time budget was spent';
    case 'unfinished':
      return 'the model stopped without calling done';
  }
}

function findingSection(f: Finding, session: ExploreSession, urls: string[]): string[] {
  const out = [`## ${f.id}: ${f.title}`, ''];
  out.push(`${f.kind}, ${f.severity}, ${f.source === 'model' ? 'reported by the model' : 'noticed by the harness'}; ${f.reproduced ? 'reproduced' : 'not reproduced'}: ${f.confirmation}.`, '');
  out.push(`- Expected: ${f.expected}`, `- Actual: ${f.actual}`);
  if (f.checks?.length) out.push(`- ${f.checks.length > 1 ? 'Checks that show' : 'Check that shows'} it: ${f.checks.map((c) => `\`${describeFindingCheck(c)}\``).join(' and ')}`);
  if (f.weak) out.push(`- Weak evidence: ${f.weak}.`);
  for (const m of f.merged ?? []) out.push(`- Explains the harness finding: ${m.title} (${m.reproduced ? 'reproduced' : 'not reproduced'}: ${m.confirmation})`);
  for (const issue of f.issues ?? []) out.push(`- Issue: \`${describeIssue(issue)}\``);
  out.push('');
  if (f.evidence.snapshot.length) {
    out.push(`The page${f.evidence.url ? ` (${f.evidence.url})` : ''} ${f.at ? `after step ${f.at}` : 'on opening'}, on replay:`, '', '```', ...f.evidence.snapshot, '```', '');
  }
  if (f.evidence.issues.length) out.push(`${f.issues ? 'Other issues' : 'Issues'} at that step:`, '', ...f.evidence.issues.map((i) => `- ${i}`), '');
  out.push(`Steps to reproduce, ${session.seedCommand ? 'after seeding' : 'using existing data'} at ${session.start} (${session.viewport.join('x')}):`, '');
  if (!f.at) out.push('- open the page; nothing else');
  for (let n = 1; n <= f.at; n++) out.push(`${n}. ${describeStep(session.steps[n - 1])} -> ${urls[n] ?? '?'}`);
  if (f.then) out.push(`${f.at + 1}. ${f.then}: fails`);
  out.push('', 'Draft story (copy into your stories if you want regression coverage):', '', '````md', f.story.trimEnd(), '````', '');
  return out;
}

// Strong evidence first: a weak finding may be real, but its check does not show it.
function reproducedFirst(findings: Finding[]): Finding[] {
  return [...findings.filter((f) => f.reproduced && !f.weak), ...findings.filter((f) => f.reproduced && f.weak)];
}

function reproducedText(reproduced: Finding[]): string {
  const weak = reproduced.filter((f) => f.weak).length;
  return `${plural(reproduced.length, 'reproduced finding')}${weak ? ` (${weak} on weak evidence)` : ''}`;
}

function evidenceKind(f: Finding): string {
  if (f.source === 'mechanical') return f.merged?.length ? `harness, ${f.merged.length + 1} issues` : 'harness';
  const check = f.weak ? 'weak check' : 'check';
  return f.merged?.length ? `${check} + harness` : check;
}

export function findingsMarkdown(session: ExploreSession, built: Built): string {
  const reproduced = reproducedFirst(built.findings);
  const unreproduced = built.findings.filter((f) => !f.reproduced);
  const s = session.stats;
  const out = [`# pt explore: ${reproducedText(reproduced)}, ${unreproduced.length} unreproduced`, ''];
  out.push(`App ${session.app} (${session.seedCommand ? 'seeded before each replay' : 'no seed; existing data'}). Model ${session.model}${s.responses !== undefined ? `, ${plural(s.responses, 'response')}` : ''}, ${plural(s.turns, 'turn')}. ${seconds(s.ms)} in all, ${seconds(s.modelMs)} with the model.`);
  out.push(`${plural(s.actions, 'step')}${s.failedActions ? ` and ${plural(s.failedActions, 'failed action')}` : ''} of a ${session.budget.steps}-action, ${session.budget.minutes}-minute budget; ended because ${outcomeText(session)}.`);
  if (session.goal) out.push(`Goal: ${session.goal}`);
  out.push(`Random seed ${session.seed}: ${session.flavour}${session.earlier.length ? `, told what ${lastSessions(session.earlier.length)} with these settings found` : ''}.`);
  if (session.summary) out.push('', `The model's summary: ${session.summary}`);
  if (session.error) out.push('', `Error: ${session.error}`);
  out.push(
    '',
    `Every finding was checked by replaying the session's steps ${session.seedCommand ? 'after seeding' : 'without resetting data'} with no model (${seconds(built.replay.ms)}${built.replay.stopped ? `; the replay stopped at step ${built.replay.stopped.step}: ${built.replay.stopped.error}` : ''}). Reproduction confirms the observed condition, not the expected product behaviour. All findings are saved.`,
    '',
  );
  if (reproduced.length) {
    out.push('| Id | Kind | Severity | Finding | Evidence | Step |', '|---|---|---|---|---|---|');
    for (const f of reproduced) out.push(`| ${f.id} | ${f.kind} | ${f.severity} | ${f.title.replaceAll('|', '\\|')} | ${evidenceKind(f)} | ${f.at} |`);

  } else out.push('No reproduced findings.', '');
  for (const f of reproduced) out.push(...findingSection(f, session, built.urls));
  if (unreproduced.length) {
    out.push('## Not reproduced', '', 'Reported during the session but not reproduced by the replay with no model:', '');
    for (const f of unreproduced) out.push(...findingSection(f, session, built.urls));
    out.push('');
  }
  if (built.painPoints.length) {
    out.push('## Pain points', '', 'Where the session lost time, costliest first (the time includes the model responses that followed).', '');
    out.push('| Cost | Actions | Pain point | Steps |', '|---|---|---|---|');
    for (const p of built.painPoints.slice(0, PAIN_POINTS_SHOWN)) out.push(`| ${seconds(p.ms)} | ${p.actions} | ${p.title.replaceAll('|', '\\|')} | ${p.steps.join(', ')} |`);
    if (built.painPoints.length > PAIN_POINTS_SHOWN) out.push('', `${built.painPoints.length - PAIN_POINTS_SHOWN} more in findings.json.`);
    out.push('');
  }
  if (built.noted.length) out.push('## Also noticed', '', 'Requests the app answered with a 4xx, which the session provoked with invalid input; not counted as findings:', '', ...built.noted.map((i) => `- ${describeIssue(i)}`), '');
  out.push('## Session steps', '', `Start at ${session.start} (${session.viewport.join('x')}) -> ${built.urls[0]}`);
  session.steps.forEach((step, i) => out.push(`${i + 1}. ${describeStep(step)} -> ${built.urls[i + 1]}`));
  out.push('', `Trajectory: ${displayPath(join(session.runDir, 'trajectory.jsonl'))}`);
  return `${out.join('\n')}\n`;
}

export function writeFindings(project: Project, session: ExploreSession, built: Built): { markdown: string; json: string; savedFindings: string } {
  const markdown = join(session.runDir, 'findings.md');
  const json = join(session.runDir, 'findings.json');
  const { runDir, model, app, seedCommand, seedCwd, goal, budget, seed, flavour, earlier, outcome, summary, error, stats, start, viewport } = session;
  const report = {
    kind: 'explore',
    runDir,
    model,
    app,
    seedCommand,
    seedCwd,
    goal,
    budget,
    seed,
    flavour,
    earlier,
    outcome,
    summary,
    error,
    stats,
    start,
    viewport,
    steps: session.steps.map((step, i) => ({ n: i + 1, step, url: built.urls[i + 1] })),
    findings: built.findings,
    painPoints: built.painPoints,
    noted: built.noted,
    replay: built.replay,
  };
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  const md = findingsMarkdown(session, built);
  writeFileSync(markdown, md);
  const savedFindings = join(project.dir, 'findings', basename(session.runDir));
  mkdirSync(savedFindings, { recursive: true });
  writeFileSync(join(savedFindings, 'findings.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  writeFileSync(join(savedFindings, 'findings.md'), md, { flag: 'wx' });
  return { markdown, json, savedFindings };
}

export function exploreSummary(session: ExploreSession, built: Built, markdown: string): string[] {
  const s = session.stats;
  const reproduced = reproducedFirst(built.findings);
  const unreproduced = built.findings.filter((f) => !f.reproduced);
  const out = [
    `explored ${plural(s.actions, 'step')}${s.failedActions ? ` (+${s.failedActions} failed)` : ''} in ${seconds(s.ms)}${s.responses !== undefined ? `, ${plural(s.responses, 'model response')}` : ''}; ended because ${outcomeText(session)}`,
    `${reproducedText(reproduced)}, ${unreproduced.length} unreproduced, ${plural(built.painPoints.length, 'pain point')}`,
  ];
  const width = Math.max(0, ...reproduced.map((f) => f.id.length));
  for (const f of reproduced) out.push(`  ${f.id.padEnd(width)} ${f.kind.padEnd(4)} ${f.severity.padEnd(6)} ${f.title} (step ${f.at}; ${evidenceKind(f)})`);
  if (unreproduced.length) out.push(`  unreproduced: ${unreproduced.map((f) => `${f.id} ${f.title}`).join('; ')}`);
  out.push(`findings ${displayPath(markdown)}`);

  return out;
}
