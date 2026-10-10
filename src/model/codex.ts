import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import type { Config, Model, ModelThread, ToolHandler, ToolSpec } from '../types.ts';
import { RpcClient, RpcError, type Transport } from './rpc.ts';
import { connectDaemon, controlSocketPath, spawnAppServer } from './transport.ts';

export type TransportMode = 'auto' | 'daemon' | 'spawn';

export type CodexOptions = {
  transport?: TransportMode;
  codexCommand?: string;
  // Sees every server notification; the spike uses it for timings.
  observe?: (method: string, params: any) => void;
  connect?: () => Promise<Transport>;
  // Merged over the thread/start params; `config` entries are merged over the lockdown.
  threadParams?: Record<string, any>;
};

export type CodexConnection = {
  rpc: RpcClient;
  transport: 'daemon' | 'spawn' | 'custom';
  serverVersion: string;
  models: string[];
  mcpServers: string[];
  // Why the daemon was not used, when it was skipped.
  fallback?: string;
};

const clientInfo = { name: 'playtest-lite', title: 'Playtest Lite', version: '0.1.0' };

const toolLockdown = {
  'features.shell_tool': false,
  'features.unified_exec': false,
  'features.apps': false,
  'features.plugins': false,
  'features.computer_use': false,
  'features.browser_use': false,
  'features.browser_use_external': false,
  'features.in_app_browser': false,
  'features.image_generation': false,
  'features.view_image': false,
  'features.tool_suggest': false,
  'features.skill_search': false,
  'features.goals': false,
  'features.hooks': false,
  'features.memories': false,
  'features.sleep_tool': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'agents.enabled': false,
  'tools.experimental_request_user_input.enabled': false,
  'tools.update_plan.enabled': false,
  web_search: 'disabled',
  'skills.include_instructions': false,
  include_environment_context: false,
  include_permissions_instructions: false,
  include_apps_instructions: false,
  include_collaboration_mode_instructions: false,
  'history.persistence': 'none',
  notify: [],
};

export function threadStartParams(
  config: Config['model'],
  opts: { instructions: string; tools: ToolSpec[] },
  mcpServers: string[],
): Record<string, unknown> {
  const overrides: Record<string, unknown> = { ...toolLockdown };
  for (const name of mcpServers) overrides[`mcp_servers.${name}.enabled`] = false;
  if (config.effort) overrides.model_reasoning_effort = config.effort;
  return {
    model: config.name,
    ephemeral: true,
    cwd: tmpdir(),
    environments: [],
    sandbox: 'read-only',
    approvalPolicy: 'untrusted',
    baseInstructions: opts.instructions,
    config: overrides,
    dynamicTools: opts.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    })),
  };
}

export async function connectCodex(model: string, options: CodexOptions = {}): Promise<CodexConnection> {
  const mode = options.transport ?? (process.env.PLAYTEST_CODEX_TRANSPORT as TransportMode | undefined) ?? 'auto';
  const command = options.codexCommand ?? 'codex';
  if (options.connect) return handshake(await options.connect(), 'custom');
  if (mode === 'spawn') return handshake(spawnAppServer(command), 'spawn');
  let daemon: CodexConnection;
  try {
    daemon = await handshake(await openDaemon(command), 'daemon');
  } catch (error) {
    const reason = `Codex app-server daemon unavailable: ${(error as Error).message}`;
    if (mode === 'daemon') throw new Error(reason);
    return { ...(await handshake(spawnAppServer(command), 'spawn')), fallback: reason };
  }
  // A daemon on an older package than the CLI may not offer newer models.
  if (mode === 'auto' && daemon.models.length && !daemon.models.includes(model)) {
    daemon.rpc.close();
    const reason = `the Codex daemon (${daemon.serverVersion}) does not offer ${model}; update it with \`codex app-server daemon update\``;
    return { ...(await handshake(spawnAppServer(command), 'spawn')), fallback: reason };
  }
  return daemon;
}

async function openDaemon(command: string): Promise<Transport> {
  try {
    return await connectDaemon();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error;
  }
  await promisify(execFile)(command, ['app-server', 'daemon', 'start'], { timeout: 30_000 });
  return connectDaemon(controlSocketPath(), 10_000);
}

