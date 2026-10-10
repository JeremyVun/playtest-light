import type { Config, Model, ModelThread, ToolSpec } from '../types.ts';

export type OpenModelOptions = {
  env?: Record<string, string | undefined>;
  codex?: import('./codex.ts').CodexOptions;
};

// Backends load on first use so commands that never call a model pay nothing for them.
export function openModel(config: Config['model'], options: OpenModelOptions = {}): Model {
  const env = options.env ?? process.env;
  const selector = env.PLAYTEST_MODEL;
  if (selector !== undefined && selector !== '' && !selector.startsWith('script:'))
    throw new Error(`PLAYTEST_MODEL must be script:<file>, got "${selector}"`);
  const script = selector?.slice('script:'.length);
  if (script) {
    const transcript = env.PLAYTEST_MODEL_TRANSCRIPT || undefined;
    return lazy(`script:${script}`, async () => (await import('./script.ts')).ScriptModel.fromFile(script, transcript));
  }
  const name = `codex:${config.name}${config.effort ? `@${config.effort}` : ''}`;
  return lazy(name, async () => new (await import('./codex.ts')).CodexModel(config, options.codex));
}

function lazy(name: string, load: () => Promise<Model>): Model {
  let model: Promise<Model> | undefined;
  return {
    name,
    startThread(opts: { instructions: string; tools: ToolSpec[]; bounded?: boolean }): Promise<ModelThread> {
      model ??= load();
      return model.then((m) => m.startThread(opts));
    },
  };
}
