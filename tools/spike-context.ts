// actor-context phase 1: can Codex app-server give Sol a harness-built context per decision
// (stable prefix + append-only steps log + current page) with the prompt cache covering all but the
// newest page? Simulates a session of synthetic decisions per strategy and transport.
// Usage: node tools/spike-context.ts [--strategies revert,warm,fresh,fork,forklog,forktrail,accumulate]
//   [--transports http,ws] [--effort medium] [--decisions 20] [--gap 0] [--server spawn|daemon]
//   [--codex-home dir] [--tier priority] [--hold 1000] [--json out.json] [--sizes] [--capture]
// Strategies: revert: one persisted thread, each decision's turn cut at its call and reverted.
//   warm: revert plus a throwaway turn after each decision that ends at the log.
//   fresh: a new ephemeral thread per decision. fork: an ephemeral fork per decision from a
//   one-turn source thread. forklog: fork, with the steps log in the fork's base instructions and
//   only the page in the turn. forktrail: forklog with the log before the instructions' last
//   sections rather than after them. accumulate: v1's way, one turn whose act results carry the pages.
// --gap: milliseconds between decisions, standing in for the browser running the batch.
// --sizes: print the synthetic content's sizes (and write it to --json) without calling a model.
// With --server spawn (the default) on the http transport, per-item cache attribution and the
// timing of each response's phases are read from the private app-server's trace log.
// --codex-home: the CODEX_HOME of the app-server (spawned, or the daemon whose socket is there).
// --tier: the Responses service tier ("priority" is Codex's Fast mode).
// --hold: how long a fork's call is held before the turn is cut, so its usage arrives first.
// --capture: send the requests to a local stand-in provider instead and print what Codex puts in
//   the prompt (3 decisions per strategy).
// --startup N: N cold starts instead of sessions: open the server, start a thread, run one decision.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { threadStartParams } from '../src/model/codex.ts';
import { RpcClient, type Transport } from '../src/model/rpc.ts';
import { connectDaemon, controlSocketPath } from '../src/model/transport.ts';
import { actTool, doneTool, giveUpTool } from '../src/run/actor.ts';
import type { ToolSpec } from '../src/types.ts';

const { values } = parseArgs({
  options: {
    model: { type: 'string', default: 'gpt-6.1-sol' },
    effort: { type: 'string', default: 'medium' },
    strategies: { type: 'string', default: 'revert,warm,fresh,fork,forklog,accumulate' },
    transports: { type: 'string', default: 'http,ws' },
    decisions: { type: 'string', default: '20' },
    gap: { type: 'string', default: '0' },
    server: { type: 'string', default: 'spawn' },
    'codex-home': { type: 'string' },
    tier: { type: 'string' },
    hold: { type: 'string', default: '1000' },
    json: { type: 'string' },
    sizes: { type: 'boolean', default: false },
    capture: { type: 'boolean', default: false },
    startup: { type: 'string' },
  },
});
const MODEL = values.model!;
const EFFORT = values.effort!;
const DECISIONS = values.capture ? 3 : Number(values.decisions);
const GAP = Number(values.gap);
const HOLD = Number(values.hold);
const CODEX_HOME = values['codex-home'];
const MARKER_AT = 5;

type Strategy = 'revert' | 'warm' | 'fresh' | 'fork' | 'forklog' | 'forktrail' | 'accumulate';
type TransportName = 'http' | 'ws';

// Codex's built-in OpenAI provider talks to the Responses API over a WebSocket; this one is the
// same endpoint and sign-in over plain HTTP streaming.
const HTTP_PROVIDER = { name: 'OpenAI', wire_api: 'responses', requires_openai_auth: true, supports_websockets: false };

const now = () => performance.now();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const STORY = {
  title: 'A busy morning for the admin',
  prose: `Sign in as admin@example.test with password admin-pass-1. Search the projects for "Northern", filter to active projects, then clear the filter and the search. Go to the next page of projects and back again. Open "Northern Onboarding", add a high priority task called "Write launch email" and mark it complete. Then open Settings, change the display name to "Ada Lovelace", turn email notifications off and save. Finish back on the Projects page.`,
  doneWhen: ['the Projects page is open', 'the header shows the name "Ada Lovelace"'],
};

