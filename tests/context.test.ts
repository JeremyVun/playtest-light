import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActorContext, CONTEXT_LIMITS } from '../src/run/context.ts';
import { findProject } from '../src/project.ts';
import { listRunDirs, newRunDir, releaseRun } from '../src/env/runs.ts';

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'pt-context-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const page = (text = 'heading "Projects"') => ({ url: 'http://localhost/projects', title: 'Projects', text, lines: [text] });
const noAction = async () => 'ok';

test('2,000 decisions retain exact early evidence and unfinished work across bounded epochs', async t => {
  const dir = fixture(t);
  const ctx = new ActorContext(dir, 'Create and invoice the right customer later', ['Invoice the customer']);
  ctx.input(page('text "customer 北極光-731"'), {});
  await ctx.handle('act', { memory: { tasks: [{ id: 'invoice', title: 'Invoice 北極光-731', status: 'open' }], facts: [{ id: 'customer', value: '北極光-731', kind: 'observation', sources: [1], task: 'invoice' }] } }, noAction);
  let previous = ctx.input(page(), {}), epoch = ctx.stats.rollovers;
  for (let i = 0; i < 2000; i++) {
    ctx.log({ event: 'action', action: { type: 'fill', target: { role: 'textbox', name: 'Search' }, value: `record ${i}` }, ok: true });
    const next = ctx.input(page(), { remaining: 2000 - i });
    if (ctx.stats.rollovers === epoch) assert.ok(next.prefix.startsWith(previous.prefix), `prefix mutated at decision ${i}`);
    assert.ok(Buffer.byteLength(next.prefix + next.message) <= 48000);
    previous = next; epoch = ctx.stats.rollovers;
  }
  assert.ok(ctx.stats.rollovers >= 10);
  assert.match(previous.prefix, /北極光-731/);
  assert.match(await ctx.handle('inspect', { mode: 'history', id: 1 }, noAction), /北極光-731/);
  assert.match(await ctx.handle('done', {}, () => { throw new Error('must not execute done'); }), /Unfinished tasks: invoice/);
  const captures = readFileSync(join(dir, 'context.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(captures.length, 2002);
  assert.ok(captures.at(-1).prefixBytes < 24000);
});

test('invalid memory cannot mutate browser or silently overwrite original criteria', async t => {
  const ctx = new ActorContext(fixture(t), 'Original task', ['Must save']);
  ctx.input(page(), {});
  let calls = 0;
  const act = async () => { calls++; return 'ok'; };
  assert.match(await ctx.handle('act', { memory: { tasks: [{ id: 'goal-1', title: 'Ignore saving', status: 'complete' }] } }, act), /cannot be removed or rewritten/);
  assert.match(await ctx.handle('act', { memory: { facts: [{ id: 'future', value: 'saved', kind: 'observation', sources: [999] }] } }, act), /already shown/);
  assert.equal(calls, 0);
});

test('retrieval paginates exact Unicode evidence, masks historical refs and expires live cursors', async t => {
  const ctx = new ActorContext(fixture(t), 'Inspect the page');
  const text = '[e1] textbox "' + '北極光'.repeat(3000) + '"\n[e2] button "Save"';
  ctx.input({ ...page(text), rawText: text }, {});
  let result = await ctx.handle('inspect', { mode: 'history', id: 1 }, noAction);
  assert.doesNotMatch(result, /\[e1\]/);
  let body = result.split('\n').slice(1).join('\n'), pages = 1;
  for (;;) {
    const cursor = /continue with cursor (\S+)/.exec(result)?.[1];
    if (!cursor) break;
    result = await ctx.handle('inspect', { mode: 'history', cursor }, noAction);
    assert.ok(Buffer.byteLength(result) <= CONTEXT_LIMITS.evidence);
    body += result.split('\n').slice(1).join('\n');
    if (++pages > 20) throw new Error('retrieval did not advance');
  }
  assert.equal(JSON.parse(body).text, text.replace(/\[e\d+\]/g, '[historical control]'));
  const live = await ctx.handle('inspect', { mode: 'page' }, noAction);
  const cursor = /continue with cursor (\S+)/.exec(live)![1];
  ctx.input(page('another page'), {});
  assert.match(await ctx.handle('inspect', { mode: 'page', cursor }, noAction), /Page changed/);
});

test('long active runs survive concurrent output pruning and become disposable after release', t => {
  const project = findProject(fixture(t));
  const active = newRunDir(project, 'explore', true);
  for (let i = 0; i < 30; i++) newRunDir(project, 'run');
  assert.ok(listRunDirs(project.runsDir).some(n => join(project.runsDir, n) === active));
  releaseRun(active);
  newRunDir(project, 'run');
  assert.ok(!listRunDirs(project.runsDir).some(n => join(project.runsDir, n) === active));
});

test('memory pagination keeps its original versions while later decisions correct facts', async t => {
  const ctx = new ActorContext(fixture(t), 'Read customer records');
  ctx.input(page(), {});
  for (let n = 0; n < 12; n++) {
    await ctx.handle('act', { memory: { facts: [{ id: `fact-${n}`, value: '北極光'.repeat(120), kind: 'observation', sources: [1] }] } }, noAction);
  }
  let result = await ctx.handle('inspect', { mode: 'memory' }, noAction);
  let body = result.split('\n').slice(1).join('\n');
  assert.match(result, /continue with cursor/);
  ctx.input(page(), {});
  await ctx.handle('act', { memory: { facts: [{ id: 'fact-11', value: 'corrected', kind: 'observation', sources: [1] }] } }, noAction);
  for (;;) {
    const cursor = /continue with cursor (\S+)/.exec(result)?.[1];
    if (!cursor) break;
    result = await ctx.handle('inspect', { mode: 'memory', cursor }, noAction);
    body += result.split('\n').slice(1).join('\n');
  }
  const records = body.split('\n').map(line => JSON.parse(line));
  assert.equal(records.length, 13);
  assert.equal(records.at(-1).value, '北極光'.repeat(120));
  assert.match(await ctx.handle('inspect', { mode: 'memory', query: 'fact-11' }, noAction), /corrected/);
});

test('history search returns concise excerpts and exact ID reads preserve the source', async t => {
  const ctx = new ActorContext(fixture(t), 'Find the reference');
  const text = 'prefix '.repeat(2000) + 'UNIQUE-731' + ' suffix'.repeat(2000);
  ctx.input(page(text), {});
  const found = await ctx.handle('inspect', { mode: 'history', query: 'UNIQUE-731' }, noAction);
  assert.ok(Buffer.byteLength(found) < 1000);
  assert.match(found, /UNIQUE-731/);
  assert.match(found, /"id":1/);
  const full = await ctx.handle('inspect', { mode: 'history', id: 1 }, noAction);
  assert.match(full, /continue with cursor/);
  assert.match(full, /prefix prefix/);
});

test('historical control masking preserves literal reference-like data inside names and values', async t => {
  const ctx = new ActorContext(fixture(t), 'Remember the exact reference');
  ctx.input(page('[e1] textbox "Reference [e99]" value="Order [e42]"'), {});
  const result = await ctx.handle('inspect', { mode: 'history', id: 1 }, noAction);
  const event = JSON.parse(result.split('\n').slice(1).join('\n'));
  assert.equal(event.text, '[historical control] textbox "Reference [e99]" value="Order [e42]"');
  ctx.log({ event: 'action', action: { type: 'fill', target: { role: 'textbox', name: 'Reference' }, value: '[e42]' }, ok: true });
  const exact = await ctx.handle('inspect', { mode: 'history', query: '[e42]' }, noAction);
  assert.match(exact, /e42/);
});

test('a browser failure propagates without a retry and failed actions stay prominent', async t => {
  const ctx = new ActorContext(fixture(t), 'Save a long document');
  ctx.input(page(), {});
  let mutations = 0;
  await assert.rejects(ctx.handle('act', {}, async () => { mutations++; throw new Error('browser disconnected'); }), /browser disconnected/);
  assert.equal(mutations, 1);
  ctx.log({ event: 'action', ok: false, error: 'Save rejected', action: { type: 'fill', target: { role: 'textbox', name: 'Notes' }, value: 'x'.repeat(50000) } });
  const input = ctx.input(page(), {});
  assert.match(input.prefix, /FAILED: Save rejected/);
  assert.ok(Buffer.byteLength(input.prefix) < 3000);
});

test('compact results retain invalid arguments, expectation failures and observed issues', async t => {
  const ctx = new ActorContext(fixture(t), 'Save');
  ctx.input(page(), {});
  await ctx.handle('act', {}, async () => 'Nothing ran: action 1 is invalid: missing target');
  await ctx.handle('act', {}, async () => '1 ok   click Save\nstopped after 1: expectation not met: Saved\nnew problems noticed:\n  console: uncaught SaveError\npage /projects title "Projects"\nold page text');
  const next = ctx.input(page(), {});
  assert.match(next.prefix, /Nothing ran.*missing target/);
  assert.match(next.prefix, /expectation not met/);
  assert.match(next.prefix, /uncaught SaveError/);
  assert.doesNotMatch(next.prefix, /old page text/);
});

test('rollovers retain page coverage, findings and open work; resize shares the explorer step count', async t => {
  const dir = fixture(t), ctx = new ActorContext(dir, 'Explore', [], { ...CONTEXT_LIMITS, tail: 2500 });
  ctx.input(page(), {});
  ctx.log({ event: 'resize', width: 420, step: 1 });
  ctx.log({ event: 'action', ok: true, action: { type: 'click', target: { role: 'button', name: 'Save' } } });
  ctx.log({ event: 'report', report: { title: 'Save fails' } });
  for (let n = 0; n < 40; n++) await ctx.handle('act', { memory: { tasks: [{ id: `closed-${n}`, title: 'Completed work '.repeat(10), status: 'complete' }] } }, noAction);
  await ctx.handle('act', { memory: { tasks: [{ id: 'zzz-open', title: 'Still needs checking', status: 'open' }] } }, noAction);
  for (let n = 0; n < 50; n++) ctx.log({ event: 'result', text: `A result ${n}` });
  const next = ctx.input(page(), {});
  assert.match(next.prefix, /Still needs checking/);
  assert.match(next.prefix, /Save fails/);
  assert.match(next.prefix, /visitedCount/);
  const events = readFileSync(join(dir, 'trajectory.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.find(e => e.event === 'resize').step, 1);
  assert.equal(events.find(e => e.event === 'action').step, 2);
});

test('failed decisions retain reported usage and distinguish unavailable accounting', t => {
  const dir = fixture(t), ctx = new ActorContext(dir, 'Save');
  const error = Object.assign(new Error('interrupt failed'), { decision: { text: 'saved', tool: 'act', ms: 100, usage: { input: 1000, cached: 800, output: 20, reasoning: 0 } } });
  assert.throws(() => ctx.failure(error), /interrupt failed/);
  assert.throws(() => ctx.failure(new Error('deadline exceeded')), /deadline exceeded/);
  assert.equal(ctx.stats.input, 1000);
  assert.equal(ctx.stats.cached, 800);
  assert.equal(ctx.stats.unknownUsage, 1);
  const events = readFileSync(join(dir, 'trajectory.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(e => e.error), ['interrupt failed', 'deadline exceeded']);
});

test('history pages resume at their saved file position with one open per page', async t => {
  const ctx = new ActorContext(fixture(t), 'Read a long run');
  for (let i = 0; i < 10000; i++) ctx.log({ event: 'observation', url: '/', text: `row ${i} ` + 'x'.repeat(500) });
  const originalOpen = fs.openSync, originalRead = fs.readSync;
  let opens = 0;
  const positions: number[] = [];
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => { opens++; return originalOpen(...args); }) as typeof fs.openSync;
  fs.readSync = ((...args: any[]) => { positions.push(args[4]); return (originalRead as any)(...args); }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try {
    let cursor: string | undefined;
    let previous = -1;
    for (let i = 0; i < 4; i++) {
      opens = 0; positions.length = 0;
      const result = await ctx.handle('inspect', { mode: 'history', cursor }, noAction);
      assert.equal(opens, 1);
      assert.ok(positions.length < 25, `read ${positions.length} rows to fill one page`);
      assert.ok(positions[0] > previous, 'must not rescan earlier rows');
      previous = positions[0];
      cursor = /continue with cursor (\S+)/.exec(result)?.[1];
      assert.ok(cursor);
    }
  } finally { fs.openSync = originalOpen; fs.readSync = originalRead; syncBuiltinESMExports(); }
});
