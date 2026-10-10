import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexDecisions } from '../src/model/decisions.ts';
import type { Transport } from '../src/model/rpc.ts';
import { ScriptModel } from '../src/model/script.ts';

function server(opts: { failInterrupt?: boolean; lateUsage?: boolean } = {}) {
  let receive = (_: string) => {}, close = (_?: Error) => {};
  let thread = 0, request = 1000;
  const calls: { method: string; params: any }[] = [];
  const answers: any[] = [];
  const notify = (method: string, params: object) => receive(JSON.stringify({ method, params }));
  const tool = (params: object) => receive(JSON.stringify({ id: request++, method: 'item/tool/call', params }));
  let onTurn: (params: any) => void = () => {};
  const transport: Transport = {
    onMessage: cb => { receive = cb; }, onClose: cb => { close = cb; }, close: () => close(),
    send(text) {
      const m = JSON.parse(text);
      if (!m.method) { answers.push(m); return; }
      calls.push(m);
      if (m.id === undefined) return;
      let result: any = {};
      if (m.method === 'initialize') result = { userAgent: 'codex/test' };
      if (m.method === 'model/list') result = { data: [] };
      if (m.method === 'config/read') result = { config: {} };
      if (m.method === 'thread/start' || m.method === 'thread/fork') result = { thread: { id: `thread-${++thread}` } };
      if (m.method === 'turn/start') result = { turn: { id: `turn-${thread}` } };
      queueMicrotask(() => {
        if (m.method === 'turn/interrupt' && opts.failInterrupt) {
          receive(JSON.stringify({ id: m.id, error: { code: -1, message: 'interrupt rejected' } }));
          return;
        }
        receive(JSON.stringify({ id: m.id, result }));
        if (m.method === 'turn/start') onTurn({ ...m.params, turnId: `turn-${thread}` });
        if (m.method === 'turn/interrupt') {
          if (opts.lateUsage) notify('thread/tokenUsage/updated', { threadId: m.params.threadId, turnId: m.params.turnId, tokenUsage: { last: usage } });
          notify('turn/completed', { threadId: m.params.threadId, turn: { id: m.params.turnId, status: 'interrupted' } });
        }
      });
    },
  };
  return { transport, calls, answers, notify, tool, setTurn: (fn: typeof onTurn) => { onTurn = fn; }, drop: () => close(new Error('disconnected')) };
}
const config = { name: 'gpt-6.1-sol' };
const options = { instructions: 'Fixed instructions', tools: [{ name: 'act', description: 'Act', parameters: { type: 'object' } }] };
const usage = { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 20, reasoningOutputTokens: 0 };

test('bounded decisions fork the fixed source, reject extra tools and account usage once', async () => {
  const s = server();
  s.setTurn(p => {
    s.notify('rawResponse/completed', { threadId: p.threadId, turnId: p.turnId, usage });
    s.tool({ threadId: p.threadId, turnId: p.turnId, tool: 'act', arguments: { n: 1 } });
    s.tool({ threadId: p.threadId, turnId: p.turnId, tool: 'act', arguments: { n: 2 } });
  });
  const actor = await CodexDecisions.open(config, options, { connect: async () => s.transport });
  let mutations = 0;
  try {
    for (let n = 0; n < 3; n++) {
      const result = await actor.decide({ prefix: `stable\nevent ${n}`, message: `page-${n}` }, async () => { mutations++; return 'executed'; });
      assert.deepEqual(result.usage, { input: 1000, cached: 800, output: 20, reasoning: 0 });
      assert.equal(result.text, 'executed');
    }
    assert.equal(mutations, 3);
    const forks = s.calls.filter(c => c.method === 'thread/fork');
    assert.equal(forks.length, 2);
    for (const { params } of forks) {
      assert.equal(params.threadId, 'thread-1');
      assert.equal(params.beforeTurnId, 'turn-1');
      assert.equal(params.excludeTurns, true);
      assert.equal(params.modelProvider, 'playtest_http');
      assert.equal(params.config['features.shell_tool'], false);
    }
    const turns = s.calls.filter(c => c.method === 'turn/start');
    assert.ok(turns.every(c => c.params.environments.length === 0));
    assert.ok(!JSON.stringify(turns[2]).includes('page-1'));
    assert.equal(s.answers.filter(a => a.result?.success === false).length, 3);
  } finally { await actor.close(); }
  assert.equal(s.calls.filter(c => c.method === 'thread/unsubscribe').length, 2);
  assert.equal(s.calls.filter(c => c.method === 'thread/delete').length, 1);
});

