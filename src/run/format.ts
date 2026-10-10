import type { Action, Check, Issue, Locator, RecordedAction, Target } from '../types.ts';

const q = (s: string) => JSON.stringify(s);

export function describeLocator(l: Locator): string {
  return `${l.role} ${q(l.name)}${l.nth ? ` #${l.nth}` : ''}`;
}

export function describeTarget(t: Target): string {
  return 'ref' in t ? t.ref : describeLocator(t);
}

export function describeAction(a: Action | RecordedAction): string {
  const on = 'target' in a && a.target ? describeTarget(a.target) : '';
  switch (a.type) {
    case 'fill':
      return `fill ${on} = ${q(a.value)}`;
    case 'select':
      return `select ${on} = ${q(a.option)}`;
    case 'press':
      return `press ${a.key}${on ? ` on ${on}` : ''}`;
    case 'navigate':
      return `navigate ${a.url}`;
    case 'back':
      return 'back';
    case 'wait':
      return `wait for ${a.until.map(describeCheck).join(' and ')} (up to ${seconds(a.timeoutMs)})`;
    case 'scroll':
      return `scroll ${a.direction}${on ? ` in ${on}` : ''}`;
    default:
      return `${a.type} ${on}`;
  }
}

export function describeCheck(c: Check): string {
  switch (c.type) {
    case 'text':
      return `text ${q(c.value)}`;
    case 'url':
      return `url ${q(c.value)}`;
    case 'value':
      return `value of ${describeLocator(c.locator)} is ${q(c.value)}`;
    case 'element':
      return `element ${describeLocator(c.locator)}`;
    case 'absent':
      return `absent ${describeLocator(c.locator)}`;
    case 'enabled':
    case 'disabled':
      return `${describeLocator(c.locator)} ${c.type}`;
  }
}

export function describeIssue(i: Issue): string {
  return `${i.kind}${i.width ? ` @${i.width}px` : ''} ${i.path}: ${i.message}`;
}

export function seconds(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function pagePath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}
