import { readFileSync, appendFileSync } from 'node:fs';
import type { Model, ModelThread, ToolHandler, ToolSpec } from '../types.ts';

export type ScriptStep = { tool: string; args?: unknown } | { text: string };
export type ScriptTurn = ScriptStep[];

export type TranscriptEntry =
  | { event: 'thread'; thread: number; tools: string[] }
  | { event: 'send'; thread: number; turn: number; message: string }
  | { event: 'tool'; thread: number; turn: number; tool: string; args: unknown; ok: boolean; output: string }
  | { event: 'text'; thread: number; turn: number; text: string };

export function parseScript(json: string, source = 'script'): ScriptTurn[] {
  let turns: unknown;
  try {
    turns = JSON.parse(json);
  } catch (error) {
    throw new Error(`${source}: not valid JSON (${(error as Error).message})`);
  }
  if (!Array.isArray(turns)) throw new Error(`${source}: expected an array of turns`);
  turns.forEach((turn, t) => {
    if (!Array.isArray(turn)) throw new Error(`${source}: turn ${t} must be an array of steps`);
    turn.forEach((step: any, s: number) => {
      const where = `${source}: turn ${t} step ${s}`;
      if (typeof step !== 'object' || step === null) throw new Error(`${where} must be an object`);
      if ('text' in step) {
        if (typeof step.text !== 'string') throw new Error(`${where}: "text" must be a string`);
        if (s !== turn.length - 1) throw new Error(`${where}: "text" must be the turn's last step`);
      } else if (typeof step.tool !== 'string') throw new Error(`${where}: needs "tool" (a name) or "text"`);
    });
  });
  return turns as ScriptTurn[];
}

export class ScriptModel implements Model {
  name: string;
  private turns: ScriptTurn[];
  private cursor = 0;
  private threads = 0;
  private record: (entry: TranscriptEntry) => void;

  constructor(turns: ScriptTurn[], opts: { name?: string; transcript?: string | ((entry: TranscriptEntry) => void) } = {}) {
    this.turns = turns;
    this.name = opts.name ?? 'script';
    const transcript = opts.transcript;
    this.record =
      typeof transcript === 'function'
        ? transcript
        : transcript
          ? (entry) => appendFileSync(transcript, `${JSON.stringify(entry)}\n`)
          : () => {};
  }

  static fromFile(path: string, transcript?: string): ScriptModel {
    let json: string;
    try {
      json = readFileSync(path, 'utf8');
    } catch (error) {
      throw new Error(`PLAYTEST_MODEL script ${path} could not be read: ${(error as Error).message}`);
    }
    return new ScriptModel(parseScript(json, path), { name: `script:${path}`, transcript });
  }

  get remaining(): number {
    return this.turns.length - this.cursor;
  }

  async startThread(opts: { instructions: string; tools: ToolSpec[] }): Promise<ModelThread> {
    const thread = ++this.threads;
    this.record({ event: 'thread', thread, tools: opts.tools.map((t) => t.name) });
    let closed = false;
    let busy = false;
    let turnInThread = 0;
    let stepInTurn = 0;
    let settled = Promise.resolve();
    let finish = () => {};
    return {
      decide: async (input, onTool) => {
        if (closed) throw new Error('thread is closed');
        if (busy) throw new Error('a decision is already running');
        const steps = this.turns[this.cursor];
        if (!steps) throw new Error(`${this.name}: no scripted turn left`);
        const step = steps[stepInTurn++];
        if (stepInTurn >= steps.length) { this.cursor++; stepInTurn = 0; }
        const turn = ++turnInThread;
        const started = performance.now();
        this.record({ event: 'send', thread, turn, message: input.prefix + '\n' + input.message });
        busy = true;
        settled = new Promise(resolve => { finish = resolve; });
        try {
          if (!step || 'text' in step) return { text: step?.text ?? '', ms: Math.round(performance.now() - started) };
          const output = await onTool(step.tool, step.args ?? {});
          this.record({ event: 'tool', thread, turn, tool: step.tool, args: step.args ?? {}, ok: true, output });
          return { text: output, tool: step.tool, ms: Math.round(performance.now() - started) };
        } finally { busy = false; finish(); }
      },
      send: async (message: string, onTool: ToolHandler) => {
        if (closed) throw new Error('thread is closed');
        if (busy) throw new Error('a turn is already running on this thread');
        const steps = this.turns[this.cursor];
        if (!steps) throw new Error(`${this.name}: no scripted turn left for message ${this.cursor + 1}`);
        this.cursor++;
        busy = true;
        settled = new Promise(resolve => { finish = resolve; });
        const turn = ++turnInThread;
        this.record({ event: 'send', thread, turn, message });
        try {
          let text = '';
          for (const step of steps) {
            if ('text' in step) {
              text = step.text;
              this.record({ event: 'text', thread, turn, text });
              continue;
            }
            const args = step.args ?? {};
            try {
              const output = await onTool(step.tool, args);
              this.record({ event: 'tool', thread, turn, tool: step.tool, args, ok: true, output });
            } catch (error) {
              this.record({ event: 'tool', thread, turn, tool: step.tool, args, ok: false, output: (error as Error).message });
            }
          }
          return { text };
        } finally {
          busy = false; finish();
        }
      },
      close: async () => {
        closed = true;
        await settled;
      },
    };
  }
}