test('disconnect after dispatch waits for the local mutation and never retries it', async () => {
  const s = server();
  s.setTurn(p => s.tool({ threadId: p.threadId, turnId: p.turnId, tool: 'act', arguments: {} }));
  const actor = await CodexDecisions.open(config, options, { connect: async () => s.transport });
  let mutations = 0, finished = false;
  await assert.rejects(actor.decide({ prefix: 'task', message: 'page' }, async () => {
    mutations++;
    s.drop();
    await new Promise(resolve => setTimeout(resolve, 10));
    finished = true;
    return 'saved';
  }), /connection closed/);
  assert.equal(mutations, 1);
  assert.equal(finished, true);
  await actor.close();
});

test('closing twice waits for an in-flight mutation and blocks overlapping decisions', async () => {
  const s = server();
  s.setTurn(p => s.tool({ threadId: p.threadId, turnId: p.turnId, tool: 'act', arguments: {} }));
  const actor = await CodexDecisions.open(config, options, { connect: async () => s.transport });
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  let completed = false;
  const decision = actor.decide({ prefix: 'task', message: 'page' }, async () => {
    entered.resolve(); await finish.promise; completed = true; return 'saved';
  });
  await assert.rejects(actor.decide({ prefix: 'other', message: 'page' }, async () => 'bad'), /already running/);
  await entered.promise;
  const first = actor.close(), second = actor.close();
  assert.equal(first, second);
  assert.equal(completed, false);
  finish.resolve();
  await Promise.all([first, second, decision]);
  assert.equal(completed, true);
});

test('scripted decisions also settle local work before closing', async () => {
  const actor = await new ScriptModel([[{ tool: 'act' }]]).startThread(options);
  const finish = Promise.withResolvers<void>();
  let completed = false;
  const decision = actor.decide({ prefix: 'task', message: 'page' }, async () => {
    await finish.promise; completed = true; return 'saved';
  });
  const closing = actor.close();
  assert.equal(completed, false);
  finish.resolve();
  await closing;
  assert.equal(completed, true);
  await decision;
});

test('usage delivered at interruption is counted and missing usage stays unknown', async () => {
  for (const lateUsage of [true, false]) {
    const s = server({ lateUsage });
    s.setTurn(p => {
      s.notify('rawResponse/completed', { threadId: p.threadId, turnId: p.turnId });
      s.tool({ threadId: p.threadId, turnId: p.turnId, tool: 'act', arguments: {} });
    });
    const actor = await CodexDecisions.open(config, options, { connect: async () => s.transport });
    try {
      const result = await actor.decide({ prefix: 'task', message: 'page' }, async () => 'saved');
      assert.equal(result.usage?.input, lateUsage ? 1000 : undefined);
    } finally { await actor.close(); }
  }
});

test('failed interruption ends with the mutation settled and no retry', async () => {
  const s = server({ failInterrupt: true });
  s.setTurn(p => {
    s.notify('rawResponse/completed', { threadId: p.threadId, turnId: p.turnId });
    s.tool({ threadId: p.threadId, turnId: p.turnId, tool: 'act', arguments: {} });
  });
  const actor = await CodexDecisions.open(config, options, { connect: async () => s.transport });
  let mutations = 0;
  try {
    await assert.rejects(actor.decide({ prefix: 'task', message: 'page' }, async () => { mutations++; return 'saved'; }), /interrupt rejected/);
    assert.equal(mutations, 1);
  } finally { await actor.close(); }
});
