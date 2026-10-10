import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config, ToolSpec } from '../types.ts';
import { RpcClient, type Transport } from './rpc.ts';
import { spawnAppServer } from './transport.ts';

export type CodexOptions = { codexCommand?: string; connect?: () => Promise<Transport> };
export type CodexConnection = { rpc: RpcClient; serverVersion: string; mcpServers: string[] };
const actorHome = join(homedir(), '.playtest-lite', 'codex');
const login = `CODEX_HOME=${actorHome} codex login`;

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

export async function connectCodex(options: CodexOptions = {}): Promise<CodexConnection> {
  const transport = options.connect ? await options.connect() : spawnAppServer(options.codexCommand, actorHome);
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
    const [config, account] = await withTimeout(Promise.all([
      rpc.request<{ config: { mcp_servers?: Record<string, unknown> } }>('config/read', {}).catch(() => undefined),
      rpc.request<{ account: unknown; requiresOpenaiAuth: boolean }>('account/read', {}).catch(() => undefined),
    ]), 30_000, 'Codex app-server did not finish initialization');
    if (account && account.requiresOpenaiAuth && !account.account) throw new Error(`Playtest is not signed in; run ${login}`);
    return {
      rpc,
      serverVersion,
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
  if (info === 'unauthorized') return `Codex sign-in is missing or expired; run ${login} (${message})`;
  if (info === 'usageLimitExceeded') return `Codex usage limit reached (${message})`;
  if (/model/i.test(message) && /not (supported|found|exist)|unknown|unsupported/i.test(message))
    return `Model "${model}" is not available through Codex: ${message}`;
  return `Codex turn failed: ${message}`;
}