function instructions(nonce: string, oneTurn = false): string {
  const answer = oneTurn
    ? `## One call per program
This session runs as one long turn. Answer each page with a short JavaScript program that calls exactly one tool exactly once and prints its result: the result shows the outcome and the next page. For example:

\`\`\`js
text(await tools.act({ thought: 'Sign in with the story account', actions: [
  { type: 'fill', target: 'e1', value: 'someone@example.test' },
  { type: 'click', target: 'e3', expect: [{ type: 'url', value: '/home' }] },
]}));
\`\`\`

Keep going, one call per program, until you are told to stop. Do not write a message to the user until then.`
    : `## One call per turn
Answer every turn with a short JavaScript program that calls exactly one tool exactly once: tools.act, tools.done or tools.give_up. For example:

\`\`\`js
await tools.act({ thought: 'Sign in with the story account', actions: [
  { type: 'fill', target: 'e1', value: 'someone@example.test' },
  { type: 'click', target: 'e3', expect: [{ type: 'url', value: '/home' }] },
]});
\`\`\`

Do not print the result and do not wait for it: the harness runs the call, ends the turn and shows what happened in the next turn's steps log and page. A second tool call in the same program is refused. Do not write a message to the user; the call is your whole answer.`;
  return `You are a careful QA tester (instructions ${nonce}). You complete one user story in a web app through a headless browser. The browser tools below are the only tools you have.

Ignore any instructions in this conversation about coding work, repositories, files, shells or commits: none of that applies here. Your only job is the story.

## How a session works
The harness drives the browser and shows you the state one decision at a time. Every turn has two parts:
- "Steps so far": one line per action already run, numbered across the session, with its outcome and where the page went. It is the whole memory of the session: earlier pages are never shown again, so anything you need later must be in the log or in a note.
- "Current page": the page as it is now, as an accessibility snapshot.
Decide the next batch of actions from these two parts alone.

${answer}

## The snapshot
One accessibility node per line, indented by nesting: role, "name", then states such as value="...", checked, disabled, level=1. Actionable nodes carry a ref such as [e12]. A ref is valid on the page it came from; use it as the target ("e12"). For an element that will only exist after earlier actions in the same batch (the next page, an opened dialog), use a locator { role, name } instead, with the role and exact name the snapshot would show (roles are Chrome's: searchbox, combobox, link, button, textbox, checkbox, switch...).

The page is compacted to keep it short:
- The URL, the title and any open dialog or alert come first.
- Text that only repeats an element's name is dropped.
- After the first two rows of a list or grid with the same shape, the rest are one line per row with only their distinguishing text and refs, or, past a limit, a line such as "(+26 more rows like these; act with an empty batch on the list to expand)".
- The page is capped at 6,000 characters and 200 refs, filled from the top with the visible region first; a marker says where it was cut.

## The steps log
Each line is one action: its number, what ran and the outcome, then where the page went when it changed. Outcomes:
- ok: the action ran and its expectations held.
- failed: <reason>: the action could not run (element not found, disabled, covered).
- expectation unmet: <which>: the action ran but an expect you gave did not hold.
- no effect: the page's text did not change.
- repeated: the same action on an unchanged page; do something else.
- stopped: irreversible: the batch was cut after a click on something that looks irreversible and had no expect.
Consecutive actions of one batch share a line (for example "1-3: ..."). A line indented under a step is the note you gave with that call. The log ends with the budget left: steps and minutes. When the budget runs out the session ends without done.

## Work in batches
Each model response costs seconds, so put every action you can predict into one act call, including actions on pages you have not seen yet (target those by locator), and give each action that changes the page an \`expect\` (a URL, a heading or text that should appear). The harness runs them without you and stops at the first failure or unmet expectation, showing you the page there, so a wrong guess costs little. It also stops after a click on anything irreversible-looking (delete, pay, submit, confirm, upgrade, sign out) that has no expect.

Good batches: sign in (fill email, fill password, click sign in, expect the URL); open a record and start editing it; fill a whole form and save it with an expect on the saved text. Bad batches: one action at a time when the next page is predictable; a batch that keeps going after an action whose outcome you cannot predict (a search with unknown results, a dialog you have not seen).

## thought and note
\`thought\` is one line saying why this batch; it is logged for people and not shown back to you. \`note\` is optional, one line, and is kept in the steps log under this step: it is your memory between decisions. Use it for facts you will need later that the log does not carry: a created record's exact name, a value you read on an earlier page, something that looked wrong and that you want to check again.

## Finishing
Take the shortest path the story describes; do not explore beyond it. When every "Done when" item is true on the current page, call done with a short summary and checks that prove each item: text on the page, url, element present or absent, a field's value. The harness evaluates them at once and refuses done if any fails; the refusal shows in the next turn. If the story cannot be completed (the app is broken, an element is missing, the story is wrong), call give_up with the reason and where it happened.

## Worked examples
Steps so far ends with "4: click link \"Northern Onboarding\" → ok, url now /projects/prj-001" and the page shows the project with [e25] button "New task". The story wants a task added, so one batch opens the dialog and fills it, with the save expected to show the new row:
\`\`\`js
await tools.act({ thought: 'Add the task in one batch', note: 'task title: Write launch email', actions: [
  { type: 'click', target: 'e25', expect: [{ type: 'element', role: 'dialog', name: 'New task' }] },
  { type: 'fill', target: { role: 'textbox', name: 'Title' }, value: 'Write launch email' },
  { type: 'select', target: { role: 'combobox', name: 'Priority' }, option: 'High' },
  { type: 'click', target: { role: 'button', name: 'Save task' }, expect: [{ type: 'text', value: 'Write launch email' }] },
]});
\`\`\`

Steps so far ends with "7: click button \"Save task\" → expectation unmet: text \"Write launch email\" not on the page". Do not click Save again: the log shows it did not work. Look at the page: if the dialog is still open with an error, fix the field it names; if the dialog closed and the row is missing, reload the project page once to rule out a stale list, and if the row is still missing, the app is broken: call give_up with what you saw.

Steps so far ends with "12: click button \"Save settings\" → ok, toast \"Settings saved\"" and the header shows "Ada Lovelace". Every Done when item is true on this page or the next, so finish in one call after moving to the Projects page:
\`\`\`js
await tools.act({ thought: 'Back to Projects to finish', actions: [
  { type: 'click', target: { role: 'link', name: 'Projects' }, expect: [{ type: 'url', value: '/projects' }] },
]});
\`\`\`
and on the next turn call tools.done with checks for the URL and the header text.

## Common mistakes
- Acting on a ref from an earlier page: refs change when the page changes; use the current page's refs, or a locator for a page you have not seen.
- Repeating an action the log marks as "no effect" or "repeated": the page will not change; try something else or give up.
- Calling done before the page shows every Done when item: done is evaluated on the current page only.
- Batches that run past an irreversible action without an expect: the harness stops there anyway.
- Notes that repeat the log: keep notes for facts the log does not carry.

## About this app
It is a project tracker. Dates are frozen: "today" is the server time in the page footer, so due dates may show as overdue; that is expected. Seeded data is reset before every session, so records from earlier sessions are gone. Do not change or delete records the story does not mention. Notifications appear briefly in the "Notifications" region; a toast saying something was saved is not proof that it was: check the page.

# Story: ${STORY.title}

${STORY.prose}

## Done when
${STORY.doneWhen.map((d) => `- ${d}`).join('\n')}`;
}

const spikeAct: ToolSpec = {
  name: 'act',
  description:
    'Runs browser actions in order, with no model round trip between them. Stops at the first action that fails or whose `expect` is not met, and after a click on anything that looks irreversible that has no `expect`. The outcome and the page afterwards are shown in the next turn.',
  parameters: {
    type: 'object',
    properties: {
      thought: { type: 'string', description: 'One line: why this batch. Logged, not shown back.' },
      note: { type: 'string', description: 'Optional one line kept in the steps log: your memory between decisions.' },
      ...(actTool.parameters as { properties: Record<string, unknown> }).properties,
    },
    required: ['actions'],
  },
};
const TOOLS = [spikeAct, doneTool, giveUpTool];

const LOG_LINES = [
  '1-3: fill textbox "Email" = "admin@example.test", fill textbox "Password" = "admin-pass-1", click button "Sign in" → ok, url now /projects',
  '4: fill searchbox "Search projects" = "Northern" → ok',
  '5: select combobox "Status" = "Active" → ok, 2 projects listed',
  '6: click button "Clear filters" → ok, 12 projects listed',
  '7: fill searchbox "Search projects" = "" → no effect (the page did not change)',
  '8: click link "Next page" → ok, url now /projects?page=2',
  '9: click link "Previous page" → ok, url now /projects?page=1',
  '10: click link "Northern Onboarding" → ok, url now /projects/prj-001',
  '11: click button "New task" → ok, dialog "New task" opened',
  '12-14: fill textbox "Title" = "Write launch email", select combobox "Priority" = "High", click button "Save task" → expectation unmet: text "Write launch email" not on the page\n   note: the toast said "Task created" but the list has no new row',
  '15: click button "Save task" → repeated (same action on an unchanged page)',
  '16: click button "Close" → ok, dialog closed',
  '17: navigate /projects/prj-001 → ok, 8 tasks listed',
  '18: click checkbox "Mark \\"Write launch email\\" complete" → ok',
  '19: click link "Settings" → ok, url now /settings',
  '20: fill textbox "Display name" = "Ada Lovelace" → ok',
  '21: click switch "Email notifications" → ok',
  '22: click button "Save settings" → ok, toast "Settings saved"',
  '23: click link "Projects" → ok, url now /projects',
  '24: click link "Settings" → ok, url now /settings',
];

const TASKS = [
  'Draft the kickoff brief', 'Review the API contract', 'Fix flaky nightly build', 'Write release notes', 'Interview three customers',
  'Audit permissions', 'Update the style guide', 'Plan the beta rollout', 'Migrate the billing tables', 'Archive stale projects',
  'Write launch email', 'Prepare the board update', 'Triage support backlog', 'Rotate API keys', 'Localise the onboarding',
];
const PROJECTS = ['Northern Onboarding', 'Southern Billing', 'Eastern Mobile', 'Western Analytics', 'Central Platform', 'Northern Data', 'Harbour Redesign', 'Summit Security'];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function banner(start: number): string[] {
  return ['banner', '  text "Tracker"', '  navigation "Main"', ...['Projects', 'Reports', 'Plan', 'Settings'].flatMap((name, i) => ['    listitem', `      [e${start + i}] link "${name}"`]), '  text "Ada Admin (admin)"', `  [e${start + 4}] button "Sign out"`];
}

