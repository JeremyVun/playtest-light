import type { Config, DecisionInput, DecisionResult, ModelThread, ModelUsage, ToolHandler, ToolSpec } from '../types.ts';
import { connectCodex, explainTurnError, threadStartParams, type CodexConnection, type CodexOptions } from './codex.ts';

import { RpcError } from './rpc.ts';

const HTTP = { name: 'OpenAI', wire_api: 'responses', requires_openai_auth: true, supports_websockets: false };
const deferred = <T>() => Promise.withResolvers<T>();
const answer = (text: string, success = false) => ({ contentItems: [{ type: 'inputText', text }], success });

type Turn = {
  thread: string; id?: string; tool?: string; text: string; usage?: ModelUsage;
  end: ReturnType<typeof deferred<void>>; response: ReturnType<typeof deferred<void>>;
  work?: Promise<void>; error?: Error; cut: boolean; output: string;
};

export class CodexDecisions implements ModelThread {
  private source?: string;
  private sourceTurn?: string;
  private active?: Turn;
  private closed = false;
  private busy = false;
  private closing?: Promise<void>;
  private off: () => void;
  private connection: CodexConnection;
  private config: Config['model'];
  private opts: { instructions: string; tools: ToolSpec[] };

  private constructor(connection: CodexConnection, config: Config['model'], opts: { instructions: string; tools: ToolSpec[] }) {
    this.connection = connection; this.config = config; this.opts = opts;
    this.off = connection.rpc.onNotification((method, p) => this.notify(method, p));
    connection.rpc.onRequest(async (method, p) => {
      if (method === 'item/tool/call') return this.call(p);
      if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
      if (method === 'item/tool/requestUserInput') return { answers: {} };
      if (method === 'currentTime/read') return { currentTimeAt: Math.floor(Date.now() / 1000) };
      if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: 'decline' };
      if (method === 'execCommandApproval' || method === 'applyPatchApproval') return { decision: { denied: {} } };
      if (method === 'mcpServer/elicitation/request') return { action: 'decline', content: null, _meta: null };
      throw new RpcError(method, { code: -32601, message: 'Unsupported server request' });
    });
  }

  static async open(config: Config['model'], opts: { instructions: string; tools: ToolSpec[] }, options: CodexOptions = {}): Promise<CodexDecisions> {
    return new CodexDecisions(await connectCodex(options), config, opts);
  }

  async decide(input: DecisionInput, onTool: ToolHandler): Promise<DecisionResult> {
    if (this.closed) throw new Error('actor session is closed');
    if (this.busy) throw new Error('a decision is already running');
    this.busy = true;
    const started = performance.now();
    const { rpc, mcpServers } = this.connection;
    const release = rpc.hold();
    const params = threadStartParams(this.config, { ...this.opts, instructions: this.opts.instructions + '\n\n' + input.prefix }, mcpServers) as any;
    params.modelProvider = 'playtest_http';
    params.config['model_providers.playtest_http'] = HTTP;
    params.experimentalRawEvents = true;
    params.ephemeral = false;
    let turn: Turn | undefined;
    try {
      const source = !this.source;
      const { model, modelProvider, cwd, sandbox, approvalPolicy, baseInstructions, config } = params;
      const startedThread = source
        ? await rpc.request('thread/start', params)
        : await rpc.request('thread/fork', { threadId: this.source, beforeTurnId: this.sourceTurn, excludeTurns: true, ephemeral: true, model, modelProvider, cwd, sandbox, approvalPolicy, baseInstructions, config });
      const thread = startedThread.thread.id as string;
      if (source) this.source = thread;
      turn = { thread, text: '', output: '', cut: false, end: deferred<void>(), response: deferred<void>() };
      this.active = turn;
      this.handler = onTool;
      const response = await rpc.request('turn/start', { threadId: thread, environments: [], input: [{ type: 'text', text: input.message, text_elements: [] }], ...(this.config.effort ? { effort: this.config.effort } : {}) });
      turn.id ??= response.turn.id;
      await turn.end.promise;
      await turn.work;
      if (source) this.sourceTurn = turn.id;
      if (turn.error) throw turn.error;
      return { text: turn.tool ? turn.output : turn.text, tool: turn.tool, usage: turn.usage, ms: Math.round(performance.now() - started), turnId: turn.id, backend: `codex/${this.connection.serverVersion}` };
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { decision: { text: turn?.output ?? '', tool: turn?.tool, usage: turn?.usage, ms: Math.round(performance.now() - started), turnId: turn?.id, backend: `codex/${this.connection.serverVersion}` } });
    } finally {
      if (turn) {
        await turn.work;
        if (turn.thread !== this.source) await this.control('thread/unsubscribe', { threadId: turn.thread }).catch(() => {});
      }
      this.active = undefined;
      this.handler = undefined;
      this.busy = false;
      release();
    }
  }

  private handler?: ToolHandler;

  private async call(p: any): Promise<object> {
    const turn = this.active;
    if (!turn || this.closed || turn.thread !== p.threadId || turn.tool) return answer('Only one tool call is allowed per decision.');
    turn.tool = p.tool;
    turn.id ??= p.turnId;
    const calledAt = performance.now();
    turn.work = (async () => {
      try { turn.output = await this.handler!(p.tool, p.arguments); }
      catch (error) { turn.error = error as Error; }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([turn.response.promise, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, 1000 - (performance.now() - calledAt))); })]);
      clearTimeout(timer);
      await this.interrupt(turn);
    })();
    await turn.work;
    return answer('The next decision contains the result.', true);
  }

  private notify(method: string, p: any): void {
    const t = this.active;
    if (!t) return;
    if (method === 'transport/closed') {
      t.error = new Error('Codex connection closed; browser actions will not be retried.');
      t.response.resolve(); t.end.resolve();
      return;
    }
    if (p?.threadId !== t.thread) return;
    if (p.turnId && t.id && p.turnId !== t.id) return;
    if (method === 'turn/started') t.id ??= p.turn.id;
    if (method === 'rawResponse/completed' || method === 'thread/tokenUsage/updated') {
      const u = method === 'rawResponse/completed' ? p.usage : p.tokenUsage?.last;
      if (u && [u.inputTokens, u.cachedInputTokens, u.outputTokens].every(Number.isFinite))
        t.usage = { input: u.inputTokens, cached: u.cachedInputTokens, output: u.outputTokens, reasoning: u.reasoningOutputTokens ?? 0 };
      t.response.resolve();
    }
    if (method === 'item/completed' && p.item?.type === 'agentMessage') t.text = p.item.text;
    if (method === 'error' && !p.willRetry) t.error = new Error(explainTurnError(this.config.name, p.error));
    if (method === 'turn/completed') {
      if (p.turn.status !== 'completed' && !(p.turn.status === 'interrupted' && t.cut))
        t.error ??= new Error(explainTurnError(this.config.name, p.turn.error));
      t.end.resolve();
    }
  }

  private async interrupt(t: Turn): Promise<void> {
    if (t.cut) return;
    t.cut = true;
    try { await this.control('turn/interrupt', { threadId: t.thread, turnId: t.id }); }
    catch (error) { t.error ??= error as Error; t.end.resolve(); }
  }

  close(): Promise<void> {
    return this.closing ??= this.shutdown();
  }

  private async control(method: string, params: object): Promise<any> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.connection.rpc.request(method, params), new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Codex ${method} timed out; closing the actor connection.`));
          this.connection.rpc.close();
        }, 5000);
      })]);
    } finally { clearTimeout(timer); }
  }

  private async shutdown(): Promise<void> {
    this.closed = true;
    const t = this.active;
    if (t) {
      t.response.resolve();
      if (t.id) await this.interrupt(t);
      t.end.resolve();
      await t.work;
    }
    if (this.source) await this.control('thread/delete', { threadId: this.source }).catch(() => {});
    this.off();
    this.connection.rpc.close();
  }
}
