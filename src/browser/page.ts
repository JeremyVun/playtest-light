import type { Action, ActResult, Check, CheckResult, Issue, IssueKind, Locator, Page, PageOptions, Snapshot, Target } from '../types.ts';
import { CdpError, CONNECTION_CLOSED, session, type Connection, type Session } from './cdp.ts';
import { fingerprintOf } from './fingerprint.ts';
import { bootScript, pageLib, type LayoutFinding } from './inpage.ts';
import { waitUntil } from './wait.ts';
import { keyEvents } from './keys.ts';
import { buildEntries, collapse, findEntry, indexLocators, normalizedLines, type AXNode, type Entry } from './snapshot.ts';

const LIB = pageLib.toString();
const QUIET_MS = Number(process.env.PLAYTEST_QUIET_MS ?? 50);
const FINGERPRINT_SCALE = 0.25;

class ActionError extends Error {}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export type ActTimings = { actionMs: number; settleMs: number; layoutMs: number };
const timings = new WeakMap<Page, ActTimings>();

// Phase timings of the page's last successful act or goto, for speed reports.
export function lastActTimings(page: Page): ActTimings | undefined {
  return timings.get(page);
}

type Resolved = { objectId: string; locator: Locator; label: string };

// Explore's narrow-screen phase.
export async function resizePage(page: Page, viewport: [number, number]): Promise<void> {
  if (!(page instanceof CdpPage)) throw new Error('only a CDP page can be resized');
  await page.resize(viewport);
}

export async function openPage(connection: Connection, opts: PageOptions): Promise<Page> {
  const { browserContextId } = await connection.send('Target.createBrowserContext', { disposeOnDetach: true });
  try {
    const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new CdpPage(connection, session(connection, sessionId), browserContextId, targetId, opts);
    await page.init();
    return page;
  } catch (error) {
    await connection.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    throw error;
  }
}

class CdpPage implements Page {
  #connection: Connection;
  #s: Session;
  #contextId: string;
  #frameId: string;
  #opts: Required<Omit<PageOptions, 'clock'>> & { clock?: string };
  #origin: string;
  #url = 'about:blank';
  #inflight = new Map<string, { method: string; url: string; document: boolean }>();
  #loading = false;
  #closed = new AbortController();
  #document = 0;
  #lastNetChange = 0;
  #netWaiters = new Set<() => void>();
  #pending: Issue[] = [];
  #checkedPaths = new Set<string>();
  #refs = new Map<number, string>();
  #nextRef = 0;
  #refTable = new Map<string, { backendNodeId: number; locator: Locator; label: string }>();
  #offs: (() => void)[] = [];

  constructor(connection: Connection, s: Session, contextId: string, frameId: string, opts: PageOptions) {
    this.#connection = connection;
    this.#s = s;
    this.#contextId = contextId;
    this.#frameId = frameId;
    this.#opts = { ...opts, settleCapMs: opts.settleCapMs ?? 5000 };
    this.#origin = new URL(opts.baseUrl).origin;
  }

  async init(): Promise<void> {
    this.#listen();
    const [width, height] = this.#opts.viewport;
    await Promise.all([
      this.#s.send('Page.enable'),
      this.#s.send('Runtime.enable'),
      this.#s.send('Network.enable'),
      this.#s.send('Log.enable'),
      this.#s.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }),
      this.#s.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' }),
      this.#s.send('Emulation.setLocaleOverride', { locale: 'en-US' }),
      // Several pages share one headless browser; each must behave as if focused.
      this.#s.send('Emulation.setFocusEmulationEnabled', { enabled: true }),
      this.#s.send('Page.addScriptToEvaluateOnNewDocument', { source: bootScript(this.#opts.clock) }),
    ]);
  }