// A page of roughly 1.3k–2.5k characters that differs on every decision.
function page(n: number): { head: string; text: string } {
  const r = rng(n * 7919 + 17);
  const kind = n % 3;
  let ref = 1 + Math.floor(r() * 20);
  const lines = banner(ref);
  ref += 5;
  let head: string;
  if (kind === 0) {
    head = `page /projects?page=${1 + (n % 2)} title "Projects · Tracker"`;
    const count = 7 + Math.floor(r() * 5);
    lines.push('main', '  heading "Projects" level=1', `  [e${ref++}] searchbox "Search projects"`, `  [e${ref++}] combobox "Status" value="${r() < 0.5 ? 'All' : 'Active'}"`, `  [e${ref++}] button "New project"`, '  list "Projects"');
    for (let i = 0; i < count; i++) {
      const name = PROJECTS[(n + i) % PROJECTS.length];
      lines.push('    listitem', `      [e${ref++}] link "${name}"`, `      text "${r() < 0.7 ? 'active' : 'paused'} · ${2 + Math.floor(r() * 9)} open tasks · lead ${['Ada', 'Grace', 'Alan', 'Edsger'][i % 4]}"`);
    }
    lines.push(`  text "Page ${1 + (n % 2)} of 2"`, `  [e${ref++}] link "Previous page"`, `  [e${ref++}] link "Next page"`);
  } else if (kind === 1) {
    head = `page /projects/prj-00${1 + (n % 4)} title "Northern Onboarding · Tracker"`;
    const count = 7 + Math.floor(r() * 5);
    lines.push('main', `  [e${ref++}] link "← All projects"`, '  heading "Northern Onboarding" level=1', `  [e${ref++}] button "New task"`, '  text "active Key ONBX"', '  heading "Tasks" level=2', '  list "Tasks"');
    for (let i = 0; i < count; i++) {
      const task = TASKS[(n * 3 + i) % TASKS.length];
      const done = r() < 0.3 ? ' checked' : '';
      lines.push('    listitem', `      [e${ref++}] checkbox "Mark \\"${task}\\" complete"${done}`, `      text "Priority ${['low', 'normal', 'high'][Math.floor(r() * 3)]} · Due 2026-0${2 + (i % 3)}-${10 + i} · ${1 + Math.floor(r() * 6)} h"`, `      [e${ref++}] button "Edit \\"${task}\\""`);
    }
    if (n % 4 === 1) lines.unshift('dialog "New task"', `  [e${ref++}] textbox "Title"`, `  [e${ref++}] combobox "Priority" value="Normal"`, `  [e${ref++}] button "Save task"`, `  [e${ref++}] button "Close"`);
  } else {
    head = 'page /settings title "Settings · Tracker"';
    lines.push(
      'main',
      '  heading "Settings" level=1',
      '  heading "Profile" level=2',
      `  [e${ref++}] textbox "Display name" value="${r() < 0.5 ? 'Ada Admin' : 'Ada Lovelace'}"`,
      `  [e${ref++}] textbox "Email" value="admin@example.test" disabled`,
      `  [e${ref++}] combobox "Time zone" value="UTC"`,
      '  heading "Notifications" level=2',
      `  [e${ref++}] switch "Email notifications"${r() < 0.5 ? ' checked' : ''}`,
      `  [e${ref++}] switch "Weekly digest"${r() < 0.5 ? ' checked' : ''}`,
      `  [e${ref++}] switch "Mentions"${r() < 0.5 ? ' checked' : ''}`,
      '  heading "Danger zone" level=2',
      `  [e${ref++}] button "Delete account"`,
      `  [e${ref++}] button "Save settings"`,
      '  heading "Recent activity" level=2',
      '  list "Activity"',
      ...Array.from({ length: 8 + Math.floor(r() * 6) }, (_, i) => `    listitem\n      text "${TASKS[(n + i) % TASKS.length]} updated by ${['Ada', 'Grace', 'Alan'][i % 3]} · ${i + 1} h ago"`),
    );
  }
  lines.push('contentinfo', `  text "Server time: 2026-04-01 12:${String(n).padStart(2, '0')} UTC"`, 'region "Notifications"');
  if (r() < 0.4) lines.push(`  status "${['Task created', 'Settings saved', 'Filter applied'][n % 3]}"`);
  return { head, text: lines.join('\n') };
}

type Message = { text: string; stable: string; volatile: string; volatileChars: number; newestChars: number; pageChars: number };

function decisionMessage(n: number, marker: string): Message {
  const log = LOG_LINES.slice(0, n - 1);
  const p = page(n);
  const stable = `Steps so far:\n${log.length ? log.join('\n') : '(none: this is the first decision)'}\n`;
  const extra =
    n === MARKER_AT
      ? `Session marker: ${marker}\n`
      : n === MARKER_AT + 1
        ? 'Check: if an earlier turn of this conversation showed a session marker, copy it exactly into the note of your act call; otherwise set note to "none". Then decide as usual.\n'
        : '';
  const volatile = `Budget left: ${40 - n} steps, about ${Math.max(1, 8 - Math.floor(n / 3))} minutes.\n${extra}\nCurrent page: ${p.head}\n${p.text}`;
  const newest = log.length ? `${log.at(-1)}\n` : '';
  return { text: stable + volatile, stable, volatile, volatileChars: newest.length + volatile.length, newestChars: newest.length, pageChars: p.text.length };
}

type ResponseUsage = { id?: string; input: number; cached: number; output: number; reasoning: number; at: number; source: 'raw' | 'tokenUsage' };
type Attribution = { cacheKey: string; items: { id: string; input: number; cached: number }[] };

// What the app-server's trace log shows of each model request, in arrival order: the request
// leaving, its response headers, then the Responses stream's events.
type Mark = { at: number; event: 'request' | 'headers' | 'created' | 'added' | 'done' | 'completed'; item?: string; responseId?: string };

type Server = {
  rpc: RpcClient;
  mcp: string[];
  attribution: Map<string, Attribution>;
  marks: Mark[];
  startup: { initializeMs: number; configMs: number };
  on(threadId: string, handler: (method: string, params: any) => void): () => void;
  onTool(threadId: string, handler: (params: any) => Promise<object>): void;
  close(): void;
};

const TRACE = 'codex_api::sse::responses=trace,codex_core::client=info';

