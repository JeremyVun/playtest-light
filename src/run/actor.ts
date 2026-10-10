import type { Action, ActResult, Check, Issue, Locator, Page, RecordedAction, Target, ToolSpec } from '../types.ts';
import { describeAction, describeCheck, describeIssue, describeLocator } from './format.ts';

export const IRREVERSIBLE =
  /\b(delete|remove|pay|purchase|buy|confirm|submit|upgrade|downgrade|sign out|log ?out|send|publish|cancel (plan|subscription|account)|deactivate|revoke|destroy|erase|discard|transfer|place order)\b/i;
const IRREVERSIBLE_ROLES = new Set(['button', 'link', 'menuitem']);

export type PlannedAction = Action & { expect?: Check[] };

export type TrajectoryEvent = Record<string, unknown> & { event: string };

export type Finish = { kind: 'done'; summary: string; checks: Check[] } | { kind: 'give_up'; reason: string };

const locatorSchema = {
  role: { type: 'string', description: 'Role exactly as the snapshot shows it (button, link, textbox, searchbox, combobox, checkbox, heading...).' },
  name: { type: 'string', description: 'Accessible name exactly as the snapshot shows it, without quotes.' },
  nth: { type: 'integer', description: 'Only when several elements share role and name: 0-based index in snapshot order.' },
};

const checkSchema = {
  type: 'object',
  description:
    'A deterministic check. text: the page shows `value`. url: the URL contains `value`. element / absent: an element with `role` and `name` is / is not on the page. value: the field with `role` and `name` has value `value`.',
  properties: { type: { type: 'string', enum: ['text', 'url', 'element', 'absent', 'value'] }, value: { type: 'string' }, ...locatorSchema },
  required: ['type'],
};

const actionSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['click', 'fill', 'select', 'press', 'hover', 'navigate', 'back', 'scroll'] },
    target: {
      description: 'The element: a ref from the latest snapshot such as "e12", or { role, name, nth? } for an element that will be there by the time this action runs (for example on the next page).',
      anyOf: [{ type: 'string' }, { type: 'object', properties: locatorSchema, required: ['role', 'name'] }],
    },
    value: { type: 'string', description: 'fill: the text to type ("" clears the field).' },
    option: { type: 'string', description: 'select: the visible option label.' },
    key: { type: 'string', description: 'press: a key such as "Enter", "Escape", "Tab" or "Control+a".' },
    url: { type: 'string', description: 'navigate: a path such as "/projects".' },
    direction: { type: 'string', enum: ['up', 'down'], description: 'scroll: direction (default down).' },
    expect: { type: 'array', items: checkSchema, description: 'What must be true right after this action; the batch stops here if not.' },
  },
  required: ['type'],
};

export const actTool: ToolSpec = {
  name: 'act',
  description: [
    'Runs browser actions in order, with no model round trip between them.',
    'Stops at the first action that fails or whose `expect` is not met, and after a click on anything that looks irreversible (delete, pay, submit, confirm, upgrade, sign out...) that has no `expect`.',
    'The next decision shows executed actions, failures, issues and the current page.',
    'Call inspect to read omitted page content or earlier evidence.',
  ].join(' '),
  parameters: { type: 'object', properties: { actions: { type: 'array', items: actionSchema } }, required: ['actions'] },
};

export const doneTool: ToolSpec = {
  name: 'done',
  description:
    "Finish the story. `checks` must prove every item of the story's Done when list on the current page; they are evaluated now and done is refused (with the reasons) if any fails or there are none. They are replayed on every future run, so use stable facts (visible text, URL, elements), never times or counts that change.",
  parameters: {
    type: 'object',
    properties: { summary: { type: 'string', description: 'One or two sentences: what you did.' }, checks: { type: 'array', items: checkSchema } },
    required: ['summary', 'checks'],
  },
};

export const giveUpTool: ToolSpec = {
  name: 'give_up',
  description: 'End the session without finishing: the story cannot be completed (the app is broken, an element is missing, the story is wrong).',
  parameters: { type: 'object', properties: { reason: { type: 'string', description: 'What blocked you and where.' } }, required: ['reason'] },
};

