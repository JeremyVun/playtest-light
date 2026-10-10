import { ActorContext, contextTools, CONTEXT_INSTRUCTIONS } from './context.ts';
import { resizePage } from '../browser/index.ts';
import { Evidence, captureResize } from './evidence.ts';
import { newRunDir, releaseRun } from '../env/runs.ts';
import { openModel } from '../model/index.ts';
import { listStories } from '../project.ts';
import type { Check, Issue, ModelThread, Page, Project, RecordedAction, Snapshot, Story, ToolHandler, ToolSpec } from '../types.ts';
import { Actor, actTool, waitTool, type TrajectoryEvent } from './actor.ts';
import { earlierSection, earlierSessions, type Earlier } from './explore-history.ts';
import { buildFindings, describeFindingChecks, describeStep, evaluateFindingChecks, lastSessions, parseFindingCheck, SLOW_NOTE_MS, writeFindings, type Built } from './findings.ts';
import { describeAction, seconds } from './format.ts';
import { openRun, openStory, type Run } from './session.ts';

export const DEFAULT_EXPLORE_STEPS = 60;
export const NARROW_WIDTH = 420;
const STORY_PROSE_CHARS = 1500;

export type ExploreStep = RecordedAction | { type: 'resize'; width: number };
export type FindingKind = 'bug' | 'ux' | 'a11y' | 'perf' | 'copy';
export type Severity = 'high' | 'medium' | 'low';
export type FindingCheck = Check | { type: 'no-text'; value: string };

// One action the session tried, failed ones included.
export type Attempt = {
  // The session step it became; failed actions have none and follow step `after`.
  step?: number;
  after: number;
  action: string;
  ok: boolean;
  error?: string;
  unmet?: string;
  settleMs: number;
  // What the session spent on it: running it, plus the model response that followed when it ended a call.
  ms: number;
  issues: Issue[];
};

export type Report = {
  title: string;
  kind: FindingKind;
  severity: Severity;
  expected: string;
  actual: string;
  steps: number[];
  checks: FindingCheck[];
  task?: string;
  // The step the check is evaluated after on replay (0: on opening).
  at: number;
  heldWhenReported: boolean;
};

export type Outcome = 'done' | 'steps' | 'unfinished';

export type ExploreSession = {
  runDir: string;
  model: string;
  app: string;
  seedCommand?: string;
  seedCwd?: string;
  goal?: string;
  budget: { steps: number };
  // Picks the flavour; the earlier sessions the model was told about, newest first.
  seed: number;
  flavour: string;
  earlier: string[];
  start: string;
  viewport: [number, number];
  steps: ExploreStep[];
  // Page path after each step as the session saw it, where known (index = step - 1).
  stepUrls: (string | undefined)[];
  attempts: Attempt[];
  startIssues: Issue[];
  reports: Report[];
  outcome: Outcome;
  summary?: string;
  error?: string;
  stats: { context?: ActorContext['stats']; ms: number; modelMs: number; waitMs?: number; responses?: number; turns: number; toolCalls: number; actions: number; failedActions: number };
};

export type ExploreOptions = {
  goal?: string;
  steps?: number;
  start?: string;
  // Default: the number of earlier sessions with the same env and goal, so each run starts differently.
  seed?: number;
  // Ignore earlier sessions: seed 0 unless given, and no list of what they found.
  fresh?: boolean;
  progress?: (line: string) => void;
  video?: boolean;
};

const KINDS: FindingKind[] = ['bug', 'ux', 'a11y', 'perf', 'copy'];
const SEVERITIES: Severity[] = ['high', 'medium', 'low'];

const findingCheckSchema = {
  type: 'object',
  description:
    'A deterministic check. text / no-text: the page does / does not show `value`. url: the URL contains `value`. element / absent: an element with `role` and `name` is / is not on the page. value: the field with `role` and `name` has value `value`.',
  properties: {
    type: { type: 'string', enum: ['text', 'no-text', 'url', 'element', 'absent', 'value'] },
    value: { type: 'string' },
    role: { type: 'string' },
    name: { type: 'string' },
  },
  required: ['type'],
};