async function openServer(kind: string, trace: boolean): Promise<Server> {
  const attribution = new Map<string, Attribution>();
  const marks: Mark[] = [];
  const begin = now();
  let transport: Transport;
  if (kind === 'daemon') transport = await connectDaemon(CODEX_HOME ? join(CODEX_HOME, 'app-server-control', 'app-server-control.sock') : controlSocketPath());
  else {
    const env = { ...process.env, ...(CODEX_HOME ? { CODEX_HOME } : {}), ...(trace ? { RUST_LOG: TRACE } : {}) };
    const child = spawn('codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'pipe'], env });
    let toClient: (message: string) => void = () => {};
    lines(child.stdout, (line) => toClient(line));
    lines(child.stderr, (raw) => {
      const at = now();
      const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
      if (line.includes('model_client.stream_responses_api')) {
        if (/codex_core::client: new/.test(line)) marks.push({ at, event: 'request' });
        else if (/codex_core::client: close/.test(line)) marks.push({ at, event: 'headers' });
        return;
      }
      const sse = line.indexOf('SSE event: {"type":"response.');
      if (sse < 0) return;
      const type = /^SSE event: \{"type":"response\.([a-z_.]+)"/.exec(line.slice(sse))?.[1];
      if (type === 'created') marks.push({ at, event: 'created' });
      else if (type === 'output_item.added' || type === 'output_item.done') {
        const item = /"item":\{[^{}]*?"type":"([a-z_]+)"/.exec(line)?.[1];
        marks.push({ at, event: type === 'output_item.added' ? 'added' : 'done', item });
      } else if (type === 'completed') {
        const response = JSON.parse(line.slice(sse + 'SSE event: '.length)).response;
        marks.push({ at, event: 'completed', responseId: response.id });
        const items = Object.entries(response.usage?.attribution?.items ?? {}).map(([id, u]: [string, any]) => ({ id, input: u.input_tokens, cached: u.cached_tokens }));
        attribution.set(response.id, { cacheKey: response.prompt_cache_key, items });
      }
    });
    transport = {
      send: (message) => child.stdin.write(`${message}\n`),
      onMessage: (handler) => (toClient = handler),
      onClose: () => {},
      close: () => child.kill(),
    };
  }
  const rpc = new RpcClient(transport);
  // The daemon's socket is unreferenced while no request is pending, which would let the process
  // exit in the middle of a turn.
  rpc.hold();
  const listeners = new Map<string, Set<(method: string, params: any) => void>>();
  const tools = new Map<string, (params: any) => Promise<object>>();
  rpc.onNotification((method, params) => {
    for (const handler of listeners.get(params?.threadId) ?? []) handler(method, params);
  });
  rpc.onRequest(async (method, params) => {
    if (method === 'item/tool/call') {
      const handler = tools.get(params.threadId);
      return handler ? handler(params) : { contentItems: [{ type: 'inputText', text: 'No turn is running.' }], success: false };
    }
    if (method === 'currentTime/read') return { currentTimeAt: Math.floor(Date.now() / 1000) };
    throw new Error(`not supported: ${method}`);
  });
  await rpc.request('initialize', { clientInfo: { name: 'playtest-lite-spike', title: null, version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
  rpc.notify('initialized');
  const initializeMs = now() - begin;
  const config = await rpc.request<{ config: { mcp_servers?: Record<string, unknown> } }>('config/read', {});
  return {
    rpc,
    mcp: Object.keys(config.config.mcp_servers ?? {}),
    attribution,
    marks,
    startup: { initializeMs, configMs: now() - begin - initializeMs },
    on(threadId, handler) {
      const set = listeners.get(threadId) ?? new Set();
      listeners.set(threadId, set);
      set.add(handler);
      return () => set.delete(handler);
    },
    onTool(threadId, handler) {
      tools.set(threadId, handler);
    },
    close: () => rpc.close(),
  };
}

function lines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) onLine(line);
    }
  });
}

const TRAILER_AT = '\n\n## Common mistakes';
const TRAILER_CHARS = instructions('00000000').length - instructions('00000000').indexOf(TRAILER_AT);

function startParams(server: Server, transport: TransportName, nonce: string, ephemeral: boolean, oneTurn = false, log = '', trail = false): Record<string, any> {
  const text = instructions(nonce, oneTurn);
  const at = text.indexOf(TRAILER_AT);
  const base = !log ? text : trail ? `${text.slice(0, at)}\n\n${log}${text.slice(at)}` : `${text}\n\n${log}`;
  const params: Record<string, any> = threadStartParams({ name: MODEL, effort: EFFORT }, { instructions: base, tools: TOOLS }, server.mcp);
  params.ephemeral = ephemeral;
  params.experimentalRawEvents = true;
  if (values.tier) params.serviceTier = values.tier;
  if (capture) {
    params.modelProvider = 'playtest_capture';
    params.config = { ...params.config, 'model_providers.playtest_capture': capture.provider };
  } else if (transport === 'http') {
    params.modelProvider = 'playtest_http';
    params.config = { ...params.config, 'model_providers.playtest_http': HTTP_PROVIDER };
  }
  return params;
}

type Captured = { headers: IncomingHttpHeaders; body: any };

// A stand-in Responses endpoint: records each request and answers a new turn with a code-mode call
// to act, anything else with a short message.
async function startCapture(): Promise<{ provider: Record<string, unknown>; requests: Captured[]; close(): void }> {
  const requests: Captured[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push({ headers: req.headers, body });
      const n = requests.length;
      const last = body.input?.at(-1);
      const item =
        last?.type === 'message' && last.role === 'user'
          ? { type: 'custom_tool_call', id: `ctc_${n}`, call_id: `call_${n}`, name: 'exec', input: 'await tools.act({ actions: [] });', status: 'completed' }
          : { type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'stopped', annotations: [] }] };
      const usage = { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 };
      const events = [
        { type: 'response.created', response: { id: `resp_${n}` } },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: `resp_${n}`, usage } },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    provider: { name: 'capture', base_url: `http://127.0.0.1:${port}/v1`, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false },
    requests,
    close: () => server.close(),
  };
}

const textOf = (item: any): string =>
  item.type === 'additional_tools'
    ? JSON.stringify(item.tools)
    : typeof item.content === 'string'
      ? item.content
      : (item.content ?? []).map((c: any) => c.text ?? '').join('') || (item.input ?? item.output ?? item.arguments ?? '');

const withoutIds = (input: any[] = []) => input.map(({ id, ...rest }) => rest);

// One line per prompt part, with its size, so two homes or two decisions can be compared by eye.
function describeRequest(r: Captured, i: number, previous?: Captured): string {
  const b = r.body;
  const top = Object.fromEntries(Object.entries(b).filter(([k]) => !['input', 'instructions', 'tools'].includes(k)));
  const tools = (b.tools ?? []).map((t: any) => `${t.type}:${t.name ?? ''}(${JSON.stringify(t).length})`).join(' ');
  const headers = Object.entries(r.headers)
    .filter(([k]) => !/authorization|cookie/i.test(k))
    .map(([k, v]) => (/^(session_id|originator|x-codex|openai-beta|version)/i.test(k) ? `${k}=${String(v).slice(0, 120)}` : k))
    .join(' ');
  const items = (b.input ?? []).map((item: any) => {
    const text = String(textOf(item));
    const names = item.type === 'additional_tools' ? ` [${item.tools.map((t: any) => `${t.type}:${t.name ?? ''}`).join(' ')}]` : '';
    return `    ${item.type}${item.role ? `/${item.role}` : ''}${names} ${text.length} chars${item.id ? ` id=${item.id.slice(0, 12)}…` : ''}: ${JSON.stringify(text.slice(0, 70))}${text.length > 70 ? ` … ${JSON.stringify(text.slice(-40))}` : ''}`;
  });
  let shared = '';
  if (previous) {
    const a = JSON.stringify([previous.body.tools, previous.body.instructions, withoutIds(previous.body.input)]);
    const c = JSON.stringify([b.tools, b.instructions, withoutIds(b.input)]);
    let k = 0;
    while (k < a.length && a[k] === c[k]) k++;
    shared = `\n  shared with the previous request, item ids aside: ${k} of ${c.length} serialized chars; first difference at …${JSON.stringify(c.slice(Math.max(0, k - 50), k))} | ${JSON.stringify(c.slice(k, k + 60))}`;
  }
  return `request ${i + 1}:\n${Object.entries(top).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join('\n')}\n  headers: ${headers}\n  tools: ${tools}\n  instructions: ${String(b.instructions ?? '').length} chars: ${JSON.stringify(String(b.instructions ?? '').slice(0, 60))} … ${JSON.stringify(String(b.instructions ?? '').slice(-60))}\n  input:\n${items.join('\n')}${shared}`;
}