export function recorderInstructions(): string {
  return `Complete the original user story through the browser, taking the shortest path that fulfills it.
Batch predictable actions in one act call. Use expect to stop the batch when an important predicted result does not hold. Irreversible-looking clicks without expect stop a batch.
The current page is accessibility text: roles, exact names, state and live element refs. Use refs only while their controls remain valid; use role/name locators for controls created or replaced by earlier actions. Select uses the visible option label, and value checks compare the displayed value.
When all criteria hold, call done with checks that prove them on the current page. Checks are evaluated and replayed; an executed click alone is not proof of success. If blocked, call give_up with the reason.`;
}

export function storyMessage(story: { title: string; prose: string; doneWhen: string[]; start: string }): string {
  const done = story.doneWhen.length ? story.doneWhen.map((d) => `- ${d}`).join('\n') : '- (none given: choose checks that prove the story above is complete)';
  return `# Story: ${story.title}

${story.prose}

## Done when
${done}

Initial path: ${story.start}

Complete the story, then call done with checks covering every Done when item.`;
}


type Snap = { url: string; title: string; text: string };

// The recorder's and explorer's browser tools over one page. Every successful action is kept,
// with its durable locator, in `actions`; the trajectory sees everything.
export class Actor {
  readonly page: Page;
  readonly actions: RecordedAction[] = [];
  readonly issues: Issue[] = [];
  finish: Finish | undefined;
  calls = 0;
  failedActions = 0;
  deadline = Infinity;
  #log: (event: TrajectoryEvent) => void;
  #seen: Snap | undefined;

  constructor(page: Page, log: (event: TrajectoryEvent) => void = () => {}) {
    this.page = page;
    this.#log = log;
  }

  get seen(): Snap | undefined {
    return this.#seen;
  }

  // The full snapshot, remembered as what the model has seen.
  async look(): Promise<string> {
    const snap = await this.page.snapshot({ actor: true });
    this.#seen = snap;
    return `page ${pathOf(snap.url)} title ${JSON.stringify(snap.title)}\n${snap.text}`;
  }

  handle = async (name: string, args: unknown): Promise<string> => {
    this.calls++;
    this.#log({ event: 'call', tool: name, args });
    if (this.finish) return `The session has ended (${this.finish.kind}). Reply with one short line and stop.`;
    try {
      if (name === 'act') return await this.act(args);
      if (name === 'done') return await this.done(args);
      if (name === 'give_up') return this.giveUp(args);
    } catch (error) {
      this.#log({ event: 'tool-error', tool: name, error: (error as Error).message });
      throw error;
    }
    return `Unknown tool ${name}; the tools are act, done and give_up.`;
  };

