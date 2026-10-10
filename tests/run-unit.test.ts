import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Actor, IRREVERSIBLE, parseAction, parseCheck } from '../src/run/actor.ts';
import { formatBaseline, parseBaseline } from '../src/run/baseline.ts';
import { unifiedDiff } from '../src/run/diff.ts';
import { checkStory, SLOW_RERUNS, type StoryResult } from '../src/run/replay.ts';
import { checkMarkdown, checkSummary, stepList } from '../src/run/report.ts';
import type { Run } from '../src/run/session.ts';
import type { Baseline, Page } from '../src/types.ts';

test('unifiedDiff gives hunks with context, deletions before additions', () => {
  const a = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const b = ['a', 'b', 'X', 'd', 'e', 'f', 'g', 'h', 'Y'];
  assert.deepEqual(unifiedDiff(a, b, 1), ['@@ -2,3 +2,3 @@', ' b', '-c', '+X', ' d', '@@ -8,1 +8,2 @@', ' h', '+Y']);
  assert.deepEqual(unifiedDiff(a, a), []);
});

test('baselines format with fixed key order, one snapshot line per line, and parse back', () => {
  const baseline: Baseline = {
    version: 2,
    story: 's',
    url: 'http://fake/',
    seeded: false,
    platform: 'darwin-arm64',
    chrome: '1.2.3',
    harness: '0.1.0',
    viewport: [1280, 800],
    start: '/login',
    startIssues: [],
    steps: [
      {
        // Keys deliberately out of order.
        action: { value: 'x', target: { name: 'Email', role: 'textbox' }, type: 'fill' } as never,
        url: '/login',
        snapshot: ['main', '  textbox "Email" value="x"'],
        fingerprint: 'ff',
        settleMs: 51,
        issues: [{ path: '/login', kind: 'console', key: 'console|/login||boom', message: 'boom' }],
      },
    ],
    checks: [{ value: '/projects', type: 'url' } as never],
  };
  const text = formatBaseline(baseline);
  assert.match(text, /\n {6}"action": \{"type":"fill","target":\{"role":"textbox","name":"Email"\},"value":"x"\},\n/);
  assert.match(text, /\n {6}"snapshot": \[\n {8}"main",\n {8}"  textbox \\"Email\\" value=\\"x\\""\n {6}\]\n/);
  assert.match(text, /\n {2}"checks": \[\n {4}\{"type":"url","value":"\/projects"\}\n {2}\]\n\}\n$/);
  assert.deepEqual(parseBaseline(text, 'b.json'), JSON.parse(text));
  assert.throws(() => parseBaseline(JSON.stringify({ ...baseline, version: 1 }), 'b.json'), /version 1 is not 2; record the story again/);
});

test('parseAction accepts refs, locators and flat checks, and explains bad input', () => {
  assert.deepEqual(parseAction({ type: 'click', target: '[e12]' }), { type: 'click', target: { ref: 'e12' } });
  assert.deepEqual(parseAction({ type: 'fill', target: { role: 'textbox', name: 'Title' }, text: 'x', expect: { type: 'element', role: 'dialog', name: 'New task' } }), {
    type: 'fill',
    target: { role: 'textbox', name: 'Title' },
    value: 'x',
    expect: [{ type: 'element', locator: { role: 'dialog', name: 'New task' } }],
  });
  assert.equal(parseAction({ type: 'fill', target: 'e1' }), 'fill needs a target and a value');
  assert.match(String(parseAction({ type: 'click', target: 'Sign in' })), /not a ref/);
  assert.deepEqual(parseCheck({ type: 'value', locator: { role: 'textbox', name: 'Email' }, value: 'a@b' }), {
    type: 'value',
    locator: { role: 'textbox', name: 'Email' },
    value: 'a@b',
  });
  assert.match(String(parseCheck({ type: 'visible' })), /unknown check type/);
});

test('irreversible names', () => {
  for (const name of ['Delete "Draft"', 'Delete task', 'Pay now', 'Confirm', 'Sign out', 'Upgrade to Pro', 'Remove member'])
    assert.ok(IRREVERSIBLE.test(name), name);
  for (const name of ['Sign in', 'Save task', 'New task', 'Golden Checkout', 'Payment details', 'Next']) assert.ok(!IRREVERSIBLE.test(name), name);
});