type Decision = {
  n: number;
  turnId: string;
  setupMs: number;
  toToolMs: number;
  cutMs: number;
  restoreMs: number;
  totalMs: number;
  responses: ResponseUsage[];
  tokenUsage: ResponseUsage[];
  inputItems: string[];
  agentsId?: string;
  call?: { tool: string; args: any };
  status: string;
  messageChars: number;
  volatileChars: number;
  newestChars: number;
  pageChars: number;
  attribution?: Attribution;
  warm?: { ms: number; usage: ResponseUsage[]; status: string; tool?: string };
  startedAt: number;
  callAt: number;
  // Fork or thread start, turn, cut and clean-up, end to end.
  cycleMs?: number;
  phases?: Phases;
};

// Milliseconds from turn/start to the call, by where they went: Codex preparing the request, waiting
// for response headers, the model's first output item, reasoning before the call, writing the
// call's program, and code mode running it until the call reaches the harness.
type Phases = { prepare: number; headers: number; firstItem: number; reasoning: number; write: number; exec: number; first?: string };

function phasesOf(marks: Mark[], from: number, callAt: number): Phases | undefined {
  const span = marks.filter((m) => m.at >= from && m.at <= callAt + 20);
  const call = span.findLast((m) => m.event === 'done' && m.item === 'custom_tool_call');
  const request = span.findLast((m) => m.event === 'request' && (!call || m.at <= call.at));
  if (!call || !request) return undefined;
  const after = span.filter((m) => m.at >= request.at);
  const headers = after.find((m) => m.event === 'headers');
  const first = after.find((m) => m.event === 'added');
  const callAdded = after.find((m) => m.event === 'added' && m.item === 'custom_tool_call');
  if (!headers || !first || !callAdded) return undefined;
  return {
    prepare: request.at - from,
    headers: headers.at - request.at,
    firstItem: first.at - headers.at,
    reasoning: callAdded.at - first.at,
    write: call.at - callAdded.at,
    exec: callAt - call.at,
    first: first.item,
  };
}

// Runs one turn and cuts it at the first tool call: the call is held until the response that made
// it has completed (so its usage is reported and no follow-up response can start), then the turn
// is interrupted and the call answered. Without raw events (forks) Codex reports usage only as the
// turn ends, so the call is held for a fixed time instead.
function cutTurn(server: Server, threadId: string, text: string, holdMs?: number): Promise<Omit<Decision, 'n' | 'setupMs' | 'restoreMs' | 'totalMs' | 'messageChars' | 'volatileChars' | 'newestChars' | 'pageChars'>> {
  const start = now();
  let turnId = '';
  const responses: ResponseUsage[] = [];
  const tokenUsage: ResponseUsage[] = [];
  const inputItems: string[] = [];
  let agentsId: string | undefined;
  let call: { tool: string; args: any } | undefined;
  let toToolMs = NaN;
  let callAt = NaN;
  let release: (() => void) | undefined;
  let responseDone = false;
  let interrupted = false;
  return new Promise((resolve, reject) => {
    const cut = (turnId: string) => {
      if (interrupted) return;
      interrupted = true;
      server.rpc.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      release?.();
    };
    const off = server.on(threadId, (method, p) => {
      if (method === 'turn/started') turnId ||= p.turn.id;
      else if (method === 'rawResponse/completed' || method === 'thread/tokenUsage/updated') {
        if (method === 'rawResponse/completed') {
          const u = p.usage ?? {};
          responses.push({ id: p.responseId, input: u.inputTokens, cached: u.cachedInputTokens, output: u.outputTokens, reasoning: u.reasoningOutputTokens, at: now() - start, source: 'raw' });
        } else {
          const u = p.tokenUsage.last;
          tokenUsage.push({ input: u.inputTokens, cached: u.cachedInputTokens, output: u.outputTokens, reasoning: u.reasoningOutputTokens, at: now() - start, source: 'tokenUsage' });
        }
        responseDone = true;
        if (call && holdMs === undefined) cut(p.turnId);
      } else if (method === 'rawResponseItem/completed') {
        const item = p.item;
        const text = String(item.content?.[0]?.text ?? '');
        if (item.type === 'message' && item.role !== 'assistant') inputItems.push(`${item.role}: ${text.slice(0, 40).replace(/\n/g, ' ')}`);
        if (text.startsWith('# AGENTS.md')) agentsId = item.id;
      } else if (method === 'turn/completed') {
        off();
        release?.();
        resolve({ turnId: turnId || p.turn.id, toToolMs, cutMs: now() - callAt, responses, tokenUsage, inputItems, agentsId, call, status: p.turn.status, startedAt: start, callAt });
      }
    });
    server.onTool(threadId, async (p) => {
      if (call) return { contentItems: [{ type: 'inputText', text: 'one call per turn; the next turn shows the result' }], success: false };
      call = { tool: p.tool, args: p.arguments };
      callAt = now();
      toToolMs = callAt - start;
      const held = new Promise<void>((resolve) => (release = resolve));
      if (holdMs !== undefined) setTimeout(() => cut(p.turnId), holdMs);
      else if (responseDone) cut(p.turnId);
      else setTimeout(() => cut(p.turnId), 5000);
      await held;
      return { contentItems: [{ type: 'inputText', text: 'ok' }], success: true };
    });
    // thread/fork takes no `environments`, so a fork gets the default one and apply_patch joins its
    // tools; an empty list per turn keeps the tools of every decision identical to the source's.
    server.rpc.request<{ turn: { id: string } }>('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }], environments: [] }).then(
      (response) => (turnId ||= response.turn.id),
      (error) => {
        off();
        reject(error);
      },
    );
  });
}