  #listen(): void {
    const on = (event: string, fn: (p: any) => void) => this.#offs.push(this.#s.on(event, fn));
    on('Network.requestWillBeSent', (p) => {
      if (p.type === 'EventSource') return;
      this.#inflight.set(p.requestId, { method: p.request.method, url: p.request.url, document: p.type === 'Document' && p.frameId === this.#frameId });
      this.#netChanged();
    });
    on('Network.responseReceived', (p) => {
      const status = p.response.status;
      const req = this.#inflight.get(p.requestId);
      if (status >= 400 && req) this.#issue('request', `${req.method} ${this.#strip(req.url)} ${status}`, { path: req.document ? pathOf(req.url) : undefined });
    });
    on('Network.loadingFinished', (p) => {
      if (this.#inflight.delete(p.requestId)) this.#netChanged();
    });
    on('Network.loadingFailed', (p) => {
      const req = this.#inflight.get(p.requestId);
      if (!req) return;
      this.#inflight.delete(p.requestId);
      this.#netChanged();
      if (!p.canceled && p.errorText !== 'net::ERR_ABORTED') {
        this.#issue('request', `${req.method} ${this.#strip(req.url)} failed: ${p.errorText}`, { path: req.document ? pathOf(req.url) : undefined });
      }
    });
    on('Page.frameStartedLoading', (p) => {
      if (p.frameId === this.#frameId) this.#loading = true;
      this.#netChanged();
    });
    on('Page.frameStoppedLoading', (p) => {
      if (p.frameId === this.#frameId) this.#loading = false;
      this.#netChanged();
    });
    on('Page.frameNavigated', (p) => {
      if (p.frame.parentId) return;
      this.#document++;
      this.#url = p.frame.url + (p.frame.urlFragment ?? '');
      this.#refs.clear();
      this.#refTable.clear();
    });
    on('Page.navigatedWithinDocument', (p) => {
      if (p.frameId === this.#frameId) this.#url = p.url;
    });
    on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error' && p.type !== 'assert') return;
      const text = (p.args as { value?: unknown; description?: string; type: string }[])
        .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? a.type)))
        .join(' ');
      this.#issue('console', text);
    });
    on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails;
      this.#issue('exception', String(d.exception?.description ?? d.text).split('\n')[0]);
    });
    on('Log.entryAdded', (p) => {
      if (p.entry.level === 'error' && p.entry.source !== 'network' && p.entry.source !== 'javascript') this.#issue('console', p.entry.text);
    });
    on('Page.javascriptDialogOpening', () => {
      this.#s.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    });
  }

  #netChanged(): void {
    this.#lastNetChange = performance.now();
    for (const wake of this.#netWaiters) wake();
    this.#netWaiters.clear();
  }

  #strip(text: string): string {
    return text.split(this.#origin).join('');
  }

  #path(): string {
    return pathOf(this.#url);
  }

  // Document requests belong to the page they load, which may not have committed yet.
  #issue(kind: IssueKind, raw: string, at: { width?: number; element?: string; path?: string } = {}): void {
    const { width, element } = at;
    const message = collapse(this.#strip(raw)).slice(0, 500);
    const path = at.path ?? this.#path();
    const key = [kind, path, width ?? '', element ?? message.slice(0, 200)].join('|');
    this.#pending.push(width === undefined ? { key, kind, message, path } : { key, kind, message, path, width });
  }

  #drain(): Issue[] {
    const seen = new Set<string>();
    const issues = this.#pending.filter((i) => !seen.has(i.key) && seen.add(i.key));
    this.#pending = [];
    return issues;
  }

  async #evaluate<T>(op: string, arg?: unknown): Promise<T> {
    const expression = `(${LIB}).call(undefined, ${JSON.stringify(op)}, ${JSON.stringify(arg ?? null)})`;
    const res = await this.#s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    return res.result.value as T;
  }

  async #call<T>(objectId: string, op: string, arg?: unknown): Promise<T> {
    const res = await this.#s.send('Runtime.callFunctionOn', {
      functionDeclaration: LIB,
      objectId,
      arguments: [{ value: op }, { value: arg ?? null }],
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    return res.result.value as T;
  }

  async #tree(): Promise<{ entries: Entry[]; title: string }> {
    const { nodes } = (await this.#s.send('Accessibility.getFullAXTree')) as { nodes: AXNode[] };
    return { entries: buildEntries(nodes), title: collapse(String(nodes[0]?.name?.value ?? '')) };
  }

  async #resolve(target: Target): Promise<Resolved> {
    let found: { backendNodeId: number; locator: Locator; label: string } | undefined;
    if ('ref' in target) {
      found = this.#refTable.get(target.ref);
      if (!found) throw new ActionError(`Unknown ref ${target.ref}; take a new snapshot`);
      const { entries } = await this.#tree();
      const current = entries.find(e => e.backendNodeId === found!.backendNodeId);
      if (!current || current.role !== found.locator.role || current.name !== found.locator.name)
        throw new ActionError(`Stale ref ${target.ref}; inspect the current page before acting`);
    } else {
      const { entries } = await this.#tree();
      const entry = findEntry(entries, target);
      const label = `${target.role} ${JSON.stringify(target.name)}${target.nth ? ` #${target.nth}` : ''}`;
      if (!entry || entry.backendNodeId === undefined) throw new ActionError(`No ${label} on the page`);
      found = { backendNodeId: entry.backendNodeId, locator: indexLocators(entries)[entries.indexOf(entry)], label };
    }
    const res = await this.#s
      .send('DOM.resolveNode', { backendNodeId: found.backendNodeId, objectGroup: 'playtest' })
      .catch(() => undefined);
    if (!res?.object?.objectId) throw new ActionError(`${found.label} is no longer on the page`);
    return { objectId: res.object.objectId, locator: found.locator, label: found.label };
  }

  async #point(el: Resolved): Promise<{ x: number; y: number }> {
    const r = await this.#call<{ x: number; y: number; covered?: string; error?: string }>(el.objectId, 'point');
    if (r.covered) throw new ActionError(`${el.label} is covered by ${r.covered}`);
    if (r.error) throw new ActionError(`${el.label} ${r.error}`);
    return r;
  }

  #mouse(type: string, x: number, y: number, extra: object = {}): Promise<unknown> {
    return this.#s.send('Input.dispatchMouseEvent', { type, x, y, ...extra });
  }

  async #perform(action: Action): Promise<Locator | undefined> {
    switch (action.type) {
      case 'click': {
        const el = await this.#resolve(action.target);
        const { x, y } = await this.#point(el);
        await Promise.all([
          this.#mouse('mouseMoved', x, y),
          this.#mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 }),
          this.#mouse('mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1 }),
        ]);
        return el.locator;
      }
      case 'hover': {
        const el = await this.#resolve(action.target);
        const { x, y } = await this.#point(el);
        await this.#mouse('mouseMoved', x, y);
        return el.locator;
      }
      case 'fill': {
        const el = await this.#resolve(action.target);
        const r = await this.#call<{ error?: string; done?: boolean; empty?: boolean }>(el.objectId, 'prepareFill', action.value);
        if (r.error) throw new ActionError(`${el.label} ${r.error}`);
        if (r.done) return el.locator;
        if (action.value) await this.#s.send('Input.insertText', { text: action.value });
        else if (!r.empty) await this.#keys('Backspace');
        return el.locator;
      }
      case 'select': {
        const el = await this.#resolve(action.target);
        const r = await this.#call<{ error?: string }>(el.objectId, 'select', action.option);
        if (r.error) throw new ActionError(`${el.label} ${r.error}`);
        return el.locator;
      }
      case 'press': {
        let locator: Locator | undefined;
        if (action.target) {
          const el = await this.#resolve(action.target);
          await this.#call(el.objectId, 'focus');
          locator = el.locator;
        }
        await this.#keys(action.key);
        return locator;
      }
      case 'navigate':
        await this.#navigate(action.url);
        {
          const url = new URL(action.url, this.#opts.baseUrl);
          if (url.origin === this.#origin) action.url = url.pathname + url.search + url.hash;
        }
        return undefined;
      case 'back': {
        const history = await this.#s.send('Page.getNavigationHistory');
        const entry = history.entries[history.currentIndex - 1];
        if (!entry) throw new ActionError('There is no previous page');
        this.#loading = true;
        this.#netChanged();
        await this.#s.send('Page.navigateToHistoryEntry', { entryId: entry.id });
        return undefined;
      }
      case 'scroll': {
        if (action.target) {
          const el = await this.#resolve(action.target);
          await this.#call(el.objectId, 'scroll', action.direction);
          return el.locator;
        }
        await this.#evaluate('scroll', action.direction);
        return undefined;
      }
      default:
        throw new ActionError(`Unknown action ${JSON.stringify(action)}`);
    }
  }

  async #keys(spec: string): Promise<void> {
    let events;
    try {
      events = keyEvents(spec);
    } catch (error) {
      throw new ActionError((error as Error).message);
    }
    await Promise.all(events.map((e) => this.#s.send('Input.dispatchKeyEvent', e)));
  }

  async #navigate(url: string): Promise<void> {
    this.#loading = true;
    this.#netChanged();
    const res = await this.#s.send('Page.navigate', { url: new URL(url, this.#opts.baseUrl).href });
    if (!res.loaderId) this.#loading = false;
    if (res.errorText) {
      this.#loading = false;
      throw new ActionError(`Navigation to ${url} failed: ${res.errorText}`);
    }
  }

  // Settled once the network has been quiet for QUIET_MS and two animation frames have run since its
  // last activity. The frames are awaited during the quiet window rather than after it.
  async #settle(from: number): Promise<number> {
    const cap = from + this.#opts.settleCapMs;
    this.#lastNetChange = Math.max(this.#lastNetChange, from);
    let frames: { mark: number; done: Promise<boolean> } | undefined;
    while (performance.now() < cap) {
      const now = performance.now();
      const busy = this.#inflight.size > 0 || this.#loading;
      if (!busy && frames?.mark !== this.#lastNetChange) {
        frames = { mark: this.#lastNetChange, done: this.#evaluate('frames').then(() => true, () => false) };
      }
      const quietLeft = this.#lastNetChange + QUIET_MS - now;
      if (busy || quietLeft > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, Math.max(1, Math.min(busy ? cap - now : quietLeft, cap - now)));
          function done() {
            clearTimeout(timer);
            resolve();
          }
          this.#netWaiters.add(done);
        });
        continue;
      }
      const current = frames!;
      let capTimer: NodeJS.Timeout | undefined;
      const framed = await Promise.race([
        current.done,
        new Promise<boolean>((resolve) => (capTimer = setTimeout(() => resolve(false), Math.max(1, cap - performance.now())))),
      ]);
      clearTimeout(capTimer);
      if (!framed) frames = undefined;
      else if (current.mark === this.#lastNetChange && this.#inflight.size === 0 && !this.#loading) break;
    }
    return Math.round(performance.now() - from);
  }

  async #afterAction(started: number, from: number, locator?: Locator): Promise<ActResult> {
    const settleMs = await this.#settle(from);
    const layoutFrom = performance.now();
    await this.#layoutChecks();
    timings.set(this, { actionMs: from - started, settleMs, layoutMs: performance.now() - layoutFrom });
    const result: ActResult = { ok: true, settleMs, issues: this.#drain() };
    if (locator) result.locator = locator;
    return result;
  }

  async #layoutChecks(): Promise<void> {
    const path = this.#path();
    if (this.#checkedPaths.has(path) || !this.#url.startsWith('http')) return;
    this.#checkedPaths.add(path);
    const [width, height] = this.#opts.viewport;
    const widths = [...new Set(this.#opts.widths)].sort((a, b) => (a === width ? -1 : b === width ? 1 : a - b));
    let resized = false;
    for (const w of widths) {
      if (w !== width) {
        await this.#s.send('Emulation.setDeviceMetricsOverride', { width: w, height, deviceScaleFactor: 1, mobile: false });
        resized = true;
      }
      const findings = await this.#evaluate<LayoutFinding[]>('layout', w);
      for (const f of findings) this.#issue(f.kind, f.message, { width: w, element: f.element });
    }
    if (resized) {
      await this.#s.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await this.#evaluate('waitWidth', width).catch(() => {});
    }
  }

  async resize([width, height]: [number, number]): Promise<void> {
    this.#opts.viewport = [width, height];
    await this.#s.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await this.#evaluate('waitWidth', width).catch(() => {});
  }

  async goto(path: string): Promise<ActResult> {
    const from = performance.now();
    try {
      await this.#navigate(path);
    } catch (error) {
      return this.#failed(error);
    }
    return this.#afterAction(from, performance.now());
  }

  async act(action: Action): Promise<ActResult> {
    const started = performance.now();
    if (action.type === 'wait') {
      if (!Array.isArray(action.until) || !action.until.length || action.until.length > 8 || !Number.isFinite(action.timeoutMs) || action.timeoutMs <= 0 || action.timeoutMs > 86_400_000)
        return { ok: false, error: 'Wait needs 1–8 conditions and a timeout of at most 24 hours.', settleMs: 0, issues: [] };
      const url = this.#url, document = this.#document;
      const samePage = () => {
        if (this.#document !== document || this.#url !== url) throw new Error('Page navigated while waiting; inspect the new page before waiting again.');
      };
      const result = await waitUntil(async () => {
        samePage();
        const entries = action.until.some(c => 'locator' in c) ? (await this.#tree()).entries : undefined;
        let matched = true;
        for (const check of action.until) if (!(await this.#check(check, entries)).ok) matched = false;
        samePage();
        return matched;
      }, action.timeoutMs, this.#closed.signal);
      return { ...result, settleMs: 0, issues: this.#drain() };
    }
    let locator: Locator | undefined;
    try {
      locator = await this.#perform(action);
    } catch (error) {
      return this.#failed(error);
    } finally {
      this.#s.send('Runtime.releaseObjectGroup', { objectGroup: 'playtest' }).catch(() => {});
    }
    return this.#afterAction(started, performance.now(), locator);
  }

  #failed(error: unknown): ActResult {
    if (error instanceof CdpError && error.message === CONNECTION_CLOSED) throw error;
    return { ok: false, error: (error as Error).message, settleMs: 0, issues: this.#drain() };
  }

  async snapshot(opts?: { actor?: boolean; raw?: boolean }): Promise<Snapshot> {
    const { entries, title } = await this.#tree();
    this.#refTable.clear();
    const text: string[] = [];
    const raw: string[] = [];
    const locators = indexLocators(entries);
    entries.forEach((entry, index) => {
      const indent = '  '.repeat(entry.depth);
      let ref = '';
      if (entry.actionable && entry.backendNodeId !== undefined) {
        let id = this.#refs.get(entry.backendNodeId);
        if (!id) this.#refs.set(entry.backendNodeId, (id = `e${++this.#nextRef}`));
        const locator = locators[index];
        this.#refTable.set(id, { backendNodeId: entry.backendNodeId, locator, label: `${entry.role} ${JSON.stringify(entry.name)}` });
        ref = `[${id}] `;
      }
      text.push(`${indent}${ref}${entry.body}${entry.focused ? ' focused' : ''}`);
      let body = entry.body;
      for (const value of [entry.name, entry.value]) if (value && value.length > 300)
        body = body.replace(JSON.stringify(value.slice(0, 300) + '…'), JSON.stringify(value));
      raw.push(`${indent}${ref}${body}${entry.focused ? ' focused' : ''}`);
    });
    if (!opts?.actor) return { url: this.#url, title, text: text.join('\n'), lines: normalizedLines(entries), ...(opts?.raw ? { rawText: raw.join('\n') } : {}) };
    const visible = new Set<number>();
    try {
      const [dom, metrics] = await Promise.all([
        this.#s.send('DOMSnapshot.captureSnapshot', { computedStyles: [] }),
        this.#s.send('Page.getLayoutMetrics'),
      ]);
      const view = metrics.cssVisualViewport;
      const doc = dom.documents[0];
      doc.layout.nodeIndex.forEach((node: number, i: number) => {
        const [x, y, w, h] = doc.layout.bounds[i];
        if (w > 0 && h > 0 && y + h > view.pageY && y < view.pageY + view.clientHeight && x + w > view.pageX && x < view.pageX + view.clientWidth)
          visible.add(doc.nodes.backendNodeId[node]);
      });
    } catch {}
    let dialogDepth = Infinity;
    const order = entries.map((e, i) => {
      if (e.depth <= dialogDepth) dialogDepth = /^(dialog|alertdialog)$/.test(e.role) ? e.depth : Infinity;
      return { i, priority: dialogDepth < Infinity || /^(alert|status)$/.test(e.role) || e.focused ? 0 : visible.has(e.backendNodeId!) ? 1 : e.role === 'navigation' ? 2 : 3 };
    })
      .sort((a, b) => a.priority - b.priority || a.i - b.i);
    const chosen = new Set<number>();
    let bytes = 0, refs = 0;
    for (const { i } of order) {
      const line = raw[i]!;
      const n = Buffer.byteLength(line) + 1;
      const actionable = entries[i]!.actionable;
      if (bytes + n > 7500 || (actionable && refs >= 200)) continue;
      chosen.add(i); bytes += n; if (actionable) refs++;
    }
    const compact = raw.filter((_, i) => chosen.has(i));
    if (chosen.size < raw.length) compact.push(`[${raw.length - chosen.size} nodes omitted; use inspect mode page with query or cursor for exact content.]`);
    return { url: this.#url, title, text: compact.join('\n'), rawText: raw.join('\n'), lines: normalizedLines(entries) };
  }

  async check(check: Check): Promise<CheckResult> {
    return this.#check(check);
  }

  async #check(check: Check, observed?: Entry[]): Promise<CheckResult> {
    switch (check.type) {
      case 'text': {
        const ok = await this.#evaluate<boolean>('text', check.value);
        return ok ? { ok } : { ok, detail: `Text ${JSON.stringify(check.value)} is not on the page` };
      }
      case 'url': {
        const href = await this.#evaluate<string>('href').catch(() => this.#url);
        const ok = href.includes(check.value) || this.#strip(href).includes(check.value);
        return ok ? { ok } : { ok, detail: `URL is ${this.#strip(href)}` };
      }
      case 'element':
      case 'absent':
      case 'enabled':
      case 'disabled':
      case 'value': {
        const entries = observed ?? (await this.#tree()).entries;
        const entry = findEntry(entries, check.locator);
        const label = `${check.locator.role} ${JSON.stringify(check.locator.name)}${check.locator.nth ? ` #${check.locator.nth}` : ''}`;
        if (check.type === 'element') return entry ? { ok: true } : { ok: false, detail: `No ${label} on the page` };
        if (check.type === 'absent') return entry ? { ok: false, detail: `${label} is on the page` } : { ok: true };
        if (!entry) return { ok: false, detail: `No ${label} on the page` };
        if (check.type === 'enabled' || check.type === 'disabled') {
          const ok = Boolean(entry.disabled) === (check.type === 'disabled');
          return ok ? { ok } : { ok, detail: `${label} is ${entry.disabled ? 'disabled' : 'enabled'}` };
        }
        const actual = entry.value ?? entry.checked ?? '';
        return actual === collapse(check.value) ? { ok: true } : { ok: false, detail: `${label} has value ${JSON.stringify(actual)}` };
      }
    }
  }

  async #viewportClip(scale: number) {
    const metrics = await this.#s.send('Page.getLayoutMetrics');
    const v = metrics.cssVisualViewport;
    return { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale };
  }

  async fingerprint(): Promise<string> {
    const clip = await this.#viewportClip(FINGERPRINT_SCALE);
    const { data } = await this.#s.send('Page.captureScreenshot', { format: 'png', clip });
    return fingerprintOf(Buffer.from(data, 'base64'));
  }

  async screenshot(opts: { fullPage?: boolean } = {}): Promise<Buffer> {
    if (!opts.fullPage) {
      const { data } = await this.#s.send('Page.captureScreenshot', { format: 'png' });
      return Buffer.from(data, 'base64');
    }
    const capture = async () => {
      const { width, height } = (await this.#s.send('Page.getLayoutMetrics')).cssContentSize;
      const clip = { x: 0, y: 0, width: Math.ceil(width), height: Math.ceil(height), scale: 1 };
      const { data } = await this.#s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
      return Buffer.from(data, 'base64');
    };
    const [viewWidth, viewHeight] = this.#opts.viewport;
    const height = Math.ceil((await this.#s.send('Page.getLayoutMetrics')).cssContentSize.height);
    if (height <= viewHeight) return capture();
    // A viewport as tall as the page, so fixed overlays (a dialog's backdrop) cover all of it.
    const metricsFor = (h: number) => ({ width: viewWidth, height: h, deviceScaleFactor: 1, mobile: false });
    await this.#s.send('Emulation.setDeviceMetricsOverride', metricsFor(height));
    try {
      await this.#evaluate('frames');
      return await capture();
    } finally {
      await this.#s.send('Emulation.setDeviceMetricsOverride', metricsFor(viewHeight));
      await this.#evaluate('frames').catch(() => {});
    }
  }

  async close(): Promise<void> {
    this.#closed.abort(new Error('Page closed; wait cancelled.'));
    for (const off of this.#offs) off();
    this.#offs = [];
    await this.#connection.send('Target.disposeBrowserContext', { browserContextId: this.#contextId }).catch(() => {});
  }
}
