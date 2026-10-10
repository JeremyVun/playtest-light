import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CodexModel, type CodexThread } from '../src/model/codex.ts';
import { ScriptModel, type ScriptTurn } from '../src/model/script.ts';
import type { ToolHandler } from '../src/types.ts';

const live = process.env.PLAYTEST_LIVE === '1';

function filesUnder(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true }) as string[];
  } catch {
    return [];
  }
}

test('a real Sol thread calls a dummy tool three times and the scripted backend replays it identically', { skip: !live && 'set PLAYTEST_LIVE=1', timeout: 180_000 }, async () => {
  const tokens = new Map<number, string>();
  const handlerCalls: string[] = [];
  const handler: ToolHandler = async (name, args) => {
    const n = (args as { n: number }).n;
    handlerCalls.push(JSON.stringify([name, args]));
    if (!tokens.has(n)) tokens.set(n, randomBytes(4).toString('hex'));
    return `token ${tokens.get(n)}`;
  };

  const model = new CodexModel({ name: process.env.PLAYTEST_LIVE_MODEL ?? 'gpt-6.1-sol', effort: 'low' });
  const thread = (await model.startThread({
    instructions: 'You are a test agent. Use the ping tool exactly as asked.',
    tools: [
      {
        name: 'ping',
        description: 'Returns a secret token for the number n.',
        parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'], additionalProperties: false },
      },
    ],
  })) as CodexThread;
  const reply = await thread.send('Call ping with n=1, then n=2, then n=3, one after another. Then reply with the three tokens, one per line.', handler);
  await thread.close();
  await model.close();

  assert.deepEqual(handlerCalls, ['["ping",{"n":1}]', '["ping",{"n":2}]', '["ping",{"n":3}]']);
  for (const token of tokens.values()) assert.ok(reply.text.includes(token), `reply should quote ${token}: ${reply.text}`);
  const sessionFiles = filesUnder(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'));
  assert.equal(sessionFiles.filter((file) => file.includes(thread.id)).length, 0, 'an ephemeral thread writes no session file');

  const liveCalls = [...handlerCalls];
  const liveOutputs = [...tokens.values()].map((token) => `token ${token}`);
  handlerCalls.length = 0;
  const script: ScriptTurn[] = [[...liveCalls.map((call) => ({ tool: JSON.parse(call)[0], args: JSON.parse(call)[1] })), { text: reply.text }]];
  const outputs: string[] = [];
  const scripted = new ScriptModel(script, { transcript: (entry) => entry.event === 'tool' && outputs.push(entry.output) });
  const replay = await (await scripted.startThread({ instructions: '', tools: [] })).send('same', handler);
  assert.deepEqual(handlerCalls, liveCalls);
  assert.deepEqual(outputs, liveOutputs);
  assert.equal(replay.text, reply.text);
});
