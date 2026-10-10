// Milestone 1, spike 1: Codex app-server latency and tool-call timing.
// Usage: node tools/spike-codex.ts [--model gpt-6.1-sol] [--efforts low,medium] [--runs 1] [--transport auto|daemon|spawn]
import { parseArgs } from 'node:util';
import { CodexModel, type TransportMode } from '../src/model/codex.ts';
import { RpcClient } from '../src/model/rpc.ts';
import { connectDaemon, spawnAppServer } from '../src/model/transport.ts';
import type { ToolSpec } from '../src/types.ts';

const { values } = parseArgs({
  options: {
    model: { type: 'string', default: 'gpt-6.1-sol' },
    efforts: { type: 'string', default: 'low,medium' },
    runs: { type: 'string', default: '1' },
    transport: { type: 'string', default: 'auto' },
  },
});
const model = values.model!;
const efforts = values.efforts!.split(',');
const runs = Number(values.runs);

const ping: ToolSpec = {
  name: 'ping',
  description: 'Records the number n and returns "ok <n>".',
  parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'], additionalProperties: false },
};
const instructions = 'You are a test agent. Do exactly what the user asks using the ping tool, then reply briefly.';

const scenarios = {
  one: { prompt: 'Call ping once with n=1, then reply with its result.', delayMs: 0 },
  five: { prompt: 'Call ping five times with n=1,2,3,4,5, in order, each after the previous returns. Then reply with the five results.', delayMs: 0 },
  parallel: {
    prompt: 'Call ping for n=1..5. The calls are independent: issue all five at once, concurrently, not one after another. Then reply with the five results.',
    delayMs: 300,
  },
};

const now = () => performance.now();
const round = (n: number | undefined) => (n === undefined || Number.isNaN(n) ? '-' : String(Math.round(n)));
const median = (xs: number[]) => {
  const s = xs.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};

async function connection(): Promise<Record<string, number>> {
  let t = now();
  const transport = await connectDaemon();
  const connect = now() - t;
  const rpc = new RpcClient(transport);
  t = now();
  await rpc.request('initialize', {
    clientInfo: { name: 'playtest-lite-spike', title: null, version: '0.1.0' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  rpc.notify('initialized');
  const initialize = now() - t;
  t = now();
  await rpc.request('model/list', { includeHidden: true, limit: 200 });
  const modelList = now() - t;
  rpc.close();
  t = now();
  const spawned = new RpcClient(spawnAppServer());
  await spawned.request('initialize', {
    clientInfo: { name: 'playtest-lite-spike', title: null, version: '0.1.0' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  const spawnInitialize = now() - t;
  spawned.close();
  return { connect, initialize, modelList, spawnInitialize };
}

type Run = {
  threadStart: number;
  promptIn: number;
  firstCall: number;
  lastCallDone: number;
  turn: number;
  calls: number;
  maxInFlight: number;
  responses: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  execToFirstCall: number;
  firstCallBeforeResponseEnd: number;
  program: string;
};

async function runScenario(effort: string, scenario: keyof typeof scenarios, transport: TransportMode): Promise<Run> {
  const { prompt, delayMs } = scenarios[scenario];
  const marks: { promptIn?: number; execDone?: number; responseEnds: number[]; usage: any[]; program: string[] } = { responseEnds: [], usage: [], program: [] };
  let threadId = '';
  const codex = new CodexModel(
    { name: model, effort },
    {
      transport,
      threadParams: { experimentalRawEvents: true },
      observe: (method, params) => {
        if (params?.threadId !== threadId) return;
        if (method === 'item/started' && params.item.type === 'userMessage') marks.promptIn ??= now();
        else if (method === 'rawResponseItem/completed' && params.item.type === 'custom_tool_call') {
          marks.execDone ??= now();
          marks.program.push(params.item.input);
        } else if (method === 'rawResponse/completed') {
          marks.responseEnds.push(now());
          marks.usage.push(params.usage);
        }
      },
    },
  );
  await codex.connect();
  let t = now();
  const thread = (await codex.startThread({ instructions, tools: [ping] })) as import('../src/model/codex.ts').CodexThread;
  threadId = thread.id;
  const threadStart = now() - t;
  const calls: number[] = [];
  let done = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  t = now();
  await thread.send(prompt, async (_name, args) => {
    calls.push(now());
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    inFlight--;
    done = now();
    return `ok ${(args as { n: number }).n}`;
  });
  const turn = now() - t;
  await thread.close();
  await codex.close();
  const first = calls[0] ?? NaN;
  const execResponseEnd = marks.responseEnds.find((end) => end >= (marks.execDone ?? Infinity)) ?? NaN;
  const sum = (key: string) => marks.usage.reduce((total, u) => total + (u?.[key] ?? 0), 0);
  return {
    threadStart,
    promptIn: (marks.promptIn ?? NaN) - t,
    firstCall: first - t,
    lastCallDone: done - first,
    turn,
    calls: calls.length,
    maxInFlight,
    responses: marks.usage.length,
    inputTokens: sum('inputTokens'),
    cachedTokens: sum('cachedInputTokens'),
    outputTokens: sum('outputTokens') + sum('reasoningOutputTokens'),
    execToFirstCall: first - (marks.execDone ?? NaN),
    firstCallBeforeResponseEnd: execResponseEnd - first,
    program: marks.program.join('\n---\n'),
  };
}

const conn = await connection();
console.log('Connection (ms):');
console.log(`  daemon socket connect + WebSocket upgrade  ${round(conn.connect)}`);
console.log(`  initialize                                 ${round(conn.initialize)}`);
console.log(`  model/list                                 ${round(conn.modelList)}`);
console.log(`  spawned app-server start + initialize      ${round(conn.spawnInitialize)}`);
console.log('');

const transport = values.transport as TransportMode;
const rows: string[][] = [];
const programs: string[] = [];
for (const effort of efforts) {
  for (const scenario of Object.keys(scenarios) as (keyof typeof scenarios)[]) {
    const results: Run[] = [];
    for (let i = 0; i < runs; i++) {
      try {
        results.push(await runScenario(effort, scenario, transport));
      } catch (error) {
        console.error(`${effort} ${scenario}: ${(error as Error).message}`);
      }
    }
    if (!results.length) continue;
    const m = (key: keyof Run) => round(median(results.map((r) => r[key] as number)));
    rows.push([
      effort,
      scenario,
      m('threadStart'),
      m('promptIn'),
      m('firstCall'),
      m('lastCallDone'),
      m('turn'),
      m('calls'),
      m('maxInFlight'),
      m('responses'),
      `${m('inputTokens')}/${m('cachedTokens')}`,
      m('outputTokens'),
      m('execToFirstCall'),
      m('firstCallBeforeResponseEnd'),
    ]);
    programs.push(`${effort} ${scenario}: ${results[0]!.program.replace(/\n/g, ' ⏎ ')}`);
  }
}

const header = [
  'effort',
  'scenario',
  'thread start',
  'turn start → prompt accepted',
  'turn start → 1st call',
  '1st call → last call done',
  'turn total',
  'calls',
  'max in flight',
  'model responses',
  'input/cached tokens',
  'output tokens',
  'exec item → 1st call',
  '1st call → end of its response stream',
];
console.log(`Turns (ms, median of ${runs}; model ${model}; transport ${transport}):`);
console.log(`| ${header.join(' | ')} |`);
console.log(`|${header.map(() => '---').join('|')}|`);
for (const row of rows) console.log(`| ${row.join(' | ')} |`);
console.log('\nPrograms the model wrote (code mode exec input):');
for (const line of programs) console.log(`  ${line}`);
