import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..');

test('the bin runs when the package is copied under node_modules, with no warnings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'playtest-bin-'));
  try {
    const pkg = join(dir, 'node_modules', 'playtest-lite');
    for (const path of ['bin', 'src', 'package.json']) cpSync(join(root, path), join(pkg, path), { recursive: true });
    const r = spawnSync(process.execPath, [join(pkg, 'bin', 'playtest.js'), 'init', '--help'], { encoding: 'utf8' });
    assert.equal(r.stderr, '');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^Usage: pt init/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