async function runSession(server: Server, strategy: Strategy, transport: TransportName): Promise<Decision[]> {
  const nonce = randomBytes(4).toString('hex');
  const marker = `QUOKKA-${randomBytes(2).toString('hex').toUpperCase()}`;
  const decisions: Decision[] = [];
  if (strategy === 'accumulate') return accumulate(server, transport, nonce, marker);
  // forklog and forktrail carry the steps log in the base instructions; forktrail puts it before
  // the last sections, which stay fixed after it.
  const logged = strategy === 'forklog' || strategy === 'forktrail';
  const trail = strategy === 'forktrail';
  let threadId = '';
  let prefixThread = '';
  let prefixTurn = '';
  let agentsId: string | undefined;
  if (strategy === 'revert' || strategy === 'warm') threadId = (await server.rpc.request('thread/start', startParams(server, transport, nonce, false))).thread.id;
  if (strategy === 'fork') {
    // A fork needs a source with a rollout on disk, which only appears after a first turn.
    prefixThread = (await server.rpc.request('thread/start', startParams(server, transport, nonce, false))).thread.id;
    prefixTurn = (await cutTurn(server, prefixThread, 'Session starting. Call tools.act with actions: [] to begin.')).turnId;
  }
  try {
    for (let n = 1; n <= DECISIONS; n++) {
      const message = decisionMessage(n, marker);
      const begin = now();
      if (strategy === 'fresh') threadId = (await server.rpc.request('thread/start', startParams(server, transport, nonce, true))).thread.id;
      // forklog: decision 1 runs on the source thread, whose base instructions carry the log; every
      // later decision is a fork from before that turn with the log so far in its base instructions.
      const forked = strategy === 'fork' || (logged && n > 1);
      if (logged && n === 1) prefixThread = threadId = (await server.rpc.request('thread/start', startParams(server, transport, nonce, false, false, message.stable, trail))).thread.id;
      if (forked) {
        // A fork takes none of the source's thread/start config, so the lockdown and instructions go again.
        const { model, modelProvider, cwd, sandbox, approvalPolicy, baseInstructions, config, serviceTier } = startParams(server, transport, nonce, true, false, logged ? message.stable : '', trail);
        const forkParams = { threadId: prefixThread, beforeTurnId: prefixTurn, ephemeral: true, excludeTurns: true, model, modelProvider, cwd, sandbox, approvalPolicy, baseInstructions, config, serviceTier };
        threadId = (await server.rpc.request('thread/fork', forkParams)).thread.id;
      }
      const setupMs = now() - begin;
      const turn = await cutTurn(server, threadId, logged ? message.volatile : message.text, forked ? HOLD : undefined);
      if (logged && n === 1) prefixTurn = turn.turnId;
      agentsId ??= turn.agentsId;
      const restoreStart = now();
      if (strategy === 'revert' || strategy === 'warm') await server.rpc.request('thread/revert', { threadId, beforeTurnId: turn.turnId });
      else if (threadId !== prefixThread) await server.rpc.request('thread/unsubscribe', { threadId }).catch(() => {});
      const restoreMs = now() - restoreStart;
      // A fork's cut and clean-up overlap the next decision, which starts on a new fork.
      const totalMs = forked ? setupMs + turn.toToolMs : now() - begin;
      const warm = strategy === 'warm' && n < DECISIONS ? await warmUp(server, threadId, message) : undefined;
      decisions.push({
        n,
        setupMs,
        ...turn,
        restoreMs,
        totalMs,
        messageChars: message.text.length,
        volatileChars: message.volatileChars,
        newestChars: message.newestChars,
        pageChars: message.pageChars,
        warm,
        agentsId,
        cycleMs: now() - begin,
        phases: phasesOf(server.marks, turn.startedAt, turn.callAt),
      });
      progress(strategy, transport, decisions.at(-1)!);
      if (GAP) await sleep(GAP);
    }
  } finally {
    for (const id of new Set([threadId, prefixThread])) {
      if (!id || strategy === 'fresh' || (logged && id !== prefixThread)) continue;
      await server.rpc.request('thread/delete', { threadId: id }).catch((error) => process.stderr.write(`thread/delete ${id}: ${(error as Error).message}\n`));
    }
  }
  return decisions;
}

// The backend serves a cached prefix only up to a checkpoint an earlier request left at the end of
// its prompt, so a throwaway turn ending at this decision's log leaves one the next decision can use.
// It runs while the harness carries out the decision's actions.
async function warmUp(server: Server, threadId: string, message: Message): Promise<NonNullable<Decision['warm']>> {
  const start = now();
  const turn = await cutTurn(server, threadId, `${message.stable}(The page is being prepared. Reply with the single word "ready" and do not call a tool this turn.)`);
  await server.rpc.request('thread/revert', { threadId, beforeTurnId: turn.turnId });
  return { ms: now() - start, usage: turn.responses.length ? turn.responses : turn.tokenUsage, status: turn.status, tool: turn.call?.tool };
}

// v1's way: one turn for the whole session; each act result carries the next log line and page.
async function accumulate(server: Server, transport: TransportName, nonce: string, marker: string): Promise<Decision[]> {
  const threadId = (await server.rpc.request('thread/start', startParams(server, transport, nonce, true, true))).thread.id;
  const decisions: (Decision & { response: number })[] = [];
  const responses: ResponseUsage[] = [];
  const tokenUsage: ResponseUsage[] = [];
  let callResponse = 0;
  let mark = now();
  const first = decisionMessage(1, marker);
  let next: Message = first;
  const done = new Promise<void>((resolve) => {
    server.on(threadId, (method, p) => {
      if (method === 'rawResponse/completed') {
        const u = p.usage ?? {};
        responses.push({ id: p.responseId, input: u.inputTokens, cached: u.cachedInputTokens, output: u.outputTokens, reasoning: u.reasoningOutputTokens, at: now() - mark, source: 'raw' });
      } else if (method === 'thread/tokenUsage/updated') {
        const u = p.tokenUsage.last;
        tokenUsage.push({ input: u.inputTokens, cached: u.cachedInputTokens, output: u.outputTokens, reasoning: u.reasoningOutputTokens, at: now() - mark, source: 'tokenUsage' });
      } else if (method === 'rawResponseItem/completed' && p.item.type === 'custom_tool_call') callResponse = responses.length;
      else if (method === 'turn/completed') resolve();
    });
  });
  server.onTool(threadId, async (p) => {
    const n = decisions.length + 1;
    const callAt = now();
    const toToolMs = callAt - mark;
    const phases = phasesOf(server.marks, mark, callAt);
    const shown = next;
    if (GAP) await sleep(GAP);
    decisions.push({
      n,
      turnId: p.turnId,
      setupMs: 0,
      toToolMs,
      cutMs: 0,
      restoreMs: 0,
      totalMs: now() - mark,
      responses: [],
      tokenUsage: [],
      inputItems: [],
      call: { tool: p.tool, args: p.arguments },
      status: 'running',
      messageChars: shown.text.length,
      volatileChars: shown.volatileChars,
      newestChars: shown.newestChars,
      pageChars: shown.pageChars,
      startedAt: callAt - toToolMs,
      callAt,
      phases,
      response: callResponse,
    });
    process.stderr.write(`accumulate/${transport} #${n} ${Math.round(toToolMs)}ms→call ${p.tool}\n`);
    mark = now();
    if (n >= DECISIONS) return { contentItems: [{ type: 'inputText', text: 'The session is over. Reply with the single word "stopped".' }], success: true };
    next = decisionMessage(n + 1, marker);
    return { contentItems: [{ type: 'inputText', text: next.text.replace(/^Steps so far:\n[\s\S]*?(?=Budget left)/, `${LOG_LINES[n - 1]}\n`) }], success: true };
  });
  await server.rpc.request('turn/start', { threadId, input: [{ type: 'text', text: first.text, text_elements: [] }] });
  await done;
  await sleep(100);
  // Responses that made no call (a text reply, a retry) count towards the next decision.
  let from = 0;
  for (const [i, d] of decisions.entries()) {
    const to = i === decisions.length - 1 ? responses.length : d.response + 1;
    d.responses = responses.slice(from, to);
    d.tokenUsage = tokenUsage.slice(from, to);
    from = to;
  }
  await server.rpc.request('thread/unsubscribe', { threadId }).catch(() => {});
  return decisions;
}

function progress(strategy: string, transport: string, d: Decision): void {
  const u = d.responses.at(-1) ?? d.tokenUsage.at(-1);
  const note = d.call?.args?.note ? ` note=${JSON.stringify(d.call.args.note)}` : '';
  process.stderr.write(`${strategy}/${transport} #${d.n} ${Math.round(d.toToolMs)}ms→call total ${Math.round(d.totalMs)}ms in ${u?.input ?? '-'} cached ${u?.cached ?? '-'} out ${u?.output ?? '-'} ${d.call?.tool ?? d.status}${note}\n`);
}

type Summary = {
  strategy: string;
  transport: string;
  decisions: number;
  tokensPerChar: number;
  fixedTokens: number;
  toTool: [number, number];
  total: [number, number];
  setup: number;
  restore: number;
  input: number;
  cached: number;
  uncached: number;
  expectedUncached: number;
  // Decisions whose uncached input is within the expected, or one or two 128-token blocks over it.
  gate: [number, number, number];
  gateOf: number;
  agentsTokens: number;
  responsesPerDecision: number;
  output: number;
  marker: string;
  sourcesAgree: boolean;
  warmMs: number;
  warmUncached: number;
  warmOutput: number;
  misses: number;
  cycle: number;
  reasoning: number;
  phases?: Phases;
};

