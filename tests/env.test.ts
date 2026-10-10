import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { findProject } from '../src/project.ts';
import { runSeed } from '../src/env/seed.ts';
import { newRunDir, listRunDirs } from '../src/env/runs.ts';

const dir = mkdtempSync(join(tmpdir(), 'pt-seed-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const project = findProject(dir);
project.seedCwd = dir;
project.config.url = 'http://localhost:5400/';

test('seed restores data on every invocation, receives URL and runs in its chosen directory', async () => {
  writeFileSync(join(dir, 'seed.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync('data.json', JSON.stringify({ url: process.env.PLAYTEST_URL, count: 0 })); console.log('child output');`);
  project.config.seed = 'node seed.mjs';
  await runSeed(project);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8')), { url: project.config.url, count: 0 });
  writeFileSync(join(dir, 'data.json'), 'mutated');
  await runSeed(project);
  assert.equal(JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8')).count, 0);
  delete project.config.seed;
  writeFileSync(join(dir, 'data.json'), 'unchanged');
  await runSeed(project);
  assert.equal(readFileSync(join(dir, 'data.json'), 'utf8'), 'unchanged');
});

test('seed failures include bounded output and timeout terminates the child', async () => {
  project.config.seed = 'echo broken >&2; exit 7';
  await assert.rejects(runSeed(project), /seed failed \(exit 7\):\nbroken/);
  writeFileSync(join(dir, 'slow.mjs'), `import { writeFileSync } from 'node:fs'; setTimeout(() => writeFileSync('late', 'bad'), 500);`);
  project.config.seed = 'node slow.mjs';
  await assert.rejects(runSeed(project, 50), /seed timed out/);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(existsSync(join(dir, 'late')), false);
});

test('disposable runs retain only the latest twenty', () => {
  for (let i = 0; i < 23; i++) newRunDir(project, 'check');
  assert.equal(listRunDirs(project.runsDir).length, 20);
});


test('runs created in the same millisecond stay in creation order when pruned', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2030-01-01T00:00:00Z') });
  const runs = Array.from({ length: 23 }, () => newRunDir(project, 'run'));
  assert.equal(new Set(runs).size, 23, 'pruning must not cause a run name to be reused');
  assert.deepEqual(listRunDirs(project.runsDir).map(name => join(project.runsDir, name)), runs.slice(-20));
});
