import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { CHROME_VERSION, connectBrowser, isRunning, launchBrowser, stopBrowser, type LaunchedBrowser } from '../src/browser/index.ts';
import { decodePngGrey } from '../src/browser/fingerprint.ts';
import type { Browser, Page, PageOptions } from '../src/types.ts';
import { startSampleApp } from '../tools/spike-replay.ts';

type App = Awaited<ReturnType<typeof startSampleApp>>;

let clean: App;
let buggy: App;
let launched: LaunchedBrowser;
let browser: Browser;
const pages: Page[] = [];

const options = (app: App, extra: Partial<PageOptions> = {}): PageOptions => ({
  baseUrl: app.baseUrl,
  viewport: [1280, 800],
  widths: [420, 1280],
  clock: '2026-04-01T12:00:00Z',
  ...extra,
});

async function open(app: App, extra: Partial<PageOptions> = {}): Promise<Page> {
  const page = await browser.newPage(options(app, extra));
  pages.push(page);
  return page;
}

async function signIn(app: App, extra: Partial<PageOptions> = {}): Promise<Page> {
  await fetch(`${app.baseUrl}/__test/reset`, { method: 'POST' });
  const page = await open(app, extra);
  assert.equal((await page.goto('/login')).ok, true);
  assert.equal((await page.act({ type: 'fill', target: { role: 'textbox', name: 'Email' }, value: 'admin@example.test' })).ok, true);
  assert.equal((await page.act({ type: 'fill', target: { role: 'textbox', name: 'Password' }, value: 'admin-pass-1' })).ok, true);
  return page;
}

before(async () => {
  // Sequential: each picks the next free port in 5320-5329.
  clean = await startSampleApp();
  buggy = await startSampleApp({ BUGS: 'overlap,clipped,console-error,slow' });
  launched = await launchBrowser();
  browser = await connectBrowser(launched.wsUrl);
});

after(async () => {
  await Promise.all(pages.map((p) => p.close()));
  await browser?.disconnect();
  if (launched) await stopBrowser(launched);
  await Promise.all([clean?.stop(), buggy?.stop()]);
});

describe('browser process', () => {
  test('launches the pinned version detached and reports its socket', () => {
    if (!process.env.PLAYTEST_CHROME) assert.equal(launched.version, CHROME_VERSION);
    assert.equal(browser.version, launched.version);
    assert.match(launched.wsUrl, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);
    assert.equal(isRunning(launched.pid), true);
  });

  test('stopBrowser ends the process', async () => {
    const extra = await launchBrowser();
    await stopBrowser(extra);
    assert.equal(isRunning(extra.pid), false);
  });
});