export const reportFindingTool: ToolSpec = {
  name: 'report_finding',
  description:
    'Report one problem: something broken, confusing, slow or badly worded. `checks` are evaluated now and the report is refused if one is false, unless `steps` names only earlier steps where they held. Reporting again with the same title replaces the earlier report.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'The problem in a few words, e.g. "Saved task does not appear in the list".' },
      kind: { type: 'string', enum: KINDS },
      severity: { type: 'string', enum: SEVERITIES, description: 'high: a task cannot be done or data is wrong; medium: it can be done with trouble; low: cosmetic.' },
      expected: { type: 'string', description: 'The correct behaviour, as a user would state it. It becomes the acceptance test for the fix.' },
      actual: { type: 'string', description: 'What happened instead.' },
      steps: { type: 'array', items: { type: 'integer' }, description: 'The step numbers (printed after each act) that lead to the problem.' },
      checks: {
        type: 'array',
        items: findingCheckSchema,
        description: 'One or more checks, all true now, that together show the problem. At least one should have been false before the step you cite: a missing item was also missing before you added it, so pair it with what shows the step took effect.',
      },
      task: { type: 'string', description: 'The user task that hits this, as an instruction a tester could follow, with the exact values you used (account, names typed).' },
    },
    required: ['title', 'kind', 'severity', 'expected', 'actual', 'steps', 'checks', 'task'],
  },
};

export const setWidthTool: ToolSpec = {
  name: 'set_width',
  description: 'Resize the browser window, e.g. { width: 420 } for a phone. Counts as one action. The next decision shows the page.',
  parameters: { type: 'object', properties: { width: { type: 'integer', description: 'Window width in pixels, 320 to 2560.' } }, required: ['width'] },
};

export const exploreDoneTool: ToolSpec = {
  name: 'done',
  description: 'End the session once the budget is spent or the app is covered, after reporting every problem.',
  parameters: { type: 'object', properties: { summary: { type: 'string', description: 'Two or three sentences: what you covered and the worst problems.' } }, required: ['summary'] },
};

const EXPLORER_TOOLS = [actTool, waitTool, reportFindingTool, setWidthTool, exploreDoneTool];

const CHECK_EFFECT = 'Check that each change really took effect, first straight away (give the action that saves an `expect` that the new or changed item is shown) and then after a reload.';
const EDGE_CASES =
  'submit forms empty; very long input (200 or more characters); invalid values (wrong formats, negative or huge numbers, a name that already exists); submitting twice; back and reload in the middle of a task; an address that does not exist; error paths (a wrong password, a rejected payment, cancelling halfway)';

// Where a session starts, rotated by the seed so that repeated explores cover different ground.
export const FLAVOURS: { name: string; plan: (wide: number) => string }[] = [
  {
    name: 'main tasks first',
    plan: () => `1. Main tasks first. Work out what the app is for and do its main tasks the way a real user would, start to finish: create things, change them, complete them, find them again. ${CHECK_EFFECT}
2. Then edge cases on the forms and pages you found: ${EDGE_CASES}; every link in the navigation.
3. With about a third of the budget left, call tools.set_width({ width: ${NARROW_WIDTH} }) and do the main tasks again as a phone user.`,
  },
  {
    name: 'beyond the stories',
    plan: () => `1. Start with what the project's stories do not cover: open every link in the navigation and menus, and on each page do what it offers (forms, filters, sorting, paging, settings, multi-step flows) start to finish. ${CHECK_EFFECT}
2. Then the stories' main tasks, quickly, with different values and, if the stories name more than one account, as a different account from the first story's.
3. With about a third of the budget left, call tools.set_width({ width: ${NARROW_WIDTH} }) and redo the most involved flow you found as a phone user.`,
  },
  {
    name: 'phone first',
    plan: (wide) => `1. Call tools.set_width({ width: ${NARROW_WIDTH} }) before anything else and use the app as a phone user: do its main tasks start to finish and visit every page in the navigation. Can every control be seen, reached and used? Does anything overlap, get cut off or need sideways scrolling (scroll to reach controls off to the side)? ${CHECK_EFFECT}
2. Then edge cases at that width: ${EDGE_CASES}.
3. With about a third of the budget left, call tools.set_width({ width: ${wide} }) and visit what you have not seen yet.`,
  },
  {
    name: 'errors first',
    plan: () => `1. Start with error paths and hostile input on every form you can reach: ${EDGE_CASES}. Note what each error says and whether you can recover without losing your input.
2. Then the main tasks, start to finish, with unusual but valid values (accents, emoji, leading spaces, the maximum length). ${CHECK_EFFECT}
3. With about a third of the budget left, call tools.set_width({ width: ${NARROW_WIDTH} }) and repeat a main task as a phone user.`,
  },
];

