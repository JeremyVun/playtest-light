import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Evidence } from './evidence.ts';
import { openModel } from '../model/index.ts';
import { displayPath } from '../project.ts';
import type { Check, Project, Story, ToolHandler } from '../types.ts';
import { ActorContext, contextTools, CONTEXT_INSTRUCTIONS } from './context.ts';
import { Actor, actTool, doneTool, giveUpTool, waitTool, recorderInstructions, storyMessage } from './actor.ts';
import { writeBaseline } from './baseline.ts';
import { describeAction, describeCheck, seconds } from './format.ts';
import { buildBaseline, checkStory, type StoryResult } from './replay.ts';
import { checkSummary, shellQuote } from './report.ts';
import { openRun, openStory } from './session.ts';

const RECORDER_TOOLS = [actTool, waitTool, doneTool, giveUpTool];

export type RecordResult = {
  story: string;
  storyPath: string;
  url: string;
  seeded: boolean;
  runDir: string;
  model: string;
  outcome: 'done' | 'give_up' | 'unfinished';
  summary?: string;
  reason?: string;
  checks: Check[];
  deterministic: boolean;
  // Why the no-model replay did not reproduce the recording.
  determinism: string[];
  replay?: StoryResult;
  baseline?: string;
  // The kept actions as the baseline stores them, with the page each ended on.
  steps: string[];
  stats: { context?: ActorContext['stats']; ms: number; modelMs: number; waitMs?: number; responses?: number; turns: number; toolCalls: number; actions: number; failedActions: number; replayMs: number };
};

export async function recordStory(
  project: Project,
  story: Story,
  opts: { progress?: (line: string) => void; runDir: string; evidence: Evidence },
): Promise<RecordResult> {
  if (!project.config.url) throw new Error('No target URL; pass --url <url> or set url in playtest/config.json.');
  const started = performance.now();
  const { runDir, evidence } = opts;
  mkdirSync(runDir, { recursive: true });
  const context = new ActorContext(runDir, storyMessage(story), story.doneWhen);
  context.header(recorderInstructions() + CONTEXT_INSTRUCTIONS, contextTools(RECORDER_TOOLS));
  const log = context.log;
  const progress = opts.progress ?? (() => {});
  const model = openModel(project.config.model);
  const isScript = model.name.startsWith('script:');
  const result: RecordResult = {
    story: story.name,
    storyPath: story.path,
    url: project.config.url,
    seeded: Boolean(project.config.seed),
    runDir,
    model: model.name,
    outcome: 'unfinished',
    checks: [],
    deterministic: false,
    determinism: [],
    steps: [],
    stats: { ms: 0, modelMs: 0, turns: 0, toolCalls: 0, actions: 0, failedActions: 0, replayMs: 0 },
  };
  const threadStarting = model.startThread({ instructions: recorderInstructions() + CONTEXT_INSTRUCTIONS, tools: contextTools(RECORDER_TOOLS) });
  threadStarting.catch(() => {});
  const run = await openRun(project).catch(async (error) => {
    await threadStarting.then((thread) => thread.close()).catch(() => {});
    throw error;
  });
  run.evidence = evidence;
  evidence.phase(`${story.name}: recording`);
  try {
    const { page, opened } = await openStory(run, story);
    const actor = new Actor(page, log);
    log({ event: 'start', story: story.name, model: model.name, app: run.url, chrome: run.browser.version, startIssues: opened.issues });
    const modelStarted = performance.now();
    const thread = await threadStarting.catch(async (error) => {
      await page.close();
      throw error;
    });
    const onTool: ToolHandler = async (name, args) => {
      const before = actor.actions.length;
      const text = await actor.handle(name, args);
      if (name === 'act') {
        const added = actor.actions.slice(before).map(describeAction);
        const stop = /^stopped .*$/m.exec(text)?.[0];
        progress(`  act: ${added.length ? added.join(', ') : 'no actions ran'}${stop ? ` (${stop})` : ''}`);
      } else if (name === 'done') progress(`  done: ${text.split('\n')[0]}`);
      return text;
    };
    try {
      let noCalls = 0;
      for (let turn = 0; turn < 2020 && !actor.finish; turn++) {
        result.stats.turns++;
        const snapshot = await page.snapshot({ actor: true });
        actor.observe(snapshot);
        const input = context.input(snapshot, { decisionsLeft: 2020 - turn });
        const reply = await evidence.decision(() => thread.decide(input, (name, args) => context.handle(name, args, onTool))).catch(error => context.failure(error));
        context.result(reply);
        const wait = actor.takeWait();
        if (wait) {
          progress(`  ${describeAction(wait.actions[0])}`);
          const text = await actor.act(wait);
          context.log({ event: 'result', tool: 'wait_for', text: text.split('\npage ')[0] });
          progress(`  ${text.split('\n')[0]}`);
        }
        noCalls = reply.tool ? 0 : noCalls + 1;
        if (noCalls >= 3) break;
      }
    } finally {
      await thread.close().catch(() => {});
      await page.close();
    }
    result.stats.waitMs = actor.waitMs;
    result.stats.modelMs = Math.max(0, Math.round(performance.now() - modelStarted) - actor.waitMs);
    result.stats.toolCalls = actor.calls;
    result.stats.actions = actor.actions.length;
    result.stats.failedActions = actor.failedActions;
    result.stats.context = context.stats;
    if (!isScript) result.stats.responses = context.stats.decisions;

    const finish = actor.finish;
    if (finish?.kind === 'give_up') {
      result.outcome = 'give_up';
      result.reason = finish.reason;
    } else if (finish?.kind === 'done') {
      result.outcome = 'done';
      result.summary = finish.summary;
      result.checks = finish.checks;
      const replayStarted = performance.now();
      const built = await buildBaseline(run, story, actor.actions, finish.checks);
      result.baseline = join(runDir, 'baseline.json');
      writeBaseline(result.baseline, built.baseline);
      result.steps = built.baseline.steps.map((step) => `${describeAction(step.action)} -> ${step.url}`);
      if (built.failed) result.determinism.push(`replay could not run step ${built.failed.index + 1} ${describeAction(built.failed.action)}: ${built.failed.error}`);
      for (const c of built.checks.filter((c) => !c.ok)) result.determinism.push(`check failed on replay: ${describeCheck(c.check)}: ${c.detail}`);
      if (!result.determinism.length) {
        result.replay = await checkStory(run, built.baseline);
        if (result.replay.status === 'error') throw new Error(result.replay.error);
        if (result.replay.status !== 'pass') result.determinism.push(...checkSummary([result.replay], result.replay.ms, join(runDir, 'report.md')).slice(0, -1));
      }
      result.deterministic = result.determinism.length === 0;
      result.stats.replayMs = Math.round(performance.now() - replayStarted);
      log({ event: 'replay', deterministic: result.deterministic, determinism: result.determinism, ms: result.stats.replayMs });
    } else if (result.outcome === 'unfinished') {
      result.reason = 'the actor exhausted its decision budget without done or give_up';
    }
  } finally {
    await threadStarting.then((thread) => thread.close()).catch(() => {});
    await run.close();
  }
  result.stats.ms = Math.round(performance.now() - started);
  return result;
}

