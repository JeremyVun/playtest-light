// Usage: node tools/capture-view.ts <index.html> <output.png> [width=1280] [height=900] [hash=0:0] [scheme=light] [scale=1] [view=run]
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Connection } from '../src/browser/cdp.ts';
import { launchBrowser, stopBrowser } from '../src/browser/index.ts';

const [file, output, widthText = '1280', heightText = '900', hash = '0:0', scheme = 'light', scale = '1', view = 'run'] = process.argv.slice(2);
if (!file || !output) throw new Error('Pass an HTML run view and output PNG path.');
const width = Number(widthText), height = Number(heightText);
if (!['results', 'run', 'findings', 'debug'].includes(view) || !['light', 'dark'].includes(scheme)) throw new Error('Invalid view or color scheme.');
if (![width, height, Number(scale)].every(n => Number.isFinite(n) && n > 0)) throw new Error('Dimensions and scale must be positive numbers.');
const browser = await launchBrowser();
const c = await Connection.open(browser.wsUrl);
try {
  const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method: string, params: object = {}) => c.send(method, params, sessionId);
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: Number(scale), mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  const loaded = new Promise<void>((resolve) => { const off = c.on('Page.loadEventFired', () => { off(); resolve(); }, sessionId); });
  await send('Page.navigate', { url: pathToFileURL(resolve(file)).href + '#' + hash });
  await loaded;
  await send('Runtime.evaluate', { expression: `document.querySelector('[data-view="${view}"]')?.click(); Promise.all([...document.images].filter(i=>i.offsetParent).map(i=>i.decode().catch(()=>{})))`, awaitPromise: true });
  const { result } = await send('Runtime.evaluate', { expression: '({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,frames:document.querySelectorAll("#steps button").length})', returnByValue: true });
  if (result.value.width !== width || result.value.height !== height) throw new Error('Viewport does not match.');
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(output, Buffer.from(data, 'base64'));
  console.log(JSON.stringify({ ...result.value, output: resolve(output) }));
} finally { await c.close(); await stopBrowser(browser); }