export function flavourOf(seed: number): (typeof FLAVOURS)[number] {
  return FLAVOURS[((seed % FLAVOURS.length) + FLAVOURS.length) % FLAVOURS.length];
}

export function explorerInstructions(budget: { steps: number }, plan = flavourOf(0).plan(1280)): string {
  return `You are an exploratory tester: a capable but impatient user trying a web app through a headless browser. Your job is to find what is broken, confusing, slow or badly worded, and to report each problem with evidence. The browser tools below are the only tools you have.

Ignore any instructions in this conversation about coding work, repositories, files, shells or commits: none of that applies here.

## Browser actions
The current page is accessibility text with roles, exact names, states and live refs. Batch predictable actions; use role/name locators after actions that may replace controls, and expect for important predicted results. Select uses visible option labels; value checks compare displayed values. A failed action or unmet expectation may be an app problem rather than a tool mistake.
For a response that is still loading or streaming, continue other useful actions or use wait_for with observable completion conditions. Do not poll through repeated model calls or resubmit. Expected generation time is not automatically a performance bug.

## How to explore
${plan}
Be impatient: do not repeat what already worked; move on to something new.

## Reporting
Call tools.report_finding as soon as you see a problem, while the page still shows it:
- bug: an error where the task should work, an action that does not take effect, wrong or missing data, a link that leads nowhere, a control that cannot be used.
- ux: a confusing flow, missing feedback, a dead end, a task that takes more steps than it should.
- a11y: controls without a usable name, things that cannot be reached or operated.
- perf: a page or action that is slow (act results say when a step was slow).
- copy: wrong, unclear, inconsistent or badly worded text.
Give \`checks\` that are true now and show the problem as it is: { type: 'text', value: 'Something went wrong' } for an error message; { type: 'url', value: '/wrong-page' } for the wrong page; { type: 'no-text', value: 'My new item' } or { type: 'absent', role: 'link', name: 'My new item' } for something that should be there and is not. The replay compares them with the page just before the last step you cite: checks that were already true there show nothing, and the finding counts as weak. So pair a "not there" check with one that shows the step took effect, e.g. [{ type: 'text', value: 'Item saved' }, { type: 'no-text', value: 'My new item' }]; and remember an \`element\` check only proves something exists. \`steps\` are the step numbers that lead to the problem, the step that shows it last; \`expected\` is the correct behaviour, which becomes the acceptance test for the fix.
The harness records console errors, failed requests, slow pages and layout problems itself (listed under "new problems noticed"); report those only when you can see what they break. Do not report validation messages that correctly reject invalid input.

## Budget
You have ${budget.steps} actions. Spend them. When the budget is spent or you have covered the app, report anything outstanding, then call done with a short summary.`;
}

function storiesSection(stories: Story[]): string {
  if (!stories.length) return '';
  let used = 0;
  const parts: string[] = [];
  for (const s of stories) {
    const part = `### ${s.title} (starts at ${s.start})\n${s.prose}`;
    if (used + part.length > STORY_PROSE_CHARS && parts.length) break;
    parts.push(part);
    used += part.length;
  }
  return `## What the project's stories say users do
Use these for accounts and the main tasks; do not just repeat them.

${parts.join('\n\n')}

`;
}