  async act(args: unknown): Promise<string> {
    const raw = (args as { actions?: unknown })?.actions;
    const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : undefined;
    if (!list) return 'act needs { actions: [...] }: a list of actions (it may be empty to get the full snapshot).';
    const planned: PlannedAction[] = [];
    for (const [i, item] of list.entries()) {
      const parsed = parseAction(item);
      if (typeof parsed === 'string') return `Nothing ran: action ${i + 1} is invalid: ${parsed}`;
      planned.push(parsed);
    }
    if (!planned.length) {
      const text = await this.look();
      this.#log({ event: 'act', actions: [], result: 'snapshot' });
      return text;
    }
    const lines: string[] = [];
    const issues: Issue[] = [];
    let stop = '';
    let ran = 0;
    for (const [i, plan] of planned.entries()) {
      if (performance.now() >= this.deadline) {
        stop = `stopped before ${i + 1}: time budget spent`;
        break;
      }
      const { expect, ...action } = plan;
      const result = await this.page.act(action as Action);
      ran = i + 1;
      issues.push(...result.issues);
      this.#log({ event: 'action', action, expect, ok: result.ok, error: result.error, locator: result.locator, settleMs: result.settleMs, issues: result.issues });
      const observed = await this.page.snapshot({ raw: true });
      this.#log({ event: 'observation', url: observed.url, title: observed.title, text: observed.rawText ?? observed.text });
      if (!result.ok) {
        this.failedActions++;
        lines.push(`${i + 1} FAIL ${describeAction(action as Action)}: ${result.error}`);
        stop = `stopped at ${i + 1}: ${describeAction(action as Action)} failed: ${result.error}`;
        break;
      }
      this.actions.push(recorded(action as Action, result));
      lines.push(`${i + 1} ok   ${describeAction(this.actions.at(-1)!)}`);
      const unmet: string[] = [];
      for (const check of expect ?? []) {
        const r = await this.page.check(check);
        if (!r.ok) unmet.push(`${describeCheck(check)} (${r.detail})`);
      }
      if (unmet.length) {
        stop = `stopped after ${i + 1}: expectation not met: ${unmet.join('; ')}`;
        break;
      }
      const target = result.locator;
      if (action.type === 'click' && !expect?.length && target && IRREVERSIBLE_ROLES.has(target.role) && IRREVERSIBLE.test(target.name) && i < planned.length - 1) {
        stop = `stopped after ${i + 1}: ${describeLocator(target)} looks irreversible and had no expect; check the page before going on`;
        break;
      }
    }
    if (ran < planned.length) lines.push(`not run: ${planned.slice(ran).map((_, k) => ran + k + 1).join(', ')}`);
    if (stop) lines.push(stop);
    if (issues.length) {
      this.issues.push(...issues);
      lines.push('new problems noticed:', ...issues.map((i) => `  ${describeIssue(i)}`));
    }
    lines.push(await this.#snapshotText());
    const text = lines.join('\n');
    this.#log({ event: 'act', count: planned.length, ran, stop, result: text });
    return text;
  }

  async #snapshotText(): Promise<string> {
    const before = this.#seen;
    const snap = await this.page.snapshot({ actor: true });
    this.#seen = snap;
    const head = `page ${pathOf(snap.url)} title ${JSON.stringify(snap.title)}`;
    if (before && before.text === snap.text) return `${head}\nsnapshot: unchanged`;
    return `${head}\nsnapshot:\n${snap.text}`;
  }

  async done(args: unknown): Promise<string> {
    const a = (args ?? {}) as { summary?: unknown; checks?: unknown };
    const summary = typeof a.summary === 'string' ? a.summary : '';
    const raw = Array.isArray(a.checks) ? a.checks : [];
    const checks: Check[] = [];
    for (const [i, item] of raw.entries()) {
      const parsed = parseCheck(item);
      if (typeof parsed === 'string') return `done refused: check ${i + 1} is invalid: ${parsed}`;
      checks.push(parsed);
    }
    if (!checks.length) return 'done refused: give at least one check that proves the story is complete (text, url, element, absent or value).';
    const lines: string[] = [];
    let failures = 0;
    for (const [i, check] of checks.entries()) {
      const r = await this.page.check(check);
      if (!r.ok) failures++;
      lines.push(`${i + 1} ${r.ok ? 'ok  ' : 'FAIL'} ${describeCheck(check)}${r.ok ? '' : `: ${r.detail}`}`);
    }
    this.#log({ event: 'done', summary, checks, ok: failures === 0, result: lines });
    if (failures) return `done refused: ${failures} of ${checks.length} checks failed on the current page:\n${lines.join('\n')}\nFinish the story or fix the checks, then call done again.`;
    this.finish = { kind: 'done', summary, checks };
    return `done accepted:\n${lines.join('\n')}\nReply with one short line and stop.`;
  }

