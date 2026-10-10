import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
const cli = join(import.meta.dirname, '../bin/playtest.js');

test('init writes only supplied defaults and refuses to overwrite', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pt-init-'));
  try {
    const args = [cli, 'init', '--url', 'http://localhost:3000', '--seed', 'node playtest/seed.js', '--json'];
    const report = JSON.parse(execFileSync(process.execPath, args, { cwd, encoding: 'utf8' }));
    assert.equal(report.written.length, 3);
    const file = join(cwd, 'playtest/config.json');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { url: 'http://localhost:3000/', seed: 'node playtest/seed.js' });
    const retry = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
    assert.equal(retry.status, 2);
    assert.match(JSON.parse(retry.stdout).error, /already exists/);
    assert.ok(existsSync(join(cwd, 'playtest/stories/example.md')));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});


test('init preserves an existing ignore file and adds the disposable-run rule', () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'pt-init-ignore-')));
  try {
    mkdirSync(join(cwd, 'playtest'));
    const file = join(cwd, 'playtest/.gitignore');
    writeFileSync(file, '# local fixtures\nfixtures.local');
    const report = JSON.parse(execFileSync(process.execPath, [cli, 'init', '--url', 'http://localhost:3000', '--json'], { cwd, encoding: 'utf8' }));
    assert.equal(readFileSync(file, 'utf8'), '# local fixtures\nfixtures.local\n.runs/\n');
    assert.ok(report.written.includes(file));
  } finally { rmSync(cwd, { recursive: true }); }
});