export function exploreMessage(opts: { goal?: string; stories: Story[]; earlier?: Earlier; url: string }): string {
  const focus = opts.goal ? `Focus on: ${opts.goal}` : 'No particular focus: cover the whole app.';
  return `# Explore this app

${focus}

${storiesSection(opts.stories)}${opts.earlier ? earlierSection(opts.earlier) : ''}Initial URL: ${opts.url}

Start exploring.`;
}

// The explorer's tools over one page. act goes through Actor; budgets, step numbers, reports,
// resizing and done are handled here.
class Explorer {
  readonly steps: ExploreStep[] = [];
  readonly stepUrls: (string | undefined)[] = [];
  readonly attempts: Attempt[] = [];
  readonly reports: Report[] = [];
  finished: { summary: string } | undefined;
  ended = false;
  calls = 0;
  #actor: Actor;
  #page: Page;
  #viewport: [number, number];
  #budget: { steps: number };
  #mark = 0;
  #lastActEnd: number | undefined;
  // The step count when the actor last showed the model a snapshot.
  #seenAt = 0;
  #log: (event: TrajectoryEvent) => void;

  constructor(page: Page, viewport: [number, number], budget: { steps: number }, log: (event: TrajectoryEvent) => void) {
    this.#page = page;
    this.#viewport = viewport;
    this.#budget = budget;
    this.#log = log;
    this.#actor = new Actor(page, (event) => {
      log(event);
      if (event.event === 'action') this.#attempted(event);
    });
  }

  observe(snapshot: Snapshot): void {
    this.#actor.observe(snapshot);
    this.#seenAt = this.steps.length;
  }

  get used(): number {
    return this.attempts.length;
  }

  get waitMs(): number { return this.#actor.waitMs; }

  async completeWait(): Promise<string | undefined> {
    const wait = this.#actor.takeWait();
    if (!wait) return;
    this.#lastActEnd = undefined;
    return this.#act(wait, true);
  }

  spent(): 'steps' | undefined {
    if (this.used >= this.#budget.steps) return 'steps';
    return undefined;
  }

  handle: ToolHandler = (name, args) => {
    const now = performance.now();
    if (this.#lastActEnd !== undefined && this.attempts.length) this.attempts.at(-1)!.ms += Math.round(now - this.#lastActEnd);
    this.#lastActEnd = undefined;
    this.calls++;
    return this.#dispatch(name, args);
  };

  async #dispatch(name: string, args: unknown): Promise<string> {
    if (this.ended || this.finished) return 'The session has ended. Reply with one short line and stop.';
    if (name === 'act') return this.#act(args);
    if (name === 'wait_for') return this.spent() ? this.#spentMessage() : this.#actor.handle(name, args);
    if (name === 'set_width') return this.#setWidth(args);
    if (name === 'report_finding') return this.#report(args);
    if (name === 'done') return this.#done(args);
    this.#log({ event: 'call', tool: name, args });
    return `Unknown tool ${name}; the tools are act, wait_for, report_finding, set_width and done.`;
  }

  #attempted(event: TrajectoryEvent): void {
    const now = performance.now();
    const attempt: Attempt = {
      after: this.steps.length,
      action: describeAction(event.locator && (event.action as { target?: unknown }).target ? ({ ...(event.action as RecordedAction), target: event.locator } as RecordedAction) : (event.action as RecordedAction)),
      ok: event.ok === true,
      settleMs: Number(event.settleMs) || 0,
      ms: Math.round(now - this.#mark),
      issues: (event.issues as Issue[] | undefined) ?? [],
    };
    if (typeof event.error === 'string') attempt.error = event.error;
    this.#mark = now;
    this.attempts.push(attempt);
  }

  #budgetLine(): string {
    return `left: ${Math.max(0, this.#budget.steps - this.used)} actions`;
  }

  #spentMessage(): string {
    return `Nothing ran: the budget is spent (all ${this.#budget.steps} actions are used). Report anything you have not reported yet with report_finding, then call done.`;
  }

  async #act(args: unknown, waiting = false): Promise<string> {
    const spent = this.spent();
    if (spent) {
      this.#log({ event: 'call', tool: 'act', args, refused: spent });
      return this.#spentMessage();
    }
    const raw = (args as { actions?: unknown })?.actions;
    const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : undefined;
    const left = this.#budget.steps - this.used;
    const cut = list && list.length > left;
    const stepsBefore = this.steps.length;
    const attemptsBefore = this.attempts.length;
    const kept = this.#actor.actions.length;
    this.#mark = performance.now();
    const input = cut ? { actions: list.slice(0, left) } : args;
    const text = waiting ? await this.#actor.act(input) : await this.#actor.handle('act', input);
    const ran = this.attempts.slice(attemptsBefore);
    const okRan = ran.filter((a) => a.ok);
    this.steps.push(...this.#actor.actions.slice(kept));
    this.#seenAt = this.steps.length;
    this.stepUrls.push(...this.#actor.actions.slice(kept).map(() => undefined));
    let step = stepsBefore;
    for (const a of ran) {
      a.after = step;
      if (a.ok) a.step = ++step;
    }
    const page = [...text.matchAll(/^page (\S+) title /gm)].at(-1)?.[1];
    if (page && this.steps.length > stepsBefore) this.stepUrls[this.steps.length - 1] = page.split('?')[0];
    const unmet = /^stopped after \d+: expectation not met: (.*)$/m.exec(text)?.[1];
    if (unmet && ran.length) ran.at(-1)!.unmet = unmet;
    if (ran.length) this.#lastActEnd = performance.now();

    const lines = [text];
    if (cut) lines.push(`only the first ${left} actions were run: that spends the action budget`);
    for (const a of okRan) if (a.settleMs >= SLOW_NOTE_MS) lines.push(`slow: step ${a.step} took ${seconds(a.settleMs)} to load`);
    const first = stepsBefore + 1;
    const last = this.steps.length;
    lines.push(last >= first ? `steps ${first === last ? first : `${first}-${last}`} done (cite step numbers in report_finding)` : 'no step completed');
    lines.push(this.#budgetLine());
    return lines.join('\n');
  }

  async #setWidth(args: unknown): Promise<string> {
    this.#log({ event: 'call', tool: 'set_width', args });
    const spent = this.spent();
    if (spent) return this.#spentMessage();
    const width = Number((args as { width?: unknown })?.width);
    if (!Number.isInteger(width) || width < 320 || width > 2560) return 'set_width needs { width }: whole pixels from 320 to 2560.';
    const started = performance.now();
    this.#viewport = [width, this.#viewport[1]];
    await resizePage(this.#page, this.#viewport);
    await captureResize(this.#page, width, Math.round(performance.now() - started));
    this.steps.push({ type: 'resize', width });
    this.stepUrls.push(this.stepUrls.findLast((u) => u !== undefined));
    this.attempts.push({ step: this.steps.length, after: this.steps.length - 1, action: `resize to ${width}px`, ok: true, settleMs: 0, ms: Math.round(performance.now() - started), issues: [] });
    this.#lastActEnd = performance.now();
    this.#log({ event: 'resize', width, step: this.steps.length });
    const shown = await this.#actor.look();
    this.#seenAt = this.steps.length;
    return `step ${this.steps.length}: the window is now ${width}px wide.\n${shown}\n${this.#budgetLine()}`;
  }

  async #report(args: unknown): Promise<string> {
    const a = (args ?? {}) as Record<string, unknown>;
    const text = (k: string) => (typeof a[k] === 'string' ? (a[k] as string).trim() : '');
    const problems: string[] = [];
    const title = text('title');
    if (!title) problems.push('title is required');
    const kind = (KINDS.includes(a.kind as FindingKind) ? a.kind : 'bug') as FindingKind;
    const severity = (SEVERITIES.includes(a.severity as Severity) ? a.severity : 'medium') as Severity;
    const expected = text('expected');
    if (!expected) problems.push('expected (the correct behaviour) is required');
    const actual = text('actual');
    if (!actual) problems.push('actual (what happened) is required');
    const current = this.steps.length;
    const steps = (Array.isArray(a.steps) ? a.steps : [a.steps]).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= current);
    const raw = a.checks ?? a.check;
    const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    if (!list.length) problems.push('checks: give at least one check that shows the problem');
    const checks: FindingCheck[] = [];
    for (const [i, item] of list.entries()) {
      const c = parseFindingCheck(item);
      if (typeof c === 'string') problems.push(`check ${i + 1}: ${c}`);
      else checks.push(c);
    }
    if (problems.length) {
      this.#log({ event: 'report', args, refused: problems });
      return `report refused: ${problems.join('; ')}.`;
    }
    const result = await evaluateFindingChecks(this.#page, checks);
    let at = current;
    let gone = false;
    if (!result.ok) {
      const earlier = steps.filter((n) => n < current);
      gone = earlier.length < steps.length && this.#shownLast(checks);
      if (!gone && (!earlier.length || earlier.length < steps.length)) {
        this.#log({ event: 'report', args, refused: result.detail });
        return `report refused: ${describeFindingChecks(checks)} is false on the current page (${result.detail}). Give checks that are true now and show the problem, or, if the page has moved on, cite only the earlier steps after which they were true.`;
      }
      if (!gone) at = Math.max(...earlier);
    }
    const report: Report = { title, kind, severity, expected, actual, steps: [...new Set(steps)].sort((x, y) => x - y), checks, at, heldWhenReported: result.ok };
    const task = text('task');
    if (task) report.task = task;
    const same = this.reports.findIndex((r) => r.title.toLowerCase() === title.toLowerCase());
    if (same >= 0) this.reports[same] = report;
    else this.reports.push(report);
    this.#log({ event: 'report', report, replaces: same >= 0 ? same + 1 : undefined });
    const n = same >= 0 ? same + 1 : this.reports.length;
    const note = result.ok
      ? ''
      : gone
        ? ` Not all its checks hold any more, but they did when step ${at} ended (a message that has since gone), so they will be evaluated by replaying to step ${at}.`
        : ` Its checks are false on the current page, so they will be evaluated by replaying to step ${at}.`;
    const absence = same < 0 && checks.every((c) => c.type === 'absent' || c.type === 'no-text');
    const hint = absence
      ? ' Note: every check says something is not there, which may also have been true before the step you cite (an item is missing before you add it), and then the finding counts as weak. If the page shows that the step took effect (a confirmation message, a dialog that closed), report again with the same title and add that check.'
      : '';
    return `finding ${n} ${same >= 0 ? 'updated' : 'recorded'} at step ${at}: ${title}.${note}${hint} Keep exploring.`;
  }

  // A message that disappears on a timer is gone by the time the model reports it, so the
  // snapshot the last act showed the model counts too.
  #shownLast(checks: FindingCheck[]): boolean {
    const seen = this.#actor.seen;
    return Boolean(seen && this.#seenAt === this.steps.length && shownIn(seen.text, checks));
  }

  #done(args: unknown): string {
    const summary = typeof (args as { summary?: unknown })?.summary === 'string' ? (args as { summary: string }).summary : '';
    this.finished = { summary };
    this.#log({ event: 'done', summary });
    return 'Session finished. Reply with one short line and stop.';
  }
}

