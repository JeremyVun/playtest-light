import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptModel, parseScript, type TranscriptEntry } from '../src/model/script.ts';
import { openModel } from '../src/model/index.ts';

const tools = [{ name: 'act', description: 'act', parameters: {} }];

function scratch(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'playtest-model-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('each send plays the next turn through onTool in order and returns its text', async () => {
  const entries: TranscriptEntry[] = [];
  const model = new ScriptModel(
    [
      [{ tool: 'act', args: { n: 1 } }, { tool: 'act', args: { n: 2 } }, { text: 'first' }],
      [{ tool: 'done', args: { summary: 'ok' } }],
    ],
    { transcript: (entry) => entries.push(entry) },
  );
  const thread = await model.startThread({ instructions: 'x', tools });
  const calls: unknown[] = [];
  const handler = async (name: string, args: unknown) => {
    calls.push([name, args]);
    if (name === 'done') throw new Error('checks failed');
    return `ran ${(args as { n: number }).n}`;
  };
  assert.deepEqual(await thread.send('play', handler), { text: 'first' });
  assert.deepEqual(await thread.send('again', handler), { text: '' });
  assert.deepEqual(calls, [
    ['act', { n: 1 }],
    ['act', { n: 2 }],
    ['done', { summary: 'ok' }],
  ]);
  assert.deepEqual(entries, [
    { event: 'thread', thread: 1, tools: ['act'] },
    { event: 'send', thread: 1, turn: 1, message: 'play' },
    { event: 'tool', thread: 1, turn: 1, tool: 'act', args: { n: 1 }, ok: true, output: 'ran 1' },
    { event: 'tool', thread: 1, turn: 1, tool: 'act', args: { n: 2 }, ok: true, output: 'ran 2' },
    { event: 'text', thread: 1, turn: 1, text: 'first' },
    { event: 'send', thread: 1, turn: 2, message: 'again' },
    { event: 'tool', thread: 1, turn: 2, tool: 'done', args: { summary: 'ok' }, ok: false, output: 'checks failed' },
  ]);
  assert.equal(model.remaining, 0);
  await assert.rejects(thread.send('more', handler), /no scripted turn left for message 3/);
});

test('scripts are validated with the file and position', () => {
  assert.throws(() => parseScript('{', 'a.json'), /^Error: a\.json: not valid JSON/);
  assert.throws(() => parseScript('{}', 'a.json'), /a\.json: expected an array of turns/);
  assert.throws(() => parseScript('[[{"args":{}}]]', 'a.json'), /a\.json: turn 0 step 0: needs "tool"/);
  assert.throws(() => parseScript('[[{"text":"x"},{"tool":"act"}]]', 'a.json'), /turn 0 step 0: "text" must be the turn's last step/);
  assert.deepEqual(parseScript('[[{"tool":"act"}],[]]'), [[{ tool: 'act' }], []]);
});

test('PLAYTEST_MODEL=script:<file> selects the scripted backend and writes the transcript', async () => {
  const { dir, done } = scratch();
  try {
    const script = join(dir, 'script.json');
    const transcript = join(dir, 'transcript.jsonl');
    writeFileSync(script, JSON.stringify([[{ tool: 'act', args: { click: 'Save' } }, { text: 'saved' }]]));
    const model = openModel({ name: 'gpt-6.1-sol' }, { env: { PLAYTEST_MODEL: `script:${script}`, PLAYTEST_MODEL_TRANSCRIPT: transcript } });
    assert.equal(model.name, `script:${script}`);
    const thread = await model.startThread({ instructions: 'x', tools });
    assert.deepEqual(await thread.send('go', async () => 'clicked'), { text: 'saved' });
    const lines = readFileSync(transcript, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines[2], { event: 'tool', thread: 1, turn: 1, tool: 'act', args: { click: 'Save' }, ok: true, output: 'clicked' });
  } finally {
    done();
  }
});

test('without PLAYTEST_MODEL the Codex backend is chosen, lazily', () => {
  const model = openModel({ name: 'gpt-6.1-sol', effort: 'low' }, { env: {} });
  assert.equal(model.name, 'codex:gpt-6.1-sol@low');
  assert.throws(() => openModel({ name: 'x' }, { env: { PLAYTEST_MODEL: 'gpt-6.1-sol' } }), /PLAYTEST_MODEL must be script:<file>/);
});

test('a missing script file is reported when the first thread starts', async () => {
  const model = openModel({ name: 'x' }, { env: { PLAYTEST_MODEL: 'script:/no/such/script.json' } });
  await assert.rejects(model.startThread({ instructions: 'x', tools }), /script \/no\/such\/script\.json could not be read/);
});
