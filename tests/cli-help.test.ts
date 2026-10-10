import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const cli = join(import.meta.dirname, '../bin/playtest.js');
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
const commands = ['run', 'explore', 'view', 'accept', 'init'];

test('root help is a short command list with no ambiguous shared flags', () => {
  const help = run('help');
  assert.equal(help.status, 0);
  assert.equal(help.stderr, '');
  for (const args of [[], ['--help'], ['-h']]) assert.equal(run(...args).stdout, help.stdout);
  for (const command of commands) assert.match(help.stdout, new RegExp(`^  ${command} +\\S`, 'm'));
  assert.doesNotMatch(help.stdout, /Target:|Evidence:|Common:|Defaults:|--url|--seed|--json/);
  assert.ok(help.stdout.trim().split('\n').length <= 12);
});

test('each command has complete scoped help and both help forms agree', () => {
  for (const command of commands) {
    const help = run(command, '--help');
    assert.equal(help.status, 0);
    assert.equal(help.stderr, '');
    assert.equal(run('help', command).stdout, help.stdout);
    assert.equal(run(command, '-h').stdout, help.stdout);
    assert.match(help.stdout, new RegExp(`^Usage: pt ${command} `));
    assert.match(help.stdout, /Options:\n/);
    assert.match(help.stdout, /Examples:\n/);
    assert.ok(help.stdout.split('\n').every(line => line.length <= 80), help.stdout);
    const advertised = [...help.stdout.matchAll(/^  (?:-h, )?(--[\w-]+)/gm)].map(match => match[1]);
    assert.equal(advertised.length, new Set(advertised).size);
    for (const flag of advertised) {
      const line = help.stdout.split('\n').find(line => line.trimStart().startsWith(flag));
      const args = [command, flag, ...(line?.includes('<') ? ['example'] : []), '--help'];
      assert.equal(run(...args).status, 0, `${command} ${flag} advertised but rejected`);
    }
    if (['view', 'accept'].includes(command)) assert.doesNotMatch(help.stdout, /--url|--seed|--view|--record/);
  }
  assert.match(run('accept', '--help').stdout, /verified recording/);
  assert.match(run('view', '--help').stdout, /without opening/);
});

test('invalid command options fail before loading a project, as text or JSON', () => {
  assert.match(run('accept', '--url', 'https://example.test').stderr, /--url is not an option for pt accept\./);
  for (const args of [
    ['accept', '--url', 'https://example.test'], ['accept', '--view'],
    ['view', '--seed', 'echo wrong'], ['view', '--record'],
    ['init', '--no-seed'], ['explore', '--random-seed', '1'],
    ['explore', '--fresh'], ['run', '--steps', '10'],
    ['run', '--url'], ['help', 'run', 'extra'], ['help', 'wat'],
    ['wat'], ['toString'], ['accept'], ['view', 'one', 'two'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^pt: /);
    assert.doesNotMatch(result.stderr, /positional argument starting with/);
    assert.match(result.stderr, /See pt .*--help/);
    const json = run(...args, '--json');
    assert.equal(json.status, 2);
    assert.equal(json.stderr, '');
    assert.equal(typeof JSON.parse(json.stdout).error, 'string');
  }
});

test('help works even when the local config cannot be loaded', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pt-help-'));
  try {
    mkdirSync(join(cwd, 'playtest'));
    writeFileSync(join(cwd, 'playtest/config.json'), 'invalid json');
    for (const command of commands) {
      const result = spawnSync(process.execPath, [cli, command, '--help'], { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
    }
  } finally { rmSync(cwd, { recursive: true }); }
});


test('the argument separator keeps a literal --json out of output-mode detection', () => {
  const result = run('accept', '--', '--json');
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /No story/);
  const invalid = run('accept', '--unknown', '--', '--json');
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /--unknown is not an option/);
  assert.equal(typeof JSON.parse(run('--json').stdout).error, 'string');
});