// Whether every check holds on a model-form snapshot, read from its lines (url and value checks cannot be).
export function shownIn(snapshot: string, checks: FindingCheck[]): boolean {
  const lines = snapshot.split('\n');
  const has = (needle: string) => lines.some((l) => l.includes(needle));
  return checks.every((c) => {
    if (c.type === 'text') return has(c.value);
    if (c.type === 'no-text') return !has(c.value);
    if (c.type === 'element') return has(`${c.locator.role} ${JSON.stringify(c.locator.name)}`);
    if (c.type === 'absent') return !has(`${c.locator.role} ${JSON.stringify(c.locator.name)}`);
    return false;
  });
}

export type ExploreResult = Built & { session: ExploreSession; markdown: string; json: string; savedFindings: string; view: string; video?: string; videoSkipped?: string };

export async function explore(project: Project, opts: ExploreOptions = {}): Promise<ExploreResult> {
  if (!project.config.url) throw new Error('No target URL; pass --url <url> or set url in playtest/config.json.');
  const started = performance.now();
  const runDir = newRunDir(project, 'explore', true);
  try {
    const evidence = new Evidence(runDir, true);
    const model = openModel(project.config.model);
    const budget = { steps: opts.steps ?? DEFAULT_EXPLORE_STEPS };
    const earlier = opts.fresh ? undefined : earlierSessions(project, opts.goal);
    const seed = opts.seed ?? earlier?.count ?? 0;
    const flavour = flavourOf(seed);
    const context = new ActorContext(runDir, exploreMessage({ goal: opts.goal, stories: listStories(project), earlier, url: opts.start ?? project.config.url }));
    const instructions = explorerInstructions(budget, flavour.plan(project.config.browser.viewport[0])) + CONTEXT_INSTRUCTIONS;
    const tools = contextTools(EXPLORER_TOOLS);
    context.header(instructions, tools);
    opts.progress?.(`random seed ${seed}: ${flavour.name}${earlier?.shown.length ? `; told what ${lastSessions(earlier.shown.length)} with these settings found` : ''}`);
    const threadStarting = model.startThread({ instructions, tools });
    threadStarting.catch(() => {});
    const run = await openRun(project).catch(async (error) => {
      await threadStarting.then((thread) => thread.close()).catch(() => {});
      throw error;
    });
    run.evidence = evidence;
    evidence.phase('Exploration');
    try {
      const plan = { seed, flavour: flavour.name, earlier };
      const session = await runSession(project, run, { ...opts, ...budget }, plan, runDir, threadStarting, { name: model.name }, context);
      const built = await buildFindings(run, session);
      session.stats.ms = Math.round(performance.now() - started);
      const files = writeFindings(project, session, built);
      const media = opts.video ? await evidence.video().catch((error) => ({ videoSkipped: (error as Error).message, video: undefined })) : {};
      const view = evidence.write({ title: 'Explore', url: run.url, status: session.error ? 'error' : session.outcome, summary: [session.summary ?? 'Exploration finished.', ...(session.error ? [session.error] : []), `All ${built.findings.length} findings saved to ${files.savedFindings}`], findings: built.findings, details: JSON.stringify({ ...session, replay: built.replay }, null, 2), links: [{ label: 'Findings JSON', href: 'findings.json' }, { label: 'Findings Markdown', href: 'findings.md' }, { label: 'Trajectory', href: 'trajectory.jsonl' }, { label: 'Model context', href: 'context.jsonl' }, { label: 'Model instructions', href: 'context-header.json' }, ...(media.video ? [{label: 'Video', href: 'video.mp4'}] : [])] });
      return { session, ...built, ...files, view, ...media };
    } catch (error) {
      evidence.write({ title: 'Explore', url: run.url, status: 'error', summary: [(error as Error).message] });
      throw error;
    } finally {
      await threadStarting.then((thread) => thread.close()).catch(() => {});
      await run.close();
    }
  } finally { releaseRun(runDir); }
}

