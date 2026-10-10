import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { launchBrowser, stopBrowser } from '../src/browser/index.ts';
import { Connection } from '../src/browser/cdp.ts';
import { runHtml, type RunView } from '../src/run/view-html.ts';

const attack = '</script><script>globalThis.injected=true</script><img src=x onerror="globalThis.injected=true">';
const view: RunView = {
  title: 'Run <debug>', url: 'https://example.test/', status: 'fail', summary: [attack],
  totalMs: 3500,
  model: [
    { id: 'd1', usage: { input: 7281, cached: 6000, output: 120, reasoning: 0 } },
    { id: 'd2', usage: { input: 7500, cached: 6000, output: 80, reasoning: 0 } },
    { id: 'd3' },
  ],
  stories: [
    { name: 'Passed story', status: 'pass', ms: 2000, steps: 1, reason: 'Matched baseline', sectionIds: ['s2'] },
    { name: 'Failed story', status: 'fail', ms: 1300, steps: 1, reason: '1 failed check', sectionIds: ['s1'], focusStep: 1 },
    { name: 'Could not start', status: 'error', ms: 100, reason: 'Seed failed', sectionIds: [] },
    { name: 'Unfinished story', status: 'not-run', reason: 'Not run', sectionIds: [] },
  ],
  sections: [
    { id: 's1', label: 'Original exploration', frames: [
      { step: 0, action: 'Open page', url: '/', snapshot: ['heading "Home"'], issues: [], checks: [], diff: [], ms: 0, durationMs: 0, screenshot: 'capture.png' },
      { step: 1, action: attack, url: '/next', snapshot: [attack], issues: ['GET /api 500'], checks: ['PASS page loaded', 'FAIL saved item'], diff: ['- before', '+ after'], error: 'Save failed', ms: 1250, durationMs: 1500, screenshot: 'javascript:alert(1)', decisions: ['d1'] },
    ] },
    { id: 's2', label: 'Exploration: reproduction', frames: [{ step: 1, action: 'Reopened', url: '/', snapshot: [], issues: [], checks: [], diff: [], screenshot: 'missing.png', decisions: ['d1', 'd2', 'd3'] }] },
  ],
  findings: [{ id: 'F1', title: attack, kind: 'bug', severity: 'high', reproduced: false, expected: 'Saved', actual: 'Error', confirmation: 'Did not repeat', at: 1, story: '# Draft\n' + attack }],
  details: attack, links: [{ label: 'Unsafe', href: 'javascript:alert(1)' }, { label: 'Report', href: 'report.json' }],
};

