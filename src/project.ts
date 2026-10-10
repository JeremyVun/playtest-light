import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CommandArgs } from './cli.ts';
import type { Config, Project, Story } from './types.ts';

export class ConfigError extends Error {}

export const DEFAULT_MODEL = 'gpt-6.1-sol';

export function findProject(cwd: string, override?: string): Project {
  cwd = realpathSync(cwd);
  const dir = override ? projectDirFromOverride(resolve(cwd, override)) : findUp(cwd) ?? join(cwd, 'playtest');
  const file = join(dir, 'config.json');
  const config = existsSync(file) ? loadConfig(file) : parseConfig('{}', file);
  return { dir, cwd, seedCwd: dirname(dir), runsDir: join(dir, '.runs'), config };
}

export function projectFromArgs(args: CommandArgs, positionalUrl?: string): Project {
  const override = args.values.project;
  const project = findProject(process.cwd(), typeof override === 'string' ? override : undefined);
  const flagUrl = typeof args.values.url === 'string' ? args.values.url : undefined;
  if (positionalUrl && flagUrl) throw new ConfigError('Use either a positional URL or --url, not both.');
  const url = positionalUrl ?? flagUrl;
  if (args.values.seed !== undefined && args.values['no-seed']) throw new ConfigError('Use either --seed or --no-seed, not both.');
  if (url !== undefined) {
    const resolved = targetUrl(url);
    if (resolved !== project.config.url) delete project.config.seed;
    project.config.url = resolved;
  }
  if (args.values['no-seed']) delete project.config.seed;
  if (typeof args.values.seed === 'string') {
    if (!args.values.seed.trim()) throw new ConfigError('--seed must be a non-empty command.');
    project.config.seed = args.values.seed;
    project.seedCwd = project.cwd;
  }
  return project;
}

export function targetUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.href;
  } catch {
    throw new ConfigError('url must be an HTTP(S) URL without embedded credentials.');
  }
}

function projectDirFromOverride(path: string): string {
  if (path.endsWith('config.json')) return dirname(path);
  if (existsSync(join(path, 'config.json')) || path.endsWith('/playtest')) return path;
  return join(path, 'playtest');
}

function findUp(start: string): string | undefined {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'playtest'))) return join(dir, 'playtest');
    if (dirname(dir) === dir) return undefined;
  }
}

export function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

export function displayPath(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

export function loadConfig(file: string): Config {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new ConfigError(`${displayPath(file)}: ${(error as Error).message}`);
  }
  return parseConfig(text, displayPath(file));
}

type Json = Record<string, unknown>;

