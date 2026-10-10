import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { findProject, listStories, loadStory, parseConfig, parseStory, projectFromArgs } from '../src/project.ts';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'playtest-project-')));
after(() => rmSync(scratch, { recursive: true, force: true }));
function makeApp(name: string): string {
  const app = join(scratch, name);
  mkdirSync(join(app, 'playtest', 'stories'), { recursive: true });
  writeFileSync(join(app, 'playtest', 'config.json'), JSON.stringify({ url: 'http://localhost:3000', seed: 'node playtest/seed.js' }));
  return app;
}

test('config is optional and no app source or Git checkout is needed', () => {
  const project = findProject(scratch);
  assert.equal(project.config.url, undefined);
  assert.equal(project.dir, join(scratch, 'playtest'));
  assert.deepEqual(project.config.browser.viewport, [1280, 800]);
  assert.throws(() => parseConfig('{"app":{}}', 'x'), /app: unknown key/);
  assert.throws(() => parseConfig('{"url":"file:\/\/x"}', 'x'), /HTTP/);
  assert.equal(parseConfig('{"url":"https:\/\/example.com/path?q=1#x"}', 'x').url, 'https://example.com/path?q=1#x');
});

test('flags override config and changing target disables only the saved seed', () => {
  const app = makeApp('flags');
  const from = (values: Record<string, string | boolean>) => projectFromArgs({ positionals: [], values: { project: app, ...values } });
  assert.equal(from({}).config.seed, 'node playtest/seed.js');
  assert.equal(from({ url: 'http://localhost:3000/' }).config.seed, 'node playtest/seed.js');
  assert.equal(from({ url: 'https://staging.test' }).config.seed, undefined);
  assert.equal(from({ 'no-seed': true }).config.seed, undefined);
  const explicit = from({ url: 'https://staging.test', seed: 'node custom.js' });
  assert.equal(explicit.config.seed, 'node custom.js');
  assert.equal(explicit.seedCwd, process.cwd());
  assert.equal(from({}).seedCwd, app);
  assert.throws(() => from({ seed: 'true', 'no-seed': true }), /either/);
  assert.throws(() => projectFromArgs({ positionals: [], values: { url: 'https://a.test' } }, 'https://b.test'), /either/);
});

test('parseStory reads frontmatter, title, prose and Done when', () => {
  const story = parseStory(
    [
      '---',
      'start: /login',
      'viewport: [420, 800]',
      '---',
      '# Add a task to a project',
      '',
      'Sign in as admin.',
      'Add a task.',
      '',
      '## Done when',
      '- the task is in the list',
      '* the toast says',
      '  "Task created"',
      '',
    ].join('\n'),
    'add-task',
    '/x/add-task.md',
  );
  assert.equal(story.title, 'Add a task to a project');
  assert.equal(story.start, '/login');
  assert.deepEqual(story.viewport, [420, 800]);
  assert.equal(story.prose, 'Sign in as admin.\nAdd a task.');
  assert.deepEqual(story.doneWhen, ['the task is in the list', 'the toast says "Task created"']);
});

test('parseStory without frontmatter defaults start to /', () => {
  const story = parseStory('# Browse\r\n\r\nLook around.\r\n', 'browse', '/x/browse.md');
  assert.equal(story.start, '/');
  assert.equal(story.title, 'Browse');
  assert.equal(story.prose, 'Look around.');
  assert.deepEqual(story.doneWhen, []);
  assert.throws(() => parseStory('---\ncolour: red\n---\n# T\n', 's', '/x/s.md'), /colour: unknown key/);
});

test('listStories and loadStory', () => {
  const app = makeApp('stories');
  const stories = join(app, 'playtest', 'stories');
  writeFileSync(join(stories, 'b.md'), '# B\n\nProse b.\n');
  writeFileSync(join(stories, 'a.md'), '# A\n\nProse a.\n');
  writeFileSync(join(stories, 'a.baseline.json'), '{}');
  const project = findProject(app);
  assert.deepEqual(listStories(project).map((s) => s.name), ['a', 'b']);
  assert.equal(loadStory(project, join(stories, 'b.md')).title, 'B');
  assert.throws(() => loadStory(project, 'c'), /No story "c".*have: a, b/);
});
