import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Transport } from '../src/model/rpc.ts';
import { connectCodex, explainTurnError, threadStartParams } from '../src/model/codex.ts';
import { CodexDecisions } from '../src/model/decisions.ts';
import type { ToolSpec } from '../src/types.ts';

type ServerApi = {
  notify(method: string, params: object): void;
  request(method: string, params: object): Promise<any>;
};
type Handler = (method: string, params: any, api: ServerApi) => unknown;

// An in-memory app-server: `handle` answers client requests; `api` lets it push notifications and requests.
function fakeServer(handle: Handler) {
  const received: { method: string; params: any }[] = [];
  let toClient: (message: string) => void = () => {};
  let closeClient: (error?: Error) => void = () => {};
  const waiting = new Map<number, (result: any) => void>();
  let nextId = 1000;
  const api: ServerApi = {
    notify: (method, params) => setImmediate(() => toClient(JSON.stringify({ method, params }))),
    request: (method, params) =>
      new Promise((resolve) => {
        const id = nextId++;
        waiting.set(id, resolve);
        setImmediate(() => toClient(JSON.stringify({ id, method, params })));
      }),
  };
  const transport: Transport = {
    send(text) {
      const message = JSON.parse(text);
      if (message.method === undefined) {
        waiting.get(message.id)?.(message.result ?? { error: message.error });
        waiting.delete(message.id);
        return;
      }
      received.push({ method: message.method, params: message.params });
      if (message.id === undefined) return;
      Promise.resolve()
        .then(() => handle(message.method, message.params, api))
        .then(
          (result) => setImmediate(() => toClient(JSON.stringify({ id: message.id, result: result ?? {} }))),
          (error: Error) => setImmediate(() => toClient(JSON.stringify({ id: message.id, error: { code: -32000, message: error.message } }))),
        );
    },
    onMessage: (handler) => {
      toClient = handler;
    },
    onClose: (handler) => {
      closeClient = handler;
    },
    close: () => closeClient(),
  };
  return { transport, received, drop: (error: Error) => closeClient(error) };
}

const base: Handler = (method) => {
  if (method === 'initialize') return { userAgent: 'codex/0.160.0 (test)' };
  if (method === 'model/list') return { data: [{ model: 'gpt-6.1-sol' }] };
  if (method === 'config/read') return { config: { mcp_servers: { blender: {}, docs: {} } } };
  if (method === 'thread/start') return { thread: { id: 'th-1' } };
  return undefined;
};

const ping: ToolSpec = { name: 'ping', description: 'ping', parameters: { type: 'object', properties: { n: { type: 'number' } } } };

function turnScript(steps: (api: ServerApi) => Promise<void>): Handler {
  return (method, params, api) => {
    if (method === 'turn/start') {
      setImmediate(async () => {
        api.notify('turn/started', { threadId: params.threadId, turn: { id: 'turn-1' } });
        await steps(api);
      });
      return { turn: { id: 'turn-1', status: 'inProgress', items: [] } };
    }
    return base(method, params, api);
  };
}

const completed = (status = 'completed', error: object | null = null) => ({ threadId: 'th-1', turn: { id: 'turn-1', status, error, items: [] } });

test('thread/start asks for an ephemeral thread with only our tools and our instructions', () => {
  const params = threadStartParams({ name: 'gpt-6.1-sol', effort: 'low' }, { instructions: 'Be a tester.', tools: [ping] }, ['blender']) as any;
  assert.equal(params.model, 'gpt-6.1-sol');
  assert.equal(params.ephemeral, true);
  assert.equal(params.baseInstructions, 'Be a tester.');
  assert.deepEqual(params.environments, []);
  assert.equal(params.sandbox, 'read-only');
  assert.deepEqual(params.dynamicTools, [{ type: 'function', name: 'ping', description: 'ping', inputSchema: ping.parameters }]);
  assert.equal(params.config['features.shell_tool'], false);
  assert.equal(params.config['features.unified_exec'], false);
  assert.equal(params.config['agents.enabled'], false);
  assert.equal(params.config.web_search, 'disabled');
  assert.equal(params.config['mcp_servers.blender.enabled'], false);
  assert.equal(params.config.model_reasoning_effort, 'low');
  assert.deepEqual(params.config.notify, []);
});

test('approval and input requests are declined', async () => {
  const answers: Record<string, any> = {};
  const server = fakeServer(
    turnScript(async (api) => {
      for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'execCommandApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request', 'account/chatgptAuthTokens/refresh'])
        answers[method] = await api.request(method, { threadId: 'th-1' });
      api.notify('turn/completed', completed());
    }),
  );
  const thread = await CodexDecisions.open({ name: 'gpt-6.1-sol' }, { instructions: 'x', tools: [] }, { connect: async () => server.transport });
  assert.equal((await thread.decide({ prefix: '', message: 'go' }, async () => '')).text, '');
  await thread.close();
  assert.deepEqual(answers['item/commandExecution/requestApproval'], { decision: 'decline' });
  assert.deepEqual(answers['item/fileChange/requestApproval'], { decision: 'decline' });
  assert.ok(answers.execCommandApproval.decision.denied);
  assert.deepEqual(answers['item/tool/requestUserInput'], { answers: {} });
  assert.equal(answers['mcpServer/elicitation/request'].action, 'decline');
  assert.ok(answers['account/chatgptAuthTokens/refresh'].error, 'token refresh is never answered by us');
});

test('a failed turn rejects with a readable reason', async () => {
  const server = fakeServer(
    turnScript(async (api) => {
      const error = { message: '{"error":{"message":"Your session has expired."}}', codexErrorInfo: 'unauthorized' };
      api.notify('error', { threadId: 'th-1', turnId: 'turn-1', willRetry: false, error });
      api.notify('turn/completed', completed('failed', error));
    }),
  );
  const thread = await CodexDecisions.open({ name: 'gpt-6.1-sol' }, { instructions: 'x', tools: [] }, { connect: async () => server.transport });
  await assert.rejects(thread.decide({ prefix: '', message: 'go' }, async () => ''), /sign-in is missing or expired; run CODEX_HOME=.* codex login \(Your session has expired\.\)/);
});

test('an unknown model names the model', () => {
  const message = explainTurnError('gpt-9', {
    message: '{"type":"error","status":400,"error":{"message":"The \'gpt-9\' model is not supported when using Codex with a ChatGPT account."}}',
    codexErrorInfo: 'other',
  });
  assert.match(message, /^Model "gpt-9" is not available through Codex: The 'gpt-9' model is not supported/);
});

test('a missing Codex CLI says how to fix it', async () => {
  await assert.rejects(connectCodex({ codexCommand: 'codex-not-installed-here' }), /`codex-not-installed-here` is not on PATH; install the Codex CLI and run `codex login`/);
});

test('a signed-out Codex is reported before any thread starts', async () => {
  const server = fakeServer((method, params, api) => (method === 'account/read' ? { account: null, requiresOpenaiAuth: true } : base(method, params, api)));
  await assert.rejects(connectCodex({ connect: async () => server.transport }), /Playtest is not signed in; run CODEX_HOME=.* codex login/);
});
