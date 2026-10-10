import type { Config, Model } from '../types.ts';

export type OpenModelOptions = {
  env?: Record<string, string | undefined>;
  codex?: import('./codex.ts').CodexOptions;
};

// Backends load on first use so commands that never call a model pay nothing for them.
export function openModel(config: Config['model'], options: OpenModelOptions = {}): Model {
  const env = options.env ?? process.env;
  const selector = env.PLAYTEST_MODEL;
  if (selector !== undefined && selector !== '' && (!selector.startsWith('script:') || !selector.slice('script:'.length).trim()))
    throw new Error(`PLAYTEST_MODEL must be script:<file>, got "${selector}"`);
  const script = selector?.slice('script:'.length);
  if (script) {
    const transcript = env.PLAYTEST_MODEL_TRANSCRIPT || undefined;
    let model: Promise<Model> | undefined;
    return {
      name: `script:${script}`,
      startThread(opts) {
        model ??= import('./script.ts').then(({ ScriptModel }) => ScriptModel.fromFile(script, transcript));
        return model.then(m => m.startThread(opts));
      },
    };
  }
  const name = `codex:${config.name}${config.effort ? `@${config.effort}` : ''}`;
  return {
    name,
    startThread: async opts => (await import('./decisions.ts')).CodexDecisions.open(config, opts, options.codex),
  };
}