export function recordMarkdown(story: Story, r: RecordResult): string {
  const s = r.stats;
  const verdict = r.deterministic ? 'passed (deterministic)' : r.outcome === 'done' ? 'failed: the recording did not replay the same' : `failed: ${r.outcome.replace('_', ' ')}`;
  const out = [`# record ${r.story}: ${verdict}`, ''];
  out.push(`Target: ${r.url}; ${r.seeded ? 'seeded before each replay' : 'no seed; existing data'}`);
  out.push(`Story: ${story.title} (${displayPath(story.path)})`);
  out.push(`Model: ${r.model}${s.responses !== undefined ? `, ${s.responses} responses` : ''}, ${s.turns} turn${s.turns === 1 ? '' : 's'}, ${s.toolCalls} tool calls, ${seconds(s.modelMs)}`);
  out.push(`Actions: ${s.actions} kept${s.failedActions ? `, ${s.failedActions} failed (kept out of the baseline)` : ''}`);
  if (s.waitMs) out.push(`Waiting for the app: ${seconds(s.waitMs)}`);
  if (r.summary) out.push(`Summary: ${r.summary}`);
  if (r.reason) out.push(`Reason: ${r.reason}`);
  if (r.checks.length) out.push('', 'Checks:', '', ...r.checks.map((c) => `- ${describeCheck(c)}`));
  if (r.outcome === 'done') {
    out.push('', r.deterministic ? `Determinism: replayed twice with no model, identical (${seconds(s.replayMs)}).` : 'Determinism: the replay with no model differs:');
    if (!r.deterministic) out.push('', '```', ...r.determinism, '```');
  }
  if (r.steps.length) out.push('', '## Steps', '', `Start at ${story.start}`, ...r.steps.map((step, i) => `${i + 1}. ${step}`));
  out.push('', `Trajectory: ${displayPath(join(r.runDir, 'trajectory.jsonl'))}`);
  out.push(`Model context: ${displayPath(join(r.runDir, 'context.jsonl'))}`);
  if (r.baseline) out.push(`Pending baseline: ${displayPath(r.baseline)}`);
  if (r.deterministic) out.push(`Accept baseline: pt accept ${shellQuote(story.path)}`);
  return `${out.join('\n')}\n`;
}
