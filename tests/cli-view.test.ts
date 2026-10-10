import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const cli = join(import.meta.dirname, '../bin/playtest.js');

test('an explicit report opens independently of a broken project config', () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'pt-view-config-')));
  try {
    mkdirSync(join(cwd, 'playtest'));
    writeFileSync(join(cwd, 'playtest/config.json'), 'broken json');
    mkdirSync(join(cwd, 'saved'));
    const file = join(cwd, 'saved/index.html');
    writeFileSync(file, '<!doctype html><title>Saved run</title>');
    for (const path of ['saved/index.html', 'saved', file]) {
      const result = spawnSync(process.execPath, [cli, 'view', path, '--json'], { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), { view: file });
    }
  } finally { rmSync(cwd, { recursive: true }); }
});
