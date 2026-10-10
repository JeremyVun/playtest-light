// Runs inside the page: serialized with toString(), so it must stay self-contained.

export type LayoutFinding = { kind: 'page-overflow' | 'content-overflow' | 'covered' | 'broken-image'; element: string; message: string };

export function pageLib(this: unknown, op: string, arg: any): unknown {
  const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
  const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);

  const implicitRole = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : '';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      const type = (el as HTMLInputElement).type;
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
      if (type === 'search') return 'searchbox';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      return 'textbox';
    }
    const map: Record<string, string> = {
      button: 'button', select: 'combobox', textarea: 'textbox', img: 'img', li: 'listitem', ul: 'list', ol: 'list',
      nav: 'navigation', main: 'main', dialog: 'dialog', table: 'table', summary: 'button', p: 'paragraph',
    };
    return map[tag] ?? '';
  };

  const nameOf = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    if (aria) return collapse(aria);
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const text = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
      if (collapse(text)) return collapse(text);
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) return collapse(labels[0].textContent ?? '');
    const alt = el.getAttribute('alt') ?? el.getAttribute('title') ?? el.getAttribute('placeholder');
    if (alt) return collapse(alt);
    return collapse((el as HTMLElement).innerText ?? el.textContent ?? '');
  };

  const describe = (el: Element): string => {
    const role = el.getAttribute('role') || implicitRole(el);
    const name = short(nameOf(el));
    const base = role || `${el.tagName.toLowerCase()}${el.classList[0] ? `.${el.classList[0]}` : ''}`;
    return name ? `${base} ${JSON.stringify(name)}` : base;
  };

  const visible = (el: Element): boolean => {
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && el.getClientRects().length > 0;
  };

  const sameTarget = (el: Element, hit: Element): boolean =>
    hit === el || el.contains(hit) || hit.contains(el) || (hit.closest('label') as HTMLLabelElement | null)?.control === el;

  const hitTest = (el: Element, x: number, y: number): Element | null => {
    const root = el.getRootNode();
    return (root instanceof ShadowRoot ? root : document).elementFromPoint(x, y);
  };

  const setNative = (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) => {
    const proto = Object.getPrototypeOf(el);
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const el = this as HTMLElement;

  if (op === 'point') {
    if (!el.isConnected) return { error: 'is no longer on the page' };
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return { error: 'is disabled' };
    const scroller = el as HTMLElement & { scrollIntoViewIfNeeded?: (center: boolean) => void };
    if (scroller.scrollIntoViewIfNeeded) scroller.scrollIntoViewIfNeeded(true);
    else el.scrollIntoView({ block: 'center', inline: 'center' });
    const rects = [...el.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length || !visible(el)) return { error: 'is not visible' };
    const box = el.getBoundingClientRect();
    const points = [box, ...rects].map((r) => ({
      x: Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1),
      y: Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1),
    }));
    let cover: Element | null = null;
    for (const p of points) {
      const hit = hitTest(el, p.x, p.y);
      if (!hit) continue;
      if (sameTarget(el, hit)) return { x: p.x, y: p.y };
      cover ??= hit;
    }
    return cover ? { covered: describe(cover) } : { error: 'is outside the viewport' };
  }

  if (op === 'prepareFill') {
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      const input = el as HTMLInputElement;
      if (input.disabled) return { error: 'is disabled' };
      if (input.readOnly) return { error: 'is read-only' };
      input.focus();
      const typed = tag === 'TEXTAREA' || ['text', 'search', 'email', 'password', 'tel', 'url', 'number'].includes(input.type);
      if (!typed) {
        setNative(input, String(arg));
        return { done: true };
      }
      input.select();
      return { empty: input.value === '' };
    }
    if (el.isContentEditable) {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return { empty: !el.textContent };
    }
    if (tag === 'SELECT') return { error: 'is a select; use the select action' };
    return { error: 'cannot be filled' };
  }

  if (op === 'select') {
    if (el.tagName !== 'SELECT') return { error: 'is not a native select' };
    const select = el as unknown as HTMLSelectElement;
    if (select.disabled) return { error: 'is disabled' };
    const want = collapse(String(arg));
    const options = [...select.options];
    const match = options.find((o) => collapse(o.label || o.text) === want) ?? options.find((o) => o.value === arg);
    if (!match) return { error: `has no option ${JSON.stringify(want)} (options: ${options.map((o) => JSON.stringify(collapse(o.label || o.text))).join(', ')})` };
    select.focus();
    setNative(select, match.value);
    return {};
  }

  if (op === 'focus') {
    el.focus();
    return {};
  }

  if (op === 'scroll') {
    let target: Element | null = el instanceof Element ? el : null;
    while (target && !(target.scrollHeight > target.clientHeight && /auto|scroll/.test(getComputedStyle(target).overflowY))) target = target.parentElement;
    const scroller = target ?? document.scrollingElement ?? document.documentElement;
    scroller.scrollBy({ top: (arg === 'up' ? -1 : 1) * Math.round(innerHeight * 0.8), behavior: 'instant' });
    return {};
  }

  if (op === 'text') return collapse(document.body?.innerText ?? '').includes(collapse(String(arg)));

  if (op === 'href') return location.href;

  if (op === 'waitWidth') {
    const width = Number(arg);
    return new Promise((resolve) => {
      const tick = () => (document.documentElement.clientWidth === width ? resolve(true) : requestAnimationFrame(tick));
      tick();
    });
  }

  if (op === 'frames') return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))));

  if (op === 'layout') {
    const width = Number(arg);
    const ready = () => document.documentElement.clientWidth === width || innerWidth === width;
    const run = (): LayoutFinding[] => {
      const findings: LayoutFinding[] = [];
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const all = [...document.body.querySelectorAll('*')].filter((e) => e instanceof HTMLElement && visible(e)) as HTMLElement[];

      const pageWidth = document.documentElement.scrollWidth;
      if (pageWidth > vw + 1) {
        const clips = (e: Element) => /hidden|clip|auto|scroll/.test(getComputedStyle(e).overflowX);
        const wide = all.filter((e) => e.getBoundingClientRect().right > vw + 1);
        const wideSet = new Set<Element>(wide);
        const culprits = wide.filter((e) => {
          for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) if (clips(p)) return false;
          return !wideSet.has(e.parentElement!);
        });
        findings.push({
          kind: 'page-overflow',
          element: 'page',
          message: `page is ${pageWidth}px wide in a ${vw}px viewport${culprits.length ? `; widest: ${culprits.slice(0, 3).map(describe).join(', ')}` : ''}`,
        });
      }

      const replaced = /^(IMG|INPUT|SELECT|TEXTAREA|VIDEO|CANVAS|IFRAME|svg|SVG|OBJECT|EMBED|BUTTON)$/;
      const overflowing = all.filter((e) => {
        if (replaced.test(e.tagName) || (e.clientWidth === 0 && e.clientHeight === 0)) return false;
        const style = getComputedStyle(e);
        if (style.display === 'inline' || style.display === 'contents') return false;
        const x = style.overflowX === 'visible' && e.scrollWidth > e.clientWidth + 1;
        const y = style.overflowY === 'visible' && e.scrollHeight > e.clientHeight + 1;
        return x || y;
      });
      for (const e of overflowing) {
        if (overflowing.some((other) => other !== e && e.contains(other))) continue;
        const x = e.scrollWidth > e.clientWidth + 1;
        findings.push({
          kind: 'content-overflow',
          element: describe(e),
          message: `${describe(e)}: content is ${x ? `${e.scrollWidth}px wide in a ${e.clientWidth}px` : `${e.scrollHeight}px tall in a ${e.clientHeight}px`} box`,
        });
      }

      const modal = document.querySelector('[aria-modal="true"], dialog[open]');
      const interactive = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';
      for (const e of document.querySelectorAll(interactive)) {
        if (modal && !modal.contains(e)) continue;
        if (!visible(e)) continue;
        const r = e.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (r.width === 0 || r.height === 0 || cx < 0 || cy < 0 || cx >= vw || cy >= vh) continue;
        const hit = hitTest(e, cx, cy);
        if (!hit || sameTarget(e, hit)) continue;
        findings.push({ kind: 'covered', element: `${describe(e)} by ${describe(hit)}`, message: `${describe(e)} is covered by ${describe(hit)}` });
      }

      for (const img of document.images) {
        if (!img.complete || img.naturalWidth > 0 || !(img.currentSrc || img.src) || !visible(img)) continue;
        const src = (img.currentSrc || img.src).replace(location.origin, '');
        findings.push({ kind: 'broken-image', element: `img ${short(src, 120)}`, message: `image ${src} failed to load` });
      }
      return findings;
    };
    if (ready()) return run();
    return new Promise((resolve) => {
      const tick = () => (ready() ? resolve(run()) : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });
  }

  if (op === 'describe') return describe(el);

  throw new Error(`unknown op ${op}`);
}

// Injected before any page script: freezes Date and turns off motion and the caret.
export function bootScript(clock: string | undefined): string {
  const css = '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }';
  const freeze = clock
    ? `const fixed = ${JSON.stringify(Date.parse(clock))}; const Real = Date;
       function FrozenDate(...args) { if (!new.target) return new Real(fixed).toString(); return args.length ? new Real(...args) : new Real(fixed); }
       FrozenDate.prototype = Real.prototype; FrozenDate.now = () => fixed; FrozenDate.parse = Real.parse; FrozenDate.UTC = Real.UTC;
       Object.defineProperty(FrozenDate.prototype, 'constructor', { value: FrozenDate });
       globalThis.Date = FrozenDate;`
    : '';
  return `(() => { ${freeze}
    const sheet = new CSSStyleSheet(); sheet.replaceSync(${JSON.stringify(css)});
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; })();`;
}