describe('snapshot and actions', () => {
  test('login page snapshot: model form has refs, normalized form does not', async () => {
    await fetch(`${clean.baseUrl}/__test/reset`, { method: 'POST' });
    const page = await open(clean);
    await page.goto('/login');
    const snap = await page.snapshot();
    assert.equal(snap.title, 'Tracker');
    assert.equal(snap.url, `${clean.baseUrl}/login`);
    assert.deepEqual(snap.lines, [
      'main',
      '  heading "Sign in" level=1',
      '  textbox "Email"',
      '  textbox "Password"',
      '  button "Sign in" disabled',
    ]);
    assert.match(snap.text, /^ {2}\[e\d+\] textbox "Email"$/m);
    assert.doesNotMatch(snap.lines.join('\n'), /\[e\d+\]|focused/);
  });

  test('sign in by ref and locator, then checks', async () => {
    await fetch(`${clean.baseUrl}/__test/reset`, { method: 'POST' });
    const page = await open(clean);
    await page.goto('/login');
    const snap = await page.snapshot();
    const ref = /\[(e\d+)\] textbox "Email"/.exec(snap.text)![1];
    const filled = await page.act({ type: 'fill', target: { ref }, value: 'admin@example.test' });
    assert.deepEqual(filled.locator, { role: 'textbox', name: 'Email' });
    await page.act({ type: 'fill', target: { role: 'textbox', name: 'Password' }, value: 'admin-pass-1' });
    assert.deepEqual(await page.check({ type: 'value', locator: { role: 'textbox', name: 'Email' }, value: 'admin@example.test' }), { ok: true });
    const clicked = await page.act({ type: 'press', key: 'Enter', target: { role: 'textbox', name: 'Password' } });
    assert.equal(clicked.ok, true, clicked.error);
    assert.deepEqual(await page.check({ type: 'url', value: '/projects' }), { ok: true });
    assert.deepEqual(await page.check({ type: 'text', value: '34 projects' }), { ok: true });
    assert.deepEqual(await page.check({ type: 'element', locator: { role: 'link', name: 'Northern Onboarding' } }), { ok: true });
    assert.deepEqual(await page.check({ type: 'absent', locator: { role: 'heading', name: 'Sign in' } }), { ok: true });
    const missing = await page.check({ type: 'element', locator: { role: 'button', name: 'Nope' } });
    assert.equal(missing.ok, false);
    assert.match(missing.detail!, /No button "Nope"/);
  });

  test('fill, select, clear, paginate, open, add a task, toggle, back', async () => {
    const page = await signIn(clean);
    await page.act({ type: 'click', target: { role: 'button', name: 'Sign in' } });
    const search = { role: 'searchbox', name: 'Search projects' };
    assert.equal((await page.act({ type: 'fill', target: search, value: 'Northern' })).ok, true);
    assert.equal((await page.act({ type: 'select', target: { role: 'combobox', name: 'Status' }, option: 'Active' })).ok, true);
    assert.deepEqual(await page.check({ type: 'url', value: 'q=Northern&status=active' }), { ok: true });
    assert.deepEqual(await page.check({ type: 'value', locator: { role: 'combobox', name: 'Status' }, value: 'Active' }), { ok: true });
    const badOption = await page.act({ type: 'select', target: { role: 'combobox', name: 'Status' }, option: 'Frozen' });
    assert.equal(badOption.ok, false);
    assert.match(badOption.error!, /no option "Frozen"/);
    await page.act({ type: 'select', target: { role: 'combobox', name: 'Status' }, option: 'All statuses' });
    await page.act({ type: 'fill', target: search, value: '' });
    assert.deepEqual(await page.check({ type: 'value', locator: search, value: '' }), { ok: true });
    await page.act({ type: 'click', target: { role: 'button', name: 'Next' } });
    assert.deepEqual(await page.check({ type: 'text', value: 'Page 2 of 4' }), { ok: true });
    await page.act({ type: 'click', target: { role: 'button', name: 'Previous' } });
    await page.act({ type: 'click', target: { role: 'link', name: 'Northern Onboarding' } });
    await page.act({ type: 'click', target: { role: 'button', name: 'New task' } });
    const dialog = (await page.snapshot()).lines;
    assert.ok(dialog.some((l) => /dialog "New task" modal/.test(l)), dialog.join('\n'));
    await page.act({ type: 'fill', target: { role: 'textbox', name: 'Title' }, value: 'Write launch email' });
    await page.act({ type: 'fill', target: { role: 'Date', name: 'Due date' }, value: '2026-04-15' });
    await page.act({ type: 'select', target: { role: 'combobox', name: 'Priority' }, option: 'High' });
    const saved = await page.act({ type: 'click', target: { role: 'button', name: 'Save task' } });
    assert.equal(saved.ok, true, saved.error);
    const box = { role: 'checkbox', name: 'Mark "Write launch email" complete' };
    assert.deepEqual(await page.check({ type: 'element', locator: box }), { ok: true });
    assert.deepEqual(await page.check({ type: 'text', value: 'Priority high · Due 2026-04-15' }), { ok: true }, (await page.snapshot()).lines.join('\n'));
    await page.act({ type: 'click', target: box });
    assert.deepEqual(await page.check({ type: 'value', locator: box, value: 'true' }), { ok: true });
    const back = await page.act({ type: 'back' });
    assert.equal(back.ok, true, back.error);
    assert.deepEqual(await page.check({ type: 'url', value: '/projects' }), { ok: true });
    const scrolled = await page.act({ type: 'scroll', direction: 'down' });
    assert.equal(scrolled.ok, true);
    const hovered = await page.act({ type: 'hover', target: { role: 'button', name: 'Sign out' } });
    assert.equal(hovered.ok, true, hovered.error);
    const nav = await page.act({ type: 'navigate', url: '/settings' });
    assert.equal(nav.ok, true);
    assert.deepEqual(await page.check({ type: 'value', locator: { role: 'switch', name: 'Email notifications' }, value: 'true' }), { ok: true });
  });

  test('a locator that does not resolve and an unknown ref fail without throwing', async () => {
    const page = await open(clean);
    await page.goto('/login');
    const r = await page.act({ type: 'click', target: { role: 'button', name: 'Launch' } });
    assert.equal(r.ok, false);
    assert.match(r.error!, /No button "Launch"/);
    const s = await page.act({ type: 'click', target: { ref: 'e999' } });
    assert.equal(s.ok, false);
    assert.match(s.error!, /Unknown ref e999/);
  });

  test('duplicate names get nth in the recorded locator', async () => {
    const page = await open(clean, { widths: [400] });
    const html = '<button onclick="document.title=1">Go</button><button onclick="document.title=2">Go</button><button>Stop</button>';
    await page.goto(`data:text/html,${encodeURIComponent(html)}`);
    const snap = await page.snapshot();
    const second = [...snap.text.matchAll(/\[(e\d+)\] button "Go"/g)][1][1];
    const byRef = await page.act({ type: 'click', target: { ref: second } });
    assert.deepEqual(byRef.locator, { role: 'button', name: 'Go', nth: 1 });
    assert.equal((await page.snapshot()).title, '2');
    const first = await page.act({ type: 'click', target: { role: 'button', name: 'Go', nth: 0 } });
    assert.deepEqual(first.locator, { role: 'button', name: 'Go', nth: 0 });
    assert.equal((await page.snapshot()).title, '1');
    const unique = await page.act({ type: 'click', target: { role: 'button', name: 'Stop' } });
    assert.deepEqual(unique.locator, { role: 'button', name: 'Stop' });
  });

  test('actor pages are bounded, preserve full evidence and prioritize dialog controls', async () => {
    const page = await open(clean);
    const long = 'Exact label ' + 'long '.repeat(100) + 'END';
    const html = Array.from({ length: 300 }, (_, i) => `<button>Item ${i}</button>`).join('') + `<dialog open><h1>Confirm</h1><button>${long}</button><button>Save dialog</button></dialog>`;
    await page.goto(`data:text/html,${encodeURIComponent(html)}`);
    const before = await page.snapshot();
    const actor = await page.snapshot({ actor: true });
    assert.ok(Buffer.byteLength(actor.text) < 8000);
    assert.ok([...actor.text.matchAll(/\[e\d+\]/g)].length <= 200);
    assert.match(actor.text, /Save dialog/);
    assert.ok(actor.rawText!.includes(long));
    assert.deepEqual(actor.lines, before.lines);
    assert.deepEqual((await page.snapshot()).lines, before.lines);
    const old = /\[(e\d+)\] button "Item 0"/.exec(actor.rawText!)![1];
    await page.goto(`data:text/html,${encodeURIComponent('<button>Item 0</button>')}`);
    await page.snapshot();
    const result = await page.act({ type: 'click', target: { ref: old } });
    assert.equal(result.ok, false);
    assert.match(result.error!, /Unknown ref/);
  });
});