const usage = (d: Decision) => (d.responses.length ? d.responses : d.tokenUsage);

// A miss: the backend served none of the instructions from its cache, only the tools or nothing.
const MISS_BLOCKS = 8;

const quantile = (xs: number[], q: number) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : NaN;
};

// input = fixed + tokensPerChar × message characters, fitted over single-response decisions.
function fit(decisions: Decision[]): { a: number; b: number } {
  const points = decisions.filter((d) => usage(d).length === 1).map((d) => [d.messageChars, usage(d)[0]!.input] as const);
  if (points.length < 3) return { a: NaN, b: NaN };
  const mx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const my = points.reduce((s, p) => s + p[1], 0) / points.length;
  const b = points.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / points.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  return { a: my - b * mx, b };
}

const tokensOf = (d: Decision | undefined, prefix: string) => d?.attribution?.items.filter((i) => i.id.startsWith(prefix)).map((i) => i.input) ?? [];

// What the gate lets the cache leave uncached: the newest log line onwards, plus the rest of the
// 128-token block it starts in. When the log rides in the base instructions (forklog) the trace's
// per-item counts give the shared prefix exactly: the tools and the previous decision's instructions,
// less the couple of tokens that close the instructions.
function expectedUncached(d: Decision, prev: Decision | undefined, b: number, strategy: string): number {
  const first = usage(d)[0];
  if (!first) return NaN;
  const tools = tokensOf(d, 'at_')[0];
  const instructions = Math.max(...tokensOf(d, 'msg_'));
  const previous = Math.max(...tokensOf(prev, 'msg_'));
  let shared = first.input - Math.round(b * (d.volatileChars + (strategy === 'forktrail' ? TRAILER_CHARS : 0)));
  if (strategy === 'forklog' && tools !== undefined && Number.isFinite(instructions)) {
    shared = d.n >= 3 && Number.isFinite(previous) ? tools + previous - 2 : tools + instructions - Math.round(b * d.newestChars) - 2;
  }
  return first.input - Math.floor(shared / 128) * 128;
}

function summarise(strategy: string, transport: string, decisions: Decision[]): Summary {
  const { a, b } = strategy === 'accumulate' ? { a: NaN, b: NaN } : fit(decisions);
  const later = decisions.filter((d) => d.n >= 2 && usage(d).length);
  const gateRows = later.map((d) => {
    const r = usage(d)[0]!;
    const expected = expectedUncached(d, decisions.find((p) => p.n === d.n - 1), b, strategy);
    return { uncached: r.input - r.cached, expected, lag: Math.max(0, Math.ceil((r.input - r.cached - expected) / 128)) };
  });
  const agentsTokens = decisions.flatMap((d) => d.attribution?.items.filter((i) => i.id === d.agentsId) ?? [])[0]?.input ?? NaN;
  const note = String(decisions.find((d) => d.n === MARKER_AT + 1)?.call?.args?.note ?? '');
  const marker = /QUOKKA-/.test(note) ? 'seen' : 'not seen';
  const warms = decisions.flatMap((d) => (d.warm ? [d.warm] : []));
  const sourcesAgree = decisions.every((d) => d.responses.every((r, i) => !d.tokenUsage[i] || (d.tokenUsage[i]!.input === r.input && d.tokenUsage[i]!.cached === r.cached)));
  return {
    strategy,
    transport,
    decisions: decisions.length,
    tokensPerChar: b,
    fixedTokens: a,
    toTool: [quantile(decisions.map((d) => d.toToolMs), 0.5), quantile(decisions.map((d) => d.toToolMs), 0.9)],
    total: [quantile(decisions.map((d) => d.totalMs), 0.5), quantile(decisions.map((d) => d.totalMs), 0.9)],
    setup: quantile(decisions.map((d) => d.setupMs), 0.5),
    restore: quantile(decisions.map((d) => d.restoreMs + d.cutMs), 0.5),
    input: quantile(later.map((d) => usage(d)[0]!.input), 0.5),
    cached: quantile(later.map((d) => usage(d)[0]!.cached), 0.5),
    uncached: quantile(gateRows.map((g) => g.uncached), 0.5),
    expectedUncached: quantile(gateRows.map((g) => g.expected), 0.5),
    gate: strategy === 'accumulate' ? [NaN, NaN, NaN] : [0, 1, 2].map((blocks) => gateRows.filter((g) => g.lag <= blocks).length) as [number, number, number],
    gateOf: gateRows.length,
    agentsTokens,
    responsesPerDecision: decisions.reduce((s, d) => s + Math.max(d.responses.length, d.tokenUsage.length) + (d.warm?.usage.length ?? 0), 0) / decisions.length,
    output: quantile(decisions.map((d) => usage(d).reduce((s, r) => s + r.output, 0)), 0.5),
    marker,
    sourcesAgree,
    warmMs: quantile(warms.map((w) => w.ms), 0.5),
    warmUncached: quantile(warms.map((w) => w.usage.reduce((s, u) => s + u.input - u.cached, 0)), 0.5),
    warmOutput: quantile(warms.map((w) => w.usage.reduce((s, u) => s + u.output, 0)), 0.5),
    misses: gateRows.filter((g) => g.lag > MISS_BLOCKS).length,
    cycle: quantile(decisions.map((d) => d.cycleMs ?? NaN), 0.5),
    reasoning: quantile(decisions.map((d) => usage(d).reduce((s, r) => s + r.reasoning, 0)), 0.5),
    phases: medianPhases(later),
  };
}

function medianPhases(decisions: Decision[]): Phases | undefined {
  const all = decisions.flatMap((d) => (d.phases ? [d.phases] : []));
  if (!all.length) return undefined;
  const m = (key: keyof Omit<Phases, 'first'>) => quantile(all.map((p) => p[key]), 0.5);
  const firsts = [...new Set(all.map((p) => p.first))].join('/');
  return { prepare: m('prepare'), headers: m('headers'), firstItem: m('firstItem'), reasoning: m('reasoning'), write: m('write'), exec: m('exec'), first: firsts };
}

const phaseText = (p: Phases) =>
  `${Math.round(p.prepare)}+${Math.round(p.headers)}+${Math.round(p.firstItem)}+${Math.round(p.reasoning)}+${Math.round(p.write)}+${Math.round(p.exec)}${p.first && p.first !== 'custom_tool_call' ? ` (${p.first} first)` : ''}`;

function table(summaries: Summary[]): string {
  const r = (n: number) => (Number.isFinite(n) ? String(Math.round(n)) : '-');
  const header = ['strategy', 'transport', 'n', 'turn→call ms p50/p90', 'decision ms p50/p90', 'cycle ms p50', 'setup ms', 'cut+restore ms', 'phases ms p50: prepare+headers+first item+reasoning+write+exec', 'input p50', 'cached p50', 'uncached p50', 'expected uncached p50', 'gate (decisions 2..n): exact / within 1 block / within 2', 'gate without misses', 'misses', 'AGENTS.md tokens', 'responses/decision', 'output p50', 'reasoning p50', 'warm ms/uncached/output p50', 'marker from 5 at 6', 'tok/char'];
  const rows = summaries.map((s) => [
    s.strategy,
    s.transport,
    String(s.decisions),
    `${r(s.toTool[0])}/${r(s.toTool[1])}`,
    `${r(s.total[0])}/${r(s.total[1])}`,
    r(s.cycle),
    r(s.setup),
    r(s.restore),
    s.phases ? phaseText(s.phases) : '-',
    r(s.input),
    r(s.cached),
    r(s.uncached),
    r(s.expectedUncached),
    Number.isFinite(s.gate[0]) ? `${s.gate.join(' / ')} of ${s.gateOf}` : '-',
    Number.isFinite(s.gate[0]) ? `${s.gate.join(' / ')} of ${s.gateOf - s.misses}` : '-',
    `${s.misses}/${s.gateOf}`,
    r(s.agentsTokens),
    s.responsesPerDecision.toFixed(2),
    r(s.output),
    r(s.reasoning),
    Number.isFinite(s.warmMs) ? `${r(s.warmMs)}/${r(s.warmUncached)}/${r(s.warmOutput)}` : '-',
    s.marker,
    Number.isFinite(s.tokensPerChar) ? s.tokensPerChar.toFixed(3) : '-',
  ]);
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n');
}