async function handshake(transport: Transport, kind: CodexConnection['transport']): Promise<CodexConnection> {
  const rpc = new RpcClient(transport);
  try {
    const init = await withTimeout(
      rpc.request<{ userAgent: string }>('initialize', {
        clientInfo,
        capabilities: { experimentalApi: true, requestAttestation: false },
      }),
      30_000,
      'Codex app-server did not answer initialize',
    );
    rpc.notify('initialized');
    const serverVersion = /\/(\d+\.\d+\.\d+)/.exec(init.userAgent)?.[1] ?? 'unknown';
    const [list, config, account] = await withTimeout(Promise.all([
      rpc.request<{ data: { model: string }[] }>('model/list', { includeHidden: true, limit: 200 }).catch(() => ({ data: [] })),
      rpc.request<{ config: { mcp_servers?: Record<string, unknown> } }>('config/read', {}).catch(() => undefined),
      rpc.request<{ account: unknown; requiresOpenaiAuth: boolean }>('account/read', {}).catch(() => undefined),
    ]), 30_000, 'Codex app-server did not finish initialization');
    if (account && account.requiresOpenaiAuth && !account.account) throw new Error('Codex is not signed in; run `codex login`');
    return {
      rpc,
      transport: kind,
      serverVersion,
      models: list.data.map((m) => m.model),
      mcpServers: Object.keys(config?.config.mcp_servers ?? {}),
    };
  } catch (error) {
    rpc.close();
    throw error;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function explainTurnError(model: string, error: { message?: string; codexErrorInfo?: unknown } | null): string {
  const info = error?.codexErrorInfo;
  let message = error?.message ?? 'unknown error';
  try {
    message = JSON.parse(message).error?.message ?? message;
  } catch {}
  if (info === 'unauthorized') return `Codex sign-in is missing or expired; run \`codex login\` (${message})`;
  if (info === 'usageLimitExceeded') return `Codex usage limit reached (${message})`;
  if (/model/i.test(message) && /not (supported|found|exist)|unknown|unsupported/i.test(message))
    return `Model "${model}" is not available through Codex: ${message}`;
  return `Codex turn failed: ${message}`;
}

type ActiveTurn = {
  turnId?: string;
  onTool: ToolHandler;
  messages: { text: string; phase: string | null }[];
  error?: string;
  resolve: (value: { text: string }) => void;
  reject: (error: Error) => void;
};

export class CodexModel implements Model {
  name: string;
  private config: Config['model'];
  private options: CodexOptions;
  private connection: Promise<CodexConnection> | undefined;
  private threads = new Map<string, CodexThread>();

  constructor(config: Config['model'], options: CodexOptions = {}) {
    this.config = config;
    this.options = options;
    this.name = `codex:${config.name}${config.effort ? `@${config.effort}` : ''}`;
  }

  connect(): Promise<CodexConnection> {
    this.connection ??= connectCodex(this.config.name, this.options).then((connection) => {
      this.wire(connection.rpc);
      return connection;
    });
    this.connection.catch(() => {
      this.connection = undefined;
    });
    return this.connection;
  }

  async startThread(opts: { instructions: string; tools: ToolSpec[]; bounded?: boolean }): Promise<ModelThread> {
    if (opts.bounded) return (await import('./decisions.ts')).CodexDecisions.open(this.config, opts, this.options);
    const { rpc, mcpServers } = await this.connect();
    const params = threadStartParams(this.config, opts, mcpServers);
    const extra = this.options.threadParams;
    if (extra) Object.assign(params, extra, { config: { ...(params.config as object), ...extra.config } });
    let started: { thread: { id: string } };
    try {
      started = await rpc.request('thread/start', params);
    } catch (error) {
      throw new Error(`Codex could not start a thread: ${(error as Error).message}`);
    }
    const thread = new CodexThread(rpc, started.thread.id, this.config, () => this.threads.delete(started.thread.id));
    this.threads.set(started.thread.id, thread);
    return thread;
  }

  async close(): Promise<void> {
    for (const thread of this.threads.values()) await thread.close();
    const connection = await this.connection?.catch(() => undefined);
    connection?.rpc.close();
    this.connection = undefined;
  }

  private wire(rpc: RpcClient): void {
    rpc.onNotification((method, params) => {
      this.options.observe?.(method, params);
      if (method === 'transport/closed') {
        this.connection = undefined;
        for (const thread of this.threads.values()) thread.fail(`Codex app-server connection closed: ${params.message}`);
        return;
      }
      if (params?.threadId) this.threads.get(params.threadId)?.notify(method, params);
    });
    rpc.onRequest(async (method, params) => {
      switch (method) {
        case 'item/tool/call': {
          const thread = this.threads.get(params.threadId);
          if (!thread) throw new RpcError(method, { code: -32602, message: `unknown thread ${params.threadId}` });
          return thread.callTool(params.tool, params.arguments);
        }
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval':
          return { decision: 'decline' };
        case 'execCommandApproval':
        case 'applyPatchApproval':
          return { decision: { denied: { rejection: 'Only the playtest tools are available.' } } };
        case 'item/permissions/requestApproval':
          return { permissions: {}, scope: 'turn' };
        case 'item/tool/requestUserInput':
          return { answers: {} };
        case 'mcpServer/elicitation/request':
          return { action: 'decline', content: null, _meta: null };
        case 'currentTime/read':
          return { currentTimeAt: Math.floor(Date.now() / 1000) };
        default:
          throw new RpcError(method, { code: -32601, message: 'not supported by playtest-lite' });
      }
    });
  }
}

export class CodexThread implements ModelThread {
  id: string;
  private rpc: RpcClient;
  private config: Config['model'];
  private active: ActiveTurn | undefined;
  private onClose: () => void;
  private closed = false;

  constructor(rpc: RpcClient, id: string, config: Config['model'], onClose: () => void) {
    this.rpc = rpc;
    this.id = id;
    this.config = config;
    this.onClose = onClose;
  }

  send(message: string, onTool: ToolHandler): Promise<{ text: string }> {
    if (this.closed) return Promise.reject(new Error('thread is closed'));
    if (this.active) return Promise.reject(new Error('a turn is already running on this thread'));
    const release = this.rpc.hold();
    return new Promise<{ text: string }>((resolve, reject) => {
      const turn: ActiveTurn = { onTool, messages: [], resolve, reject };
      this.active = turn;
      this.rpc
        .request<{ turn: { id: string } }>('turn/start', {
          threadId: this.id,
          input: [{ type: 'text', text: message, text_elements: [] }],
          ...(this.config.effort ? { effort: this.config.effort } : {}),
        })
        .then((response) => {
          turn.turnId ??= response.turn.id;
        })
        .catch((error: Error) => this.finish(turn, new Error(`Codex could not start a turn: ${error.message}`)));
    }).finally(release);
  }

  async callTool(name: string, args: unknown): Promise<object> {
    const turn = this.active;
    if (!turn) return { contentItems: [{ type: 'inputText', text: 'No turn is running.' }], success: false };
    try {
      const text = await turn.onTool(name, args);
      return { contentItems: [{ type: 'inputText', text }], success: true };
    } catch (error) {
      return { contentItems: [{ type: 'inputText', text: (error as Error).message }], success: false };
    }
  }

  notify(method: string, params: any): void {
    const turn = this.active;
    if (!turn) return;
    if (method === 'turn/started') turn.turnId ??= params.turn.id;
    else if (method === 'item/completed' && params.item.type === 'agentMessage')
      turn.messages.push({ text: params.item.text, phase: params.item.phase ?? null });
    else if (method === 'error' && !params.willRetry) turn.error = explainTurnError(this.config.name, params.error);
    else if (method === 'turn/completed') {
      const { status, error } = params.turn;
      if (status === 'completed') {
        const final = turn.messages.filter((m) => m.phase === 'final_answer').at(-1) ?? turn.messages.at(-1);
        this.finish(turn, undefined, final?.text ?? '');
      } else if (status === 'interrupted') this.finish(turn, new Error('Codex turn was interrupted'));
      else this.finish(turn, new Error(turn.error ?? explainTurnError(this.config.name, error)));
    }
  }

  fail(message: string): void {
    if (this.active) this.finish(this.active, new Error(message));
    this.closed = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const turn = this.active;
    if (turn?.turnId) await this.rpc.request('turn/interrupt', { threadId: this.id, turnId: turn.turnId }).catch(() => {});
    if (turn) this.finish(turn, new Error('thread closed during a turn'));
    await this.rpc.request('thread/unsubscribe', { threadId: this.id }).catch(() => {});
    this.onClose();
  }

  private finish(turn: ActiveTurn, error?: Error, text = ''): void {
    if (this.active !== turn) return;
    this.active = undefined;
    if (error) turn.reject(error);
    else turn.resolve({ text });
  }
}