describe('settle', () => {
  test('is capped by settleCapMs', async () => {
    const page = await signIn(buggy, { settleCapMs: 400, viewport: [1280, 800], widths: [1280] });
    await page.act({ type: 'click', target: { role: 'button', name: 'Sign in' } });
    const r = await page.act({ type: 'click', target: { role: 'link', name: 'Northern Onboarding' } });
    assert.equal(r.ok, true);
    assert.ok(r.settleMs >= 400 && r.settleMs < 1500, `settleMs ${r.settleMs}`);
    assert.ok((await page.snapshot()).lines.some((l) => l.includes('Loading tasks')));
  });

  test('waits for slow requests below the cap', async () => {
    const page = await signIn(buggy, { widths: [1280] });
    await page.act({ type: 'click', target: { role: 'button', name: 'Sign in' } });
    const r = await page.act({ type: 'click', target: { role: 'link', name: 'Northern Onboarding' } });
    assert.ok(r.settleMs >= 3000 && r.settleMs < 4500, `settleMs ${r.settleMs}`);
    assert.ok(!(await page.snapshot()).lines.some((l) => l.includes('Loading tasks')));
  });
});

describe('telemetry and layout checks', () => {
  test('covered click at 420 names the covering element', async () => {
    const page = await signIn(buggy, { viewport: [420, 800] });
    await page.act({ type: 'click', target: { role: 'button', name: 'Sign in' } });
    const r = await page.act({ type: 'click', target: { role: 'link', name: 'New project' } });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'link "New project" is covered by button "Feedback"');
  });

  test('planted bugs show up as issues with stable keys', async () => {
    const page = await signIn(buggy);
    const r = await page.act({ type: 'click', target: { role: 'button', name: 'Sign in' } });
    const keys = r.issues.map((i) => i.key);
    assert.ok(keys.includes('console|/projects||TypeError: Cannot read properties of undefined (reading "sparkline") at ProjectCard'), keys.join('\n'));
    assert.ok(keys.includes('covered|/projects|420|link "New project" by button "Feedback"'), keys.join('\n'));
    const clipped = r.issues.filter((i) => i.kind === 'content-overflow' && i.width === 1280);
    assert.equal(clipped.length, 1, keys.join('\n'));
    assert.match(clipped[0].key, /^content-overflow\|\/projects\|1280\|heading "Cross-functional customer onboarding/);
    assert.ok(r.issues.some((i) => i.kind === 'page-overflow' && i.width === 420));

    const page2 = await signIn(buggy);
    const r2 = await page2.act({ type: 'click', target: { role: 'button', name: 'Sign in' } });
    assert.deepEqual(r2.issues.map((i) => i.key), keys);
  });

  test('layout checks run once per path; console errors repeat per occurrence', async () => {
    const page = await signIn(buggy, { widths: [1280] });
    await page.act({ type: 'click', target: { role: 'button', name: 'Sign in' } });
    const again = await page.act({ type: 'click', target: { role: 'button', name: 'Next' } });
    assert.deepEqual(again.issues.map((i) => i.kind), []);
    const back = await page.act({ type: 'navigate', url: '/projects' });
    assert.deepEqual(back.issues.map((i) => i.kind), ['console']);
  });

  test('failed requests are issues', async () => {
    const page = await signIn(clean, { widths: [1280] });
    await page.act({ type: 'click', target: { role: 'button', name: 'Sign in' } });
    const r = await page.act({ type: 'navigate', url: '/projects/prj-031' });
    assert.ok(r.issues.some((i) => i.key === 'request|/projects/prj-031||GET /api/projects/prj-031/tasks 500'), r.issues.map((i) => i.key).join('\n'));
  });

  test('a clean app has no layout issues on /projects at 420 and 1280', async () => {
    const page = await signIn(clean);
    const r = await page.act({ type: 'click', target: { role: 'button', name: 'Sign in' } });
    assert.deepEqual(r.issues, []);
  });
});