  giveUp(args: unknown): string {
    const reason = typeof (args as { reason?: unknown })?.reason === 'string' ? (args as { reason: string }).reason : 'no reason given';
    this.finish = { kind: 'give_up', reason };
    this.#log({ event: 'give_up', reason });
    return 'Given up. Reply with one short line and stop.';
  }
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function recorded(action: Action, result: ActResult): RecordedAction {
  if ('target' in action && action.target && result.locator) return { ...action, target: result.locator } as RecordedAction;
  return action as RecordedAction;
}

export function parseTarget(raw: unknown): Target | string {
  if (typeof raw === 'string') {
    const ref = /^\[?(?:ref=)?(e\d+)\]?$/.exec(raw.trim());
    return ref ? { ref: ref[1] } : `target "${raw}" is not a ref like "e12"; use { role, name } for a locator`;
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (typeof o.ref === 'string') return parseTarget(o.ref);
    if (typeof o.role === 'string' && typeof o.name === 'string') {
      const l: Locator = { role: o.role, name: o.name };
      if (typeof o.nth === 'number' && o.nth > 0) l.nth = o.nth;
      return l;
    }
  }
  return 'target must be a ref such as "e12" or { role, name }';
}

function parseLocator(o: Record<string, unknown>): Locator | string {
  const src = o.locator && typeof o.locator === 'object' ? (o.locator as Record<string, unknown>) : o;
  if (typeof src.role !== 'string' || typeof src.name !== 'string') return 'needs role and name';
  const l: Locator = { role: src.role, name: src.name };
  if (typeof src.nth === 'number' && src.nth > 0) l.nth = src.nth;
  return l;
}

export function parseCheck(raw: unknown): Check | string {
  if (!raw || typeof raw !== 'object') return 'a check is an object with a type';
  const o = raw as Record<string, unknown>;
  const value = typeof o.value === 'string' ? o.value : typeof o.text === 'string' ? o.text : undefined;
  switch (o.type) {
    case 'text':
    case 'url':
      return value ? { type: o.type, value } : `${o.type} check needs a value`;
    case 'element':
    case 'absent': {
      const l = parseLocator(o);
      return typeof l === 'string' ? `${o.type} check ${l}` : { type: o.type, locator: l };
    }
    case 'value': {
      const l = parseLocator(o);
      if (typeof l === 'string') return `value check ${l}`;
      return value === undefined ? 'value check needs a value' : { type: 'value', locator: l, value };
    }
    default:
      return `unknown check type ${JSON.stringify(o.type)} (text, url, element, absent, value)`;
  }
}

export function parseAction(raw: unknown): PlannedAction | string {
  if (!raw || typeof raw !== 'object') return 'an action is an object with a type';
  const o = raw as Record<string, unknown>;
  let expect: Check[] | undefined;
  if (o.expect !== undefined) {
    const list = Array.isArray(o.expect) ? o.expect : [o.expect];
    expect = [];
    for (const item of list) {
      const c = parseCheck(item);
      if (typeof c === 'string') return `expect: ${c}`;
      expect.push(c);
    }
  }
  const withExpect = (a: Action): PlannedAction => (expect?.length ? { ...a, expect } : a);
  const target = o.target === undefined ? undefined : parseTarget(o.target);
  if (typeof target === 'string') return target;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  switch (o.type) {
    case 'click':
    case 'hover':
      return target ? withExpect({ type: o.type, target }) : `${o.type} needs a target`;
    case 'fill': {
      const value = str('value') ?? str('text');
      return target && value !== undefined ? withExpect({ type: 'fill', target, value }) : 'fill needs a target and a value';
    }
    case 'select': {
      const option = str('option') ?? str('value');
      return target && option !== undefined ? withExpect({ type: 'select', target, option }) : 'select needs a target and an option';
    }
    case 'press': {
      const key = str('key');
      if (!key) return 'press needs a key';
      return withExpect(target ? { type: 'press', key, target } : { type: 'press', key });
    }
    case 'navigate': {
      const url = str('url');
      return url ? withExpect({ type: 'navigate', url }) : 'navigate needs a url';
    }
    case 'back':
      return withExpect({ type: 'back' });
    case 'scroll': {
      const direction = o.direction === 'up' ? 'up' : 'down';
      return withExpect(target ? { type: 'scroll', direction, target } : { type: 'scroll', direction });
    }
    default:
      return `unknown action type ${JSON.stringify(o.type)} (click, fill, select, press, hover, navigate, back, scroll)`;
  }
}
