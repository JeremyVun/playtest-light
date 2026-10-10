import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { launchBrowser, connectBrowser, stopBrowser } from '../src/browser/index.ts';
import { waitUntil } from '../src/browser/wait.ts';
import { startSlowChat } from '../fixtures/slow-chat/server.ts';
import { Actor } from '../src/run/actor.ts';
import { orderAction } from '../src/run/baseline.ts';
import type { Action, Browser, Page } from '../src/types.ts';

let app: Awaited<ReturnType<typeof startSlowChat>>;
let launched: Awaited<ReturnType<typeof launchBrowser>>;
let browser: Browser;
const until = [{ type: 'enabled', locator: { role: 'button', name: 'Send' } }, { type: 'text', value: 'Your request is complete.' }] as const;
const wait = (timeoutMs = 3000): Extract<Action, { type: 'wait' }> => ({ type: 'wait', until: [...until], timeoutMs });
async function open() {
  const page = await browser.newPage({ baseUrl: app.url, viewport: [1280, 800], widths: [1280], settleCapMs: 50 });
  await page.goto('/');
  return page;
}
async function submit(page: Page) {
  await page.act({ type: 'fill', target: { role: 'textbox', name: 'Message' }, value: 'Please respond' });
  await page.act({ type: 'press', key: 'Enter', target: { role: 'textbox', name: 'Message' } });
}
before(async () => { app = await startSlowChat(1200); launched = await launchBrowser(); browser = await connectBrowser(launched.wsUrl); });
after(async () => { await browser?.disconnect(); if (launched) await stopBrowser(launched); await app?.close(); });

test('waits for streamed completion while other harness work continues, then replays the same condition', async () => {
  const page = await open();
  let beats = 0;
  const heartbeat = setInterval(() => { beats++; }, 20);
  try {
    await submit(page);
    assert.equal((await page.check({ type: 'disabled', locator: { role: 'button', name: 'Send' } })).ok, true);
    const result = await page.act(wait());
    assert.equal(result.ok, true, result.error);
    assert.ok(result.waitMs! > 800);
    assert.equal(result.settleMs, 0);
    assert.ok(beats > 20, `only ${beats} timer callbacks during wait`);
    const saved = JSON.parse(JSON.stringify(orderAction(wait())));
    await page.goto('/');
    await submit(page);
    assert.equal((await page.act(saved)).ok, true);
  } finally { clearInterval(heartbeat); await page.close(); }
});

test('timeout does not resubmit, navigate or claim success', async () => {
  const page = await open();
  try {
    const before = app.submissions;
    await submit(page);
    const result = await page.act(wait(80));
    assert.equal(result.ok, false);
    assert.match(result.error!, /timed out/);
    assert.equal(app.submissions, before + 1);
    assert.equal((await page.snapshot()).url, app.url + '/');
  } finally { await page.close(); }
});

test('navigation cannot satisfy a disappeared spinner', async () => {
  const page = await open();
  try {
    await submit(page);
    const waiting = page.act({ type: 'wait', until: [{ type: 'absent', locator: { role: 'status', name: 'Generating' } }], timeoutMs: 3000 });
    await delay(30);
    await page.goto('/other');
    const result = await waiting;
    assert.equal(result.ok, false);
    assert.match(result.error!, /navigated/);
  } finally { await page.close(); }
});

test('closing a page promptly cancels a twenty-minute wait', async () => {
  const page = await open();
  const waiting = page.act(wait(1_200_000));
  await delay(30);
  await page.close();
  const result = await waiting;
  assert.equal(result.ok, false);
  assert.match(result.error!, /closed|cancelled/);
  assert.ok(result.waitMs! < 1000);
});

test('a stuck browser read is bounded and transient matches do not finish a wait', async () => {
  const stuck = await waitUntil(() => new Promise(() => {}), 30, new AbortController().signal);
  assert.equal(stuck.ok, false);
  assert.match(stuck.error!, /timed out/);
  let reads = 0;
  const transient = await waitUntil(async () => ++reads === 1, 300, new AbortController().signal);
  assert.equal(transient.ok, false);
  assert.equal(reads, 2);
});

test('the actor queues long waits without holding its tool call open', async () => {
  let actions = 0;
  const actor = new Actor({ act: async () => { actions++; } } as unknown as Page);
  const text = await actor.handle('wait_for', { until: [...until], timeoutSeconds: 1200 });
  assert.match(text, /queued.*1200/);
  assert.equal(actions, 0);
  const queued = actor.takeWait()!;
  assert.deepEqual(queued.actions[0], wait(1_200_000));
  assert.equal(actor.takeWait(), undefined);
  assert.match(await actor.handle('wait_for', { until: [], timeoutSeconds: 1200 }), /1–8/);
  assert.match(await actor.handle('act', { actions: [wait()] }), /Use wait_for/);
});