describe('determinism and pixels', () => {
  async function run(): Promise<{ lines: string[][]; fingerprints: string[] }> {
    const page = await signIn(clean);
    const out = { lines: [] as string[][], fingerprints: [] as string[] };
    for (const action of [
      { type: 'click', target: { role: 'button', name: 'Sign in' } },
      { type: 'click', target: { role: 'link', name: 'Northern Onboarding' } },
      { type: 'click', target: { role: 'button', name: 'New task' } },
    ] as const) {
      assert.equal((await page.act(action)).ok, true);
      out.lines.push((await page.snapshot()).lines);
      out.fingerprints.push(await page.fingerprint());
    }
    return out;
  }

  test('the same steps give identical snapshot lines and fingerprints', async () => {
    const a = await run();
    const b = await run();
    assert.deepEqual(b.lines, a.lines);
    assert.deepEqual(b.fingerprints, a.fingerprints);
    assert.match(a.fingerprints[0], /^[0-9a-f]{80}$/);
    assert.notEqual(a.fingerprints[1], a.fingerprints[2]);
  });

  test('clock is frozen and screenshots are PNGs of the right size', async () => {
    const page = await open(clean, { viewport: [400, 300] });
    const html = '<title>t</title><script>document.title = new Date().toISOString() + " " + Date.now()</script><div style="height:900px">x</div>';
    await page.goto(`data:text/html,${encodeURIComponent(html)}`);
    const snap = await page.snapshot();
    assert.equal(snap.title, `2026-04-01T12:00:00.000Z ${Date.parse('2026-04-01T12:00:00Z')}`);
    const shot = await page.screenshot();
    assert.deepEqual([shot.readUInt32BE(16), shot.readUInt32BE(20)], [400, 300]);
    const full = await page.screenshot({ fullPage: true });
    assert.ok(full.readUInt32BE(20) >= 900);
  });

  test('a full-page screenshot draws a fixed overlay over the whole page, then restores the viewport', async () => {
    const page = await open(clean, { viewport: [400, 300] });
    const html = '<body style="margin:0;background:#fff"><div style="height:900px">x</div><div style="position:fixed;inset:0;background:#000"></div></body>';
    await page.goto(`data:text/html,${encodeURIComponent(html)}`);
    const grey = decodePngGrey(await page.screenshot({ fullPage: true }));
    assert.equal(grey.height, 900);
    assert.ok(grey.pixels[850 * grey.width + 200] < 10, 'the overlay reaches the bottom of the page');
    const shot = await page.screenshot();
    assert.deepEqual([shot.readUInt32BE(16), shot.readUInt32BE(20)], [400, 300]);
  });
});
