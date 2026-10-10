import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listRunDirs } from '../env/runs.ts';
import { baselinePath, displayPath } from '../project.ts';
import type { Baseline, BaselineStep, Check, Issue, Locator, Project, RecordedAction, Story } from '../types.ts';

export const BASELINE_VERSION = 2;

let harness: string | undefined;
export function harnessVersion(): string {
  harness ??= (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  return harness;
}

export function platformId(): string {
  return `${process.platform}-${process.arch}`;
}

function locator(l: Locator): Locator {
  return l.nth === undefined ? { role: l.role, name: l.name } : { role: l.role, name: l.name, nth: l.nth };
}

export function orderAction(a: RecordedAction): RecordedAction {
  const target = 'target' in a && a.target ? { target: 'ref' in a.target ? a.target : locator(a.target) } : {};
  switch (a.type) {
    case 'fill':
      return { type: a.type, ...target, value: a.value } as RecordedAction;
    case 'select':
      return { type: a.type, ...target, option: a.option } as RecordedAction;
    case 'press':
      return { type: a.type, ...target, key: a.key } as RecordedAction;
    case 'navigate':
      return { type: a.type, url: a.url };
    case 'back':
      return { type: a.type };
    case 'wait':
      return { type: a.type, until: a.until.map(orderCheck), timeoutMs: a.timeoutMs };
    case 'scroll':
      return { type: a.type, ...target, direction: a.direction } as RecordedAction;
    default:
      return { type: a.type, ...target } as RecordedAction;
  }
}

export function orderCheck(c: Check): Check {
  switch (c.type) {
    case 'text':
    case 'url':
      return { type: c.type, value: c.value };
    case 'value':
      return { type: c.type, locator: locator(c.locator), value: c.value };
    default:
      return { type: c.type, locator: locator(c.locator) };
  }
}

function orderIssue(i: Issue): Issue {
  return i.width === undefined ? { key: i.key, kind: i.kind, message: i.message, path: i.path } : { key: i.key, kind: i.kind, message: i.message, path: i.path, width: i.width };
}

const j = (value: unknown) => JSON.stringify(value);

function list(items: unknown[], indent: string): string {
  if (!items.length) return '[]';
  return `[\n${items.map((item) => `${indent}  ${j(item)}`).join(',\n')}\n${indent}]`;
}

// Fixed key order and one snapshot line, issue or check per line, so a pull request diff reads as
// "this step's page gained/lost these lines".
export function formatBaseline(b: Baseline): string {
  const steps = b.steps.map((s) =>
    [
      '    {',
      `      "action": ${j(orderAction(s.action))},`,
      `      "url": ${j(s.url)},`,
      `      "settleMs": ${j(s.settleMs)},`,
      `      "fingerprint": ${j(s.fingerprint)},`,
      `      "issues": ${list(s.issues.map(orderIssue), '      ')},`,
      `      "snapshot": ${list(s.snapshot, '      ')}`,
      '    }',
    ].join('\n'),
  );
  return `${[
    '{',
    `  "version": ${j(b.version)},`,
    `  "story": ${j(b.story)},`,
    `  "url": ${j(b.url)},`,
    `  "seeded": ${j(b.seeded)},`,
    `  "platform": ${j(b.platform)},`,
    `  "chrome": ${j(b.chrome)},`,
    `  "harness": ${j(b.harness)},`,
    `  "viewport": ${j(b.viewport)},`,
    `  "start": ${j(b.start)},`,
    `  "startIssues": ${list(b.startIssues.map(orderIssue), '  ')},`,
    `  "steps": ${steps.length ? `[\n${steps.join(',\n')}\n  ]` : '[]'},`,
    `  "checks": ${list(b.checks.map(orderCheck), '  ')}`,
    '}',
  ].join('\n')}\n`;
}

export function parseBaseline(text: string, file: string): Baseline {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: invalid JSON: ${(error as Error).message}`);
  }
  if (raw?.version !== BASELINE_VERSION) throw new Error(`${file}: baseline version ${raw?.version} is not ${BASELINE_VERSION}; record the story again`);
  const fail = (what: string): never => {
    throw new Error(`${file}: ${what}`);
  };
  if (typeof raw.url !== 'string' || typeof raw.seeded !== 'boolean') fail('url and seeded are required');
  if (typeof raw.story !== 'string') fail('story must be a string');
  if (typeof raw.start !== 'string') fail('start must be a string');
  if (!Array.isArray(raw.viewport) || raw.viewport.length !== 2) fail('viewport must be [width, height]');
  if (!Array.isArray(raw.steps)) fail('steps must be an array');
  if (!Array.isArray(raw.checks)) fail('checks must be an array');
  raw.steps.forEach((s: BaselineStep, i: number) => {
    if (typeof s?.action?.type !== 'string') fail(`steps[${i}].action needs a type`);
    if (!Array.isArray(s.snapshot)) fail(`steps[${i}].snapshot must be an array of lines`);
    s.issues ??= [];
  });
  raw.startIssues ??= [];
  return raw as Baseline;
}

export function readBaseline(path: string): Baseline {
  return parseBaseline(readFileSync(path, 'utf8'), path);
}

export function writeBaseline(path: string, baseline: Baseline): void {
  writeFileSync(path, formatBaseline(baseline));
}

export type Accepted = { story: string; from: string; to: string; url: string; seeded: boolean };

function pendingBaseline(project: Project, storyPath: string): string | undefined {
  for (const name of listRunDirs(project.runsDir).reverse()) {
    const file = join(project.runsDir, name, 'report.json');
    if (!existsSync(file)) continue;
    const report = JSON.parse(readFileSync(file, 'utf8')) as { kind: string; recordingAttempts?: string[]; recordings?: { storyPath: string; deterministic: boolean; baseline?: string }[] };
    if (report.kind !== 'run') continue;
    const recording = report.recordings?.findLast(r => r.storyPath === storyPath);
    if (recording) return recording.deterministic && recording.baseline && existsSync(recording.baseline) ? recording.baseline : undefined;
    if (report.recordingAttempts?.includes(storyPath)) return undefined;
  }
}

export function acceptStory(project: Project, story: Story, from = pendingBaseline(project, story.path)): Accepted {
  if (!from) throw new Error(`No verified recording of ${story.name} in ${displayPath(project.runsDir)}. Record it with pt run --record.`);
  const baseline = readBaseline(from);
  const to = baselinePath(project, story);
  copyFileSync(from, to);
  return { story: story.name, from, to, url: baseline.url, seeded: baseline.seeded };
}
