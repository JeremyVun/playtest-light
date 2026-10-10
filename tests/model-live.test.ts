import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexDecisions } from '../src/model/decisions.ts';
import { ScriptModel } from '../src/model/script.ts';

test('real Sol decisions call each tool once and the scripted backend replays them', { skip: process.env.PLAYTEST_LIVE !== '1' && 'set PLAYTEST_LIVE=1', timeout: 180_000 }, async () => {
  const options = {
    instructions: 'You are a test agent. Call ping exactly once with the requested number.',
    tools: [{ name: 'ping', description: 'Echo a number.', parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'], additionalProperties: false } }],
  };
  const actor = await CodexDecisions.open({ name: process.env.PLAYTEST_LIVE_MODEL ?? 'gpt-6.1-sol', effort: 'low' }, options);
  const calls: { tool: string; args: unknown }[] = [];
  const outputs: string[] = [];
  try {
    for (const n of [1, 2, 3]) {
      const result = await actor.decide({ prefix: 'Test the ping tool.', message: `Call ping with n=${n}.` }, async (tool, args) => {
        calls.push({ tool, args });
        return JSON.stringify(args);
      });
      assert.equal(result.tool, 'ping');
      assert.ok(result.usage && result.usage.input > 0);
      outputs.push(result.text);
    }
  } finally { await actor.close(); }
  assert.deepEqual(calls, [1, 2, 3].map(n => ({ tool: 'ping', args: { n } })));
  const replay = await new ScriptModel([calls]).startThread(options);
  try {
    for (const output of outputs) assert.equal((await replay.decide({ prefix: '', message: '' }, async (_tool, args) => JSON.stringify(args))).text, output);
  } finally { await replay.close(); }
});
