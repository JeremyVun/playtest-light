// The seams between the browser, environment, model and run layers. See docs/backlog/v1/design.md.

export type Locator = { role: string; name: string; nth?: number };

export type Target = { ref: string } | Locator;

export type Action =
  | { type: 'click'; target: Target }
  | { type: 'fill'; target: Target; value: string }
  | { type: 'select'; target: Target; option: string }
  | { type: 'press'; key: string; target?: Target }
  | { type: 'hover'; target: Target }
  | { type: 'navigate'; url: string }
  | { type: 'back' }
  | { type: 'wait'; until: Check[]; timeoutMs: number }
  | { type: 'scroll'; direction: 'up' | 'down'; target?: Target };

// Durable form stored in baselines: targets are always locators.
export type RecordedAction = Exclude<Action, { target: Target }> | (Extract<Action, { target: Target }> & { target: Locator });

export type Check =
  | { type: 'text'; value: string }
  | { type: 'url'; value: string }
  | { type: 'element'; locator: Locator }
  | { type: 'absent'; locator: Locator }
  | { type: 'enabled'; locator: Locator }
  | { type: 'disabled'; locator: Locator }
  | { type: 'value'; locator: Locator; value: string };

export type IssueKind =
  | 'console'
  | 'exception'
  | 'request'
  | 'page-overflow'
  | 'content-overflow'
  | 'covered'
  | 'broken-image';

export type Issue = {
  // Stable across runs: kind, URL path, width and element description, no timings or ids.
  key: string;
  kind: IssueKind;
  message: string;
  path: string;
  width?: number;
};

export type Snapshot = {
  url: string;
  title: string;
  // Model form: one node per line, actionable nodes carry a reference such as [e12].
  text: string;
  rawText?: string;
  // Normalized form, the drift oracle: no references, no focus, whitespace collapsed.
  lines: string[];
};

export type ActResult = {
  ok: boolean;
  // Present when the action had a target and it resolved.
  locator?: Locator;
  error?: string;
  settleMs: number;
  waitMs?: number;
  snapshot?: Snapshot;
  // Everything new since the previous act or goto: console, exceptions, failed requests,
  // and layout issues of a URL path this page had not visited yet, at every configured width.
  issues: Issue[];
};

export type CheckResult = { ok: boolean; detail?: string };

export type PageOptions = {
  baseUrl: string;
  viewport: [number, number];
  widths: number[];
  clock?: string;
  settleCapMs?: number;
};

export interface Page {
  goto(path: string): Promise<ActResult>;
  act(action: Action): Promise<ActResult>;
  snapshot(opts?: { actor?: boolean; raw?: boolean }): Promise<Snapshot>;
  check(check: Check): Promise<CheckResult>;
  fingerprint(): Promise<string>;
  screenshot(opts?: { fullPage?: boolean }): Promise<Buffer>;
  close(): Promise<void>;
}

export interface Browser {
  version: string;
  newPage(opts: PageOptions): Promise<Page>;
  // Closes the connection; the browser process keeps running.
  disconnect(): Promise<void>;
}

export type BrowserProcess = { pid: number; wsUrl: string; version: string };

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

// Returns the text handed back to the model as the tool's output.
export type ToolHandler = (name: string, args: unknown) => Promise<string>;

export type ModelUsage = { input: number; cached: number; output: number; reasoning: number };
export type DecisionInput = { prefix: string; message: string };
export type DecisionResult = { text: string; tool?: string; usage?: ModelUsage; ms: number; turnId?: string; backend?: string };

export interface ModelThread {
  decide(input: DecisionInput, onTool: ToolHandler): Promise<DecisionResult>;
  close(): Promise<void>;
}

export interface Model {
  name: string;
  startThread(opts: { instructions: string; tools: ToolSpec[] }): Promise<ModelThread>;
}

export type Config = {
  url?: string;
  seed?: string;
  browser: { viewport: [number, number]; widths: number[]; clock?: string; settleCapMs?: number };
  model: { name: string; effort?: string };
};

export type Project = {
  // The playtest/ directory.
  dir: string;
  cwd: string;
  seedCwd: string;
  runsDir: string;
  config: Config;
};

export type Story = {
  name: string;
  path: string;
  title: string;
  start: string;
  viewport?: [number, number];
  prose: string;
  doneWhen: string[];
};

export type BaselineStep = {
  action: RecordedAction;
  url: string;
  snapshot: string[];
  fingerprint: string;
  settleMs: number;
  issues: Issue[];
};

export type Baseline = {
  version: 2;
  story: string;
  url: string;
  seeded: boolean;
  platform: string;
  chrome: string;
  harness: string;
  viewport: [number, number];
  start: string;
  // Issues seen on opening `start`, before the first step.
  startIssues: Issue[];
  steps: BaselineStep[];
  checks: Check[];
};