export function parseConfig(text: string, file: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${file}: invalid JSON: ${(error as Error).message}`);
  }
  const fail = (key: string, message: string): never => {
    throw new ConfigError(`${file}: ${key}: ${message}`);
  };
  const object = (value: unknown, key: string, allowed: string[]): Json => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(key || '(root)', 'must be an object');
    for (const k of Object.keys(value as Json)) if (!allowed.includes(k)) fail(key ? `${key}.${k}` : k, 'unknown key');
    return value as Json;
  };
  const string = (value: unknown, key: string): string => {
    if (typeof value !== 'string' || value === '') fail(key, 'must be a non-empty string');
    return value as string;
  };
  const integer = (value: unknown, key: string, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) fail(key, `must be an integer from ${min} to ${max}`);
    return value as number;
  };
  const root = object(raw, '', ['url', 'seed', 'browser', 'model']);
  const browser = object(root.browser ?? {}, 'browser', ['viewport', 'widths', 'clock', 'settleCapMs']);
  const viewport = browser.viewport === undefined ? [1280, 800] : (browser.viewport as unknown[]);
  if (!Array.isArray(viewport) || viewport.length !== 2) fail('browser.viewport', 'must be [width, height]');
  const size = (v: unknown, key: string) => integer(v, key, 100, 10000);
  const widths = browser.widths === undefined ? [420, 1280] : browser.widths;
  if (!Array.isArray(widths) || widths.length === 0) fail('browser.widths', 'must be a non-empty array of widths');
  const config: Config = {
    browser: {
      viewport: [size(viewport[0], 'browser.viewport[0]'), size(viewport[1], 'browser.viewport[1]')],
      widths: (widths as unknown[]).map((w, i) => size(w, `browser.widths[${i}]`)),
    },
    model: { name: DEFAULT_MODEL },
  };
  if (root.url !== undefined) config.url = targetUrl(string(root.url, 'url'));
  if (root.seed !== undefined) {
    config.seed = string(root.seed, 'seed');
    if (!config.seed.trim()) fail('seed', 'must be a non-empty command');
  }
  if (browser.clock !== undefined) {
    const clock = string(browser.clock, 'browser.clock');
    if (Number.isNaN(Date.parse(clock))) fail('browser.clock', 'must be an ISO instant such as 2026-04-01T12:00:00Z');
    config.browser.clock = clock;
  }
  if (browser.settleCapMs !== undefined) config.browser.settleCapMs = integer(browser.settleCapMs, 'browser.settleCapMs', 1, 600000);
  if (root.model !== undefined) {
    const model = object(root.model, 'model', ['name', 'effort']);
    if (model.name !== undefined) config.model.name = string(model.name, 'model.name');
    if (model.effort !== undefined) config.model.effort = string(model.effort, 'model.effort');
  }
  return config;
}

export function storiesDir(project: Project): string {
  return join(project.dir, 'stories');
}

export function baselinePath(project: Project, story: string | Story): string {
  if (typeof story !== 'string') return story.path.replace(/\.md$/, '.baseline.json');
  return /[/\\]/.test(story) || story.endsWith('.md') ? resolve(project.cwd, story.replace(/\.md$/, '') + '.baseline.json') : join(storiesDir(project), `${story}.baseline.json`);
}

export function listStories(project: Project): Story[] {
  const dir = storiesDir(project);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => loadStory(project, f.slice(0, -3)));
}

export function loadStory(project: Project, name: string): Story {
  const explicit = /[/\\]/.test(name) || name.endsWith('.md');
  const bare = explicit ? resolve(project.cwd, name.replace(/\.md$/, '')) : name;
  const path = explicit ? `${bare}.md` : join(storiesDir(project), `${bare}.md`);
  if (!existsSync(path)) {
    const have = existsSync(storiesDir(project)) ? readdirSync(storiesDir(project)).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)) : [];
    throw new ConfigError(`No story "${bare}" in ${displayPath(storiesDir(project))}${have.length ? ` (have: ${have.join(', ')})` : ''}`);
  }
  return parseStory(readFileSync(path, 'utf8'), explicit ? basename(bare) : bare, path);
}

export function parseStory(text: string, name: string, path: string): Story {
  const file = displayPath(path);
  let lines = text.replace(/\r\n?/g, '\n').split('\n');
  const story: Story = { name, path, title: name, start: '/', prose: '', doneWhen: [] };
  if (lines[0]?.trim() === '---') {
    const end = lines.indexOf('---', 1);
    if (end < 0) throw new ConfigError(`${file}: frontmatter has no closing ---`);
    for (const line of lines.slice(1, end)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const match = /^([A-Za-z]\w*)\s*:\s*(.*?)\s*$/.exec(line);
      if (!match) throw new ConfigError(`${file}: frontmatter line is not "key: value": ${line}`);
      const [, key, value] = match;
      if (key === 'start') {
        if (!value.startsWith('/')) throw new ConfigError(`${file}: start: must be a path starting with /`);
        story.start = value;
      } else if (key === 'viewport') {
        const size = /^\[?\s*(\d+)\s*[,x]\s*(\d+)\s*\]?$/.exec(value);
        if (!size) throw new ConfigError(`${file}: viewport: must be [width, height]`);
        story.viewport = [Number(size[1]), Number(size[2])];
      } else {
        throw new ConfigError(`${file}: ${key}: unknown key (allowed: start, viewport)`);
      }
    }
    lines = lines.slice(end + 1);
  }
  const prose: string[] = [];
  let section: 'body' | 'done' | 'other' = 'body';
  let titled = false;
  for (const line of lines) {
    const title = /^#\s+(.*?)\s*$/.exec(line);
    if (title && !titled && section === 'body' && !prose.some((l) => l.trim())) {
      story.title = title[1];
      titled = true;
      continue;
    }
    const heading = /^##\s+(.*?)\s*$/.exec(line);
    if (heading) {
      section = /^done when:?$/i.test(heading[1]) ? 'done' : 'other';
      if (section === 'other') prose.push(line);
      continue;
    }
    if (section === 'done') {
      const bullet = /^\s*[-*]\s+(.*?)\s*$/.exec(line);
      if (bullet) story.doneWhen.push(bullet[1]);
      else if (line.trim() && story.doneWhen.length) story.doneWhen[story.doneWhen.length - 1] += ` ${line.trim()}`;
    } else {
      prose.push(line);
    }
  }
  story.prose = prose.join('\n').trim();
  return story;
}