test('static viewer works under file URLs, escapes app text, navigates phases and handles missing evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-view-test-'));
  const html = runHtml(view);
  assert.doesNotMatch(html, /<(?:details|summary)\b|aria-expanded=/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.doesNotMatch(html, /(?:src|href)="https?:/);
  const file = join(dir, 'index.html');
  writeFileSync(file, html);
  const browser = await launchBrowser();
  const c = await Connection.open(browser.wsUrl);
  try {
    const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method: string, params: object = {}) => c.send(method, params, sessionId);
    const evaluate = async (expression: string) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.text);
      return result.result.value;
    };
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    const capture = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(dir, 'capture.png'), Buffer.from(capture.data, 'base64'));
    const loaded = new Promise<void>((resolve) => { const off = c.on('Page.loadEventFired', () => { off(); resolve(); }, sessionId); });
    await send('Page.navigate', { url: pathToFileURL(file).href });
    await loaded;
    assert.equal(await evaluate('globalThis.injected === undefined'), true);
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".model-summary dd")].map(e=>e.textContent)'), ['7,500+', '14,781+', '200+']);
    assert.match(await evaluate('document.querySelector(".model-summary").textContent'), /Usage unavailable for 1 of 3/);
    assert.equal(await evaluate('document.querySelector("#panel-results").hidden'), false);
    for (const width of [1904, 1280, 420, 320]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `results overflow at ${width}px`);
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    assert.equal(await evaluate('document.querySelector(".result-row").dataset.result'), '1');
    assert.match(await evaluate('document.querySelectorAll("[data-result]").item(2).textContent'), /Slowest/);
    assert.equal(await evaluate('document.querySelectorAll("[data-result]").item(3).disabled'), true);
    await evaluate('document.querySelectorAll("[data-result]").item(1).click()');
    assert.equal(await evaluate('document.querySelector("#panel-debug").hidden'), false);
    await evaluate('document.querySelector("#tab-results").click()');
    await evaluate('document.querySelectorAll("[data-result]").item(0).click()');
    assert.equal(await evaluate('location.hash'), '#0:1');
    assert.equal(await evaluate('document.querySelector("#frame").classList.contains("no-shot")'), true);
    await evaluate('document.querySelector("#prev").click()');
    assert.equal(await evaluate('document.querySelector("#action").textContent'), 'Open page');
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".duration")].map(e=>e.textContent)'), ['0 ms', '1.5 s']);
    assert.match(await evaluate('document.querySelector("#step-1").getAttribute("aria-label")'), /Step took 1500 ms · 1250 ms settling/);
    await evaluate('document.querySelector("#shot").decode()');
    for (const width of [1904, 1280, 768, 420, 320]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `overflow at ${width}px`);
      assert.equal(await evaluate('document.querySelector("#film").getBoundingClientRect().bottom <= innerHeight'), true);
      assert.equal(await evaluate('document.querySelector("#shot").getBoundingClientRect().bottom <= document.querySelector("#stage").getBoundingClientRect().bottom + 1'), true);
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    assert.equal(await evaluate('document.querySelector("#shot").getBoundingClientRect().height > 500'), true, 'capture should use the available vertical space');
    await evaluate('document.querySelector("#zoom").value="actual";document.querySelector("#zoom").dispatchEvent(new Event("change"))');
    assert.equal(await evaluate('document.querySelector("#shot").getBoundingClientRect().width'), 1280);
    assert.equal(await evaluate('document.querySelector("#stage").scrollWidth > document.querySelector("#stage").clientWidth'), true);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    await evaluate('document.querySelector("#zoom").value="width";document.querySelector("#zoom").dispatchEvent(new Event("change"))');
    assert.equal(await evaluate('Math.abs(document.querySelector("#shot").getBoundingClientRect().width-document.querySelector("#stage").clientWidth)<1'), true);
    assert.equal(await evaluate('document.querySelector("#checks").parentElement.hidden'), true);
    assert.equal(await evaluate('document.querySelector("#no-evidence").hidden'), false);
    await evaluate('document.querySelector("#next").click()');
    assert.equal(await evaluate('document.querySelector("#action").textContent'), attack);
    assert.equal(await evaluate('location.hash'), '#0:1');
    assert.equal(await evaluate('document.querySelector("#shot").hasAttribute("src")'), false);
    assert.equal(await evaluate('document.querySelector("#frame").classList.contains("no-shot")'), true);
    assert.equal(await evaluate('document.querySelector("#panel-run pre")'), null);
    assert.equal(await evaluate('document.querySelector("#diff").textContent'), '- before\n+ after');
    const key = async (key: string, code: number) => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: code });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code });
    };
    await evaluate('document.querySelector("#steps [aria-selected=true]").focus()');
    await key('Home', 36);
    assert.equal(await evaluate('location.hash'), '#0:0');
    assert.equal(await evaluate('document.activeElement.id'), 'step-0');
    await key('ArrowRight', 39);
    assert.equal(await evaluate('location.hash'), '#0:1');
    assert.equal(await evaluate('document.activeElement.id'), 'step-1');
    await key('ArrowLeft', 37);
    await key('End', 35);
    assert.equal(await evaluate('location.hash'), '#0:1');
    assert.equal(await evaluate('[...document.querySelectorAll("#steps button")].filter(b=>b.tabIndex===0).length'), 1);
    assert.match(await evaluate('document.querySelector("#checks li").textContent'), /^FAILED/);
    await evaluate('document.querySelector("#inspect-diff").click()');
    assert.equal(await evaluate('document.activeElement.id'), 'debug-diff');
    await evaluate('document.querySelector("#tab-run").click()');
    await evaluate('document.querySelector("#inspect-step").click()');
    assert.equal(await evaluate('document.querySelector("#panel-debug").hidden'), false);
    assert.equal(await evaluate('document.querySelector("#raw-action").textContent'), attack);
    assert.equal(await evaluate('document.querySelector("#snapshot").textContent'), attack);
    assert.equal(await evaluate('document.activeElement.id'), 'step-debug');
    await evaluate('document.querySelector("#tab-run").click()');
    await evaluate('document.querySelector("#tab-run").focus()');
    await key('ArrowRight', 39);
    assert.equal(await evaluate('document.activeElement.id'), 'tab-findings');
    assert.equal(await evaluate('document.querySelector("#panel-findings").hidden'), false);
    assert.equal(await evaluate('document.querySelector("#panel-run").hidden'), true);
    await key('End', 35);
    assert.equal(await evaluate('document.activeElement.id'), 'tab-debug');
    assert.equal(await evaluate(`(async()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{globalThis.copied=text}}});await document.querySelector('#panel-debug > .copy-box .copy-button').onclick();return globalThis.copied})()`), attack);
    assert.equal(await evaluate('document.querySelector("#panel-debug > .copy-box .copy-button").classList.contains("copied")'), true);
    assert.equal(await evaluate(`(async()=>{navigator.clipboard.writeText=async()=>{throw new Error('Blocked')};document.execCommand=()=>{globalThis.copied=document.querySelector('textarea').value;return true};await document.querySelector('#panel-debug > .copy-box .copy-button').onclick();return globalThis.copied})()`), attack);
    assert.equal(await evaluate('document.querySelector("textarea")'), null);
    await evaluate(`(async()=>{document.execCommand=()=>false;await document.querySelector('#panel-debug > .copy-box .copy-button').onclick()})()`);
    assert.equal(await evaluate('document.querySelector("#panel-debug > .copy-box .copy-button").classList.contains("error")'), true);
    await evaluate('document.querySelector("#tab-debug").focus()');
    assert.equal(await evaluate('document.querySelector("#panel-debug").hidden'), false);
    await key('Home', 36);
    assert.equal(await evaluate('document.querySelector("#panel-results").hidden'), false);
    await key('ArrowRight', 39);
    assert.equal(await evaluate('document.querySelector("#panel-run").hidden'), false);
    await key('Tab', 9);
    assert.equal(await evaluate('document.activeElement.id'), 'section');
    await evaluate('document.querySelector("#tab-findings").click()');
    await evaluate('document.querySelector("[data-story]").click()');
    assert.equal(await evaluate('document.querySelector("#panel-debug").hidden'), false);
    assert.equal(await evaluate('document.activeElement.id'), 'story-F1');
    await evaluate('document.querySelector("#tab-findings").click()');
    await evaluate('document.querySelector(".jump").click()');
    assert.equal(await evaluate('location.hash'), '#1:0');
    assert.equal(await evaluate('document.querySelector(".duration").textContent'), '—');
    assert.match(await evaluate('document.querySelector(".duration").title'), /not recorded/);
    assert.equal(await evaluate('document.querySelector("#action").textContent'), 'Reopened');
    await evaluate('new Promise(resolve => setTimeout(resolve, 50))');
    assert.equal(await evaluate('document.querySelector("#missing").textContent'), 'Screenshot file is missing.');
    for (const width of [1280, 420]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `overflow at ${width}px`);
    }
    assert.equal(await evaluate('document.querySelector(".finding").textContent.includes("Not reproduced")'), true);
    writeFileSync(file, runHtml({ ...view, sections: [], findings: [], model: [] }));
    const reload = new Promise<void>((resolve) => { const off = c.on('Page.loadEventFired', () => { off(); resolve(); }, sessionId); });
    await send('Page.reload');
    await reload;
    assert.equal(await evaluate('document.querySelector("#empty").hidden'), false);
    assert.equal(await evaluate('document.querySelector(".model-summary").textContent'), 'No model used');
    assert.equal(await evaluate('document.querySelector("#tab-findings")'), null);
  } finally { await c.close(); await stopBrowser(browser); rmSync(dir, { recursive: true, force: true }); }
});