test('a batch stops at its deadline after settling the current action', async () => {
  let mutations = 0;
  const page = {
    act: async () => { mutations++; actor.deadline = 0; return { ok: true, settleMs: 0, issues: [] }; },
    snapshot: async () => ({ url: 'http://local/', title: 'Task', text: 'textbox "Notes"', lines: [] }),
  } as unknown as Page;
  const actor = new Actor(page);
  const action = { type: 'fill', target: { role: 'textbox', name: 'Notes' }, value: 'saved' };
  const result = await actor.act({ actions: [action, action] });
  assert.equal(mutations, 1);
  assert.equal(actor.actions.length, 1);
  assert.match(result, /stopped before 2: time budget spent/);
});

test('the check summary is one line per passing story and details for failures', () => {
  const base: StoryResult = {
    story: 'a',
    status: 'pass',
    ms: 600,
    url: 'http://fake/',
    seeded: false,
    steps: 3,
    ran: 3,
    drift: [],
    checks: [],
    newIssues: [],
    slow: [],
    visual: [],
    visualCompared: true,
  };
  const failing: StoryResult = {
    ...base,
    story: 'bb',
    status: 'fail',
    drift: [{ step: 2, action: 'click button "Go"', url: '/x', diff: ['@@ -1,1 +1,1 @@', '-a', '+b'] }],
    checks: [{ check: { type: 'text', value: 'hi' }, ok: false, detail: 'Text "hi" is not on the page' }],
    slow: [{ step: 3, action: 'click button "Go"', baselineMs: 50, ms: 900, rerunMs: [] }],
  };
  const rerun: StoryResult = {
    ...base,
    rerun: { runs: 1, ms: 300, cleared: [{ step: 2, action: 'click button "Save"', baselineMs: 60, ms: 940, rerunMs: [70] }] },
  };
  assert.deepEqual(checkSummary([base, failing, rerun], 1500, '/tmp/report.md'), [
    'PASS  a   3/3 steps 600ms',
    'FAIL  bb  3/3 steps 600ms: snapshot drift at step 2, 1 check failed, 1 slow step',
    '  step 2 click button "Go" -> /x:',
    '    @@ -1,1 +1,1 @@',
    '    -a',
    '    +b',
    '  check failed: text "hi": Text "hi" is not on the page',
    '  slow step 3 click button "Go": settled in 900ms, baseline 50ms',
    "  see it: pt run 'bb' --view --url 'http://fake/' --no-seed",
    'PASS  a   3/3 steps 600ms',
    '  not slow on a re-run, step 2 click button "Save": settled in 940ms, then 70ms on a re-run, baseline 60ms',
    '3 stories: 2 passed, 1 failed in 1.5s; report /tmp/report.md',
  ]);
  const md = checkMarkdown([rerun], { ms: 900, seeded: true, app: 'http://127.0.0.1:1', chrome: '1' });
  assert.match(md, /replayed again after seeding once \(300ms\)/);
  assert.match(md, /- step 2 `click button "Save"`: settled in 940ms, then 70ms on a re-run, baseline 60ms/);
});

// A browser whose steps settle in settle(step, run) ms; run counts pages opened.
function fakeRun(settle: (step: number, run: number) => number): { run: Run; pages: () => number; acts: number[] } {
  let pages = 0;
  const acts: number[] = [];
  const newPage = async (): Promise<Page> => {
    const n = ++pages;
    let step = 0;
    acts[n - 1] = 0;
    return {
      goto: async () => ({ ok: true, settleMs: 0, issues: [] }),
      act: async () => {
        acts[n - 1]++;
        return { ok: true, settleMs: settle(++step, n), issues: [] };
      },
      snapshot: async () => ({ url: 'http://fake/', title: '', text: '', lines: [`step ${step}`] }),
      check: async () => ({ ok: true }),
      fingerprint: async () => '',
      screenshot: async () => Buffer.alloc(0),
      close: async () => {},
    };
  };
  const run = {
    url: 'http://fake/', project: { config: { browser: { viewport: [1280, 800], widths: [1280] } } },
    browser: { version: '1', newPage, disconnect: async () => {} },
  } as unknown as Run;
  return { run, pages: () => pages, acts };
}

