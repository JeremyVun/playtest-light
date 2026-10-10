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

test('decisions consume one scripted step and propagate tool failures', async () => {
  const entries: TranscriptEntry[] = [];
  const model = new ScriptModel([[{ tool: 'act', args: { n: 1 } }, { text: 'first' }], [{ tool: 'done' }]], { transcript: entry => entries.push(entry) });
  const thread = await model.startThread({ instructions: 'x', tools });
  const input = { prefix: 'task', message: 'page' };
  const calls: string[] = [];
  const handler = async (name: string) => {
    calls.push(name);
    if (name === 'done') throw new Error('checks failed');
    return 'ran';
  };
  assert.equal((await thread.decide(input, handler)).text, 'ran');
  assert.equal((await thread.decide(input, handler)).text, 'first');
  await assert.rejects(thread.decide(input, handler), /checks failed/);
  assert.deepEqual(calls, ['act', 'done']);
  assert.equal(model.remaining, 0);
  assert.equal(entries.filter(e => e.event === 'send').length, 3);
  await assert.rejects(thread.decide(input, handler), /no scripted turn left/);
  await thread.close();
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
    assert.equal((await thread.decide({ prefix: '', message: 'go' }, async () => 'clicked')).text, 'clicked');
    assert.equal((await thread.decide({ prefix: '', message: 'go' }, async () => '')).text, 'saved');
    const lines = readFileSync(transcript, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines[2], { event: 'tool', thread: 1, turn: 1, tool: 'act', args: { click: 'Save' }, ok: true, output: 'clicked' });
  } finally {
    done();
  }
});

test('without PLAYTEST_MODEL the Codex backend is chosen, lazily', () => {
  const model = openModel({ name: 'gpt-6.1-sol', effort: 'low' }, { env: {} });
  assert.equal(model.name, 'codex:gpt-6.1-sol@low');
  assert.throws(() => openModel({ name: 'x' }, { env: { PLAYTEST_MODEL: 'script:' } }), /PLAYTEST_MODEL must be script:<file>/);
  assert.throws(() => openModel({ name: 'x' }, { env: { PLAYTEST_MODEL: 'gpt-6.1-sol' } }), /PLAYTEST_MODEL must be script:<file>/);
});

test('a missing script file is reported when the first thread starts', async () => {
  const model = openModel({ name: 'x' }, { env: { PLAYTEST_MODEL: 'script:/no/such/script.json' } });
  await assert.rejects(model.startThread({ instructions: 'x', tools }), /script \/no\/such\/script\.json could not be read/);
});