function perDecision(decisions: Decision[], b: number, strategy: string): string {
  return decisions
    .map((d, i) => {
      const u = usage(d)[0];
      const expected = expectedUncached(d, decisions[i - 1], b, strategy);
      const over = u ? u.input - u.cached - expected : NaN;
      const verdict = d.n < 2 || !Number.isFinite(over) ? '' : over <= 0 ? ' pass' : over > MISS_BLOCKS * 128 ? ' MISS' : ` fail by ${Math.ceil(over / 128)} block${over > 128 ? 's' : ''}`;
      const phases = d.phases ? `, phases ${phaseText(d.phases)}` : '';
      const cycle = d.cycleMs ? `, cycle ${Math.round(d.cycleMs)} ms` : '';
      const items = d.attribution?.items.map((i) => `${i.id.slice(0, 6)} ${i.input}/${i.cached}`).join(', ') ?? '';
      const w = d.warm ? ` [warm ${Math.round(d.warm.ms)} ms, ${d.warm.usage.map((x) => `${x.input}/${x.cached}/${x.output}`).join(' ')}${d.warm.tool ? `, called ${d.warm.tool}` : ''}]` : '';
      return `  #${d.n} call ${Math.round(d.toToolMs)} ms, decision ${Math.round(d.totalMs)} ms${cycle}${phases}, input ${u?.input ?? '-'} cached ${u?.cached ?? '-'} uncached ${u ? u.input - u.cached : '-'} expected ${Number.isFinite(expected) ? expected : '-'}${verdict}, out ${u?.output ?? '-'} (reasoning ${u?.reasoning ?? '-'}), responses ${d.responses.length || d.tokenUsage.length}${w}${items ? ` | ${items}` : ''}`;
    })
    .join('\n');
}

if (values.sizes) {
  const messages = Array.from({ length: DECISIONS }, (_, i) => decisionMessage(i + 1, 'QUOKKA-0000'));
  console.log(`instructions ${instructions('00000000').length} chars, tools ${JSON.stringify(TOOLS).length} chars`);
  console.log(`pages ${messages.map((m) => m.pageChars).join(' ')}`);
  console.log(`messages ${messages.map((m) => m.text.length).join(' ')}`);
  console.log(`volatile ${messages.map((m) => m.volatileChars).join(' ')}`);
  console.log(decisionMessage(12, 'QUOKKA-0000').text);
  if (values.json) writeFileSync(values.json, JSON.stringify({ instructions: instructions('00000000'), tools: TOOLS, messages: messages.map((m) => m.text) }, null, 2));
  process.exit(0);
}

const capture = values.capture ? await startCapture() : undefined;

if (values.startup) {
  const rows: number[][] = [];
  for (let i = 0; i < Number(values.startup); i++) {
    const begin = now();
    const server = await openServer(values.server!, values.server === 'spawn');
    const opened = now() - begin;
    const message = decisionMessage(1, 'QUOKKA-0000');
    const threadId = (await server.rpc.request('thread/start', startParams(server, 'http', randomBytes(4).toString('hex'), true, false, message.stable))).thread.id;
    const started = now() - begin - opened;
    const turn = await cutTurn(server, threadId, message.volatile);
    const phases = phasesOf(server.marks, turn.startedAt, turn.callAt);
    rows.push([opened, started, turn.toToolMs, phases?.prepare ?? NaN, phases?.headers ?? NaN, phases?.firstItem ?? NaN, phases?.write ?? NaN, now() - begin]);
    console.log(`start ${i + 1}: open ${Math.round(opened)} ms, thread/start ${Math.round(started)} ms, turn→call ${Math.round(turn.toToolMs)} ms${phases ? ` (${phaseText(phases)})` : ''}, ${(turn.responses[0] ?? turn.tokenUsage[0])?.output ?? '-'} output tokens`);
    await server.rpc.request('thread/unsubscribe', { threadId }).catch(() => {});
    server.close();
  }
  const median = (k: number) => Math.round(quantile(rows.map((r) => r[k]!), 0.5));
  console.log(`median: open ${median(0)} ms, thread/start ${median(1)} ms, turn→call ${median(2)} ms (prepare ${median(3)}, headers ${median(4)}, first item ${median(5)}, write ${median(6)}), to the first call ${median(7)} ms`);
  process.exit(0);
}
const strategies = values.strategies!.split(',') as Strategy[];
const transports = values.transports!.split(',') as TransportName[];
const results: { strategy: string; transport: string; summary: Summary; decisions: Decision[] }[] = [];
for (const transport of transports) {
  const server = await openServer(values.server!, values.server === 'spawn' && transport === 'http');
  console.log(`server ${values.server} (${CODEX_HOME ?? 'default home'}): initialize ${Math.round(server.startup.initializeMs)} ms, config/read ${Math.round(server.startup.configMs)} ms, MCP servers: ${server.mcp.join(', ') || 'none'}`);
  for (const strategy of strategies) {
    try {
      const decisions = await runSession(server, strategy, transport);
      await sleep(200);
      for (const d of decisions) {
        // Forks report no raw events, so their response is found by time in the trace.
        const id = d.responses[0]?.id ?? server.marks.find((m) => m.event === 'completed' && m.at >= d.callAt - 50)?.responseId;
        if (id) d.attribution = server.attribution.get(id);
      }
      const summary = summarise(strategy, transport, decisions);
      results.push({ strategy, transport, summary, decisions });
      console.log(`\n${strategy}/${transport} (${MODEL} @ ${EFFORT}, gap ${GAP} ms):\n${perDecision(decisions, summary.tokensPerChar, strategy)}`);
    } catch (error) {
      console.error(`${strategy}/${transport}: ${(error as Error).stack}`);
    }
  }
  server.close();
}
if (capture) {
  console.log(`\n${capture.requests.length} requests reached the stand-in provider:`);
  capture.requests.forEach((r, i) => console.log(describeRequest(r, i, capture.requests[i - 1])));
  if (values.json) writeFileSync(values.json, JSON.stringify(capture.requests, null, 2));
  capture.close();
  process.exit(0);
}
console.log(`\nSummary (${MODEL} @ ${EFFORT}${values.tier ? `, tier ${values.tier}` : ''}, ${DECISIONS} decisions, gap ${GAP} ms, hold ${HOLD} ms, server ${values.server}, ${CODEX_HOME ?? 'default home'}):`);
console.log(table(results.map((r) => r.summary)));
if (values.json) writeFileSync(values.json, JSON.stringify({ model: MODEL, effort: EFFORT, tier: values.tier, gap: GAP, hold: HOLD, server: values.server, codexHome: CODEX_HOME, results }, null, 2));
process.exit(0);