async function runSession(
  project: Project,
  run: Run,
  opts: ExploreOptions & { steps: number },
  plan: { seed: number; flavour: string; earlier?: Earlier },
  runDir: string,
  threadStarting: Promise<ModelThread>,
  model: { name: string },
  context: ActorContext,
): Promise<ExploreSession> {
  const log = context.log;
  const progress = opts.progress ?? (() => {});
  const budget = { steps: opts.steps };
  const initial = new URL(run.url);
  const start = opts.start ?? initial.pathname + initial.search + initial.hash;
  const { page, opened, viewport } = await openStory(run, { start });
  const explorer = new Explorer(page, viewport, budget, log);
  const earlier = plan.earlier?.shown ?? [];
  log({ event: 'start', model: model.name, app: run.url, chrome: run.browser.version, budget, goal: opts.goal, seed: plan.seed, flavour: plan.flavour, earlier, startIssues: opened.issues });
  const session: ExploreSession = {
    runDir,
    model: model.name,
    app: run.url,
    seedCommand: project.config.seed,
    seedCwd: project.config.seed ? project.seedCwd : undefined,
    budget,
    seed: plan.seed,
    flavour: plan.flavour,
    earlier,
    start,
    viewport,
    steps: explorer.steps,
    stepUrls: explorer.stepUrls,
    attempts: explorer.attempts,
    startIssues: opened.issues,
    reports: explorer.reports,
    outcome: 'unfinished',
    stats: { ms: 0, modelMs: 0, turns: 0, toolCalls: 0, actions: 0, failedActions: 0 },
  };
  if (opts.goal) session.goal = opts.goal;
  const modelStarted = performance.now();
  try {
    const thread = await threadStarting;
    const onTool: ToolHandler = async (name, args) => {
      const before = explorer.steps.length;
      const reports = explorer.reports.length;
      const text = await explorer.handle(name, args);
      if (name === 'act' || name === 'set_width') {
        const added = explorer.steps.slice(before).map(describeStep);
        const stop = /^stopped .*$/m.exec(text)?.[0];
        progress(`  ${added.length ? `${before + 1}-${explorer.steps.length}: ${added.join(', ')}` : 'no step ran'}${stop ? ` (${stop})` : ''}`);
      } else if (name === 'report_finding') {
        const r = explorer.reports[reports];
        progress(r ? `  finding: [${r.kind} ${r.severity}] ${r.title} (step ${r.at})` : `  ${text.split('\n')[0]}`);
      }
      return text;
    };
    try {
      const maxDecisions = 4 * opts.steps + 20;
      let finalDecisions = 0, noCalls = 0;
      for (let turn = 0; turn < maxDecisions; turn++) {
        session.stats.turns++;
        const snapshot = await page.snapshot({ actor: true });
        explorer.observe(snapshot);
        const input = context.input(snapshot, { stepsLeft: Math.max(0, opts.steps - explorer.used), decisionsLeft: maxDecisions - turn });
        const decide = () => thread.decide(input, (name, args) => context.handle(name, args, onTool));
        const reply = await (run.evidence ? run.evidence.decision(decide) : decide()).catch(error => context.failure(error));
        context.result(reply);
        if (reply.tool === 'wait_for') progress('  waiting for the app');
        const waited = await explorer.completeWait();
        if (waited) {
          context.log({ event: 'result', tool: 'wait_for', text: waited.split('\npage ')[0] });
          progress(`  ${waited.split('\n')[0]}`);
        }
        noCalls = reply.tool ? 0 : noCalls + 1;
        if (explorer.spent()) finalDecisions++;
        if (explorer.finished || noCalls >= 3 || (explorer.spent() && (!reply.tool || finalDecisions >= 8))) break;
      }
    } catch (error) {
      session.error = (error as Error).message;
      log({ event: 'error', error: session.error });
    } finally {
      explorer.ended = true;
      await thread.close().catch(() => {});
    }
  } finally {
    await page.close();
  }
  session.stats.waitMs = explorer.waitMs;
  session.stats.modelMs = Math.max(0, Math.round(performance.now() - modelStarted) - explorer.waitMs);
  session.stats.toolCalls = explorer.calls;
  session.stats.actions = explorer.steps.length;
  session.stats.failedActions = explorer.attempts.filter((a) => !a.ok).length;
  session.stats.context = context.stats;
  if (!model.name.startsWith('script:')) session.stats.responses = context.stats.decisions;
  if (explorer.finished) {
    session.outcome = 'done';
    session.summary = explorer.finished.summary;
  } else session.outcome = explorer.spent() ?? 'unfinished';
  return session;
}