const fakeBaseline: Baseline = {
  version: 2,
  story: 'fake',
  url: 'http://fake/',
    seeded: false,
  platform: 'elsewhere',
  chrome: '0',
  harness: '0.1.0',
  viewport: [1280, 800],
  start: '/',
  startIssues: [],
  steps: [1, 2, 3, 4].map((n) => ({ action: { type: 'click', target: { role: 'button', name: `Go ${n}` } }, url: '/', snapshot: [`step ${n}`], fingerprint: '', settleMs: 50, issues: [] })),
  checks: [],
};

test('a step slow on the first run only passes after a re-run up to that step', async () => {
  const fake = fakeRun((step, run) => (step === 2 && run === 1 ? 940 : 50));
  const r = await checkStory(fake.run, fakeBaseline);
  assert.equal(r.status, 'pass');
  assert.deepEqual(r.slow, []);
  assert.equal(r.rerun?.runs, 1);
  assert.deepEqual(r.rerun?.cleared, [{ step: 2, action: 'click button "Go 2"', baselineMs: 50, ms: 940, rerunMs: [50] }]);
  assert.deepEqual(fake.acts, [4, 2]);
});

test('a step slow on every run fails after the re-runs', async () => {
  const fake = fakeRun((step, run) => (step === 3 ? 3050 : step === 1 && run === 1 ? 900 : 50));
  const r = await checkStory(fake.run, fakeBaseline);
  assert.equal(r.status, 'fail');
  assert.deepEqual(r.slow, [{ step: 3, action: 'click button "Go 3"', baselineMs: 50, ms: 3050, rerunMs: Array(SLOW_RERUNS).fill(3050) }]);
  assert.deepEqual(r.rerun?.cleared.map((s) => s.step), [1]);
  assert.equal(fake.pages(), 1 + SLOW_RERUNS);
});

test('no re-run when nothing is slow or the story fails anyway', async () => {
  const clean = fakeRun(() => 50);
  assert.equal((await checkStory(clean.run, fakeBaseline)).status, 'pass');
  assert.equal(clean.pages(), 1);
  const drifted = fakeRun((step) => (step === 2 ? 940 : 50));
  const r = await checkStory(drifted.run, { ...fakeBaseline, steps: fakeBaseline.steps.map((s, i) => (i === 0 ? { ...s, snapshot: ['other'] } : s)) });
  assert.equal(r.status, 'fail');
  assert.equal(r.slow.length, 1);
  assert.equal(r.rerun, undefined);
  assert.equal(drifted.pages(), 1);
});

test('drift that repeats on later steps is collapsed in the summary and the report', () => {
  const nav = ['@@ -5,2 +5,3 @@', '   link "Projects"', '+  link "Reports"', '   link "Plan"'];
  const navLater = ['@@ -9,2 +9,3 @@', ...nav.slice(1)];
  const other = ['@@ -20,1 +20,1 @@', '-heading "A"', '+heading "B"'];
  const r: StoryResult = {
    story: 'tour',
    status: 'fail',
    ms: 900,
    url: 'http://fake/',
    seeded: false,
    steps: 6,
    ran: 6,
    drift: [
      { step: 2, action: 'click button "Sign in"', url: '/projects', diff: nav },
      { step: 3, action: 'click link "Plan"', url: '/upgrade', diff: navLater },
      { step: 4, action: 'click link "Settings"', url: '/settings', diff: nav },
      { step: 5, action: 'click button "Save"', url: '/settings', diff: other },
      { step: 6, action: 'click link "Projects"', url: '/projects', diff: nav },
    ],
    checks: [],
    newIssues: [],
    slow: [],
    visual: [],
    visualCompared: true,
  };
  const summary = checkSummary([r], 900, '/tmp/report.md');
  assert.ok(summary.includes('  also drifted the same way: steps 3, 4, 6'));
  assert.ok(summary.includes('  also drifted differently: steps 5'));
  const md = checkMarkdown([r], { ms: 900, seeded: true, app: 'http://127.0.0.1:1', chrome: '1' });
  assert.equal(md.match(/^### Step/gm)?.length, 2);
  assert.match(md, /### Step 2: .*\n\nThe same change again at steps 3, 4, 6\./);
  assert.match(md, /### Step 5: /);
});

test('step lists name runs as ranges', () => {
  assert.equal(stepList([3, 4, 5, 7, 9, 10]), '3-5, 7, 9, 10');
  assert.equal(stepList([2]), '2');
});
