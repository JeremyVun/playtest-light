import { parseArgs } from 'node:util';

export type CommandArgs = { positionals: string[]; values: Record<string, string | boolean | undefined> };

export function positiveNumber(value: string | boolean | undefined, fallback: number, flag: string, integer = false): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    throw new Error(`--${flag} must be a positive ${integer ? 'whole number' : 'number'}.`);
  }
  return n;
}

type Option = { value?: string; description: string; short?: string };
type Command = { summary: string; usage: string; description: string; options?: Record<string, Option>; examples: string[]; minArgs?: number; maxArgs?: number };

const url = { value: 'url', description: 'App URL; overrides the saved URL.' };
const seed = { value: 'command', description: 'Reset test data before each story and replay.' };
const target = { url, seed, 'no-seed': { description: 'Skip the saved seed command.' } };
const media = {
  view: { description: 'Capture every step and open the HTML report.' },
  video: { description: 'Make an MP4 from the captured steps (needs ffmpeg).' },
};
const common: Record<string, Option> = {
  project: { value: 'dir', description: 'Use the playtest data in another directory.' },
  json: { description: 'Print JSON without opening reports.' },
  help: { short: 'h', description: 'Show this help.' },
};

const commands: Record<string, Command> = {
  run: {
    summary: 'Test stories against an app', usage: 'run [story...] [options]',
    description: 'Run all stories, or select names or Markdown paths.\nReplay saved baselines; record and verify stories that have none.\nPass --url unless it is saved in playtest/config.json.',
    options: {
      ...target,
      record: { description: 'Record again, even if a baseline already exists.' },
      accept: { description: 'Save verified baselines recorded by this run.' },
      ...media,
    },
    examples: ['pt run --url http://localhost:3000', 'pt run checkout --view', 'pt run checkout --record --accept'],
  },
  explore: {
    summary: 'Explore an app for problems', usage: 'explore [url] [options]', maxArgs: 1,
    description: 'Explore the URL and save every finding, with reproduction evidence.\nUses the saved URL when none is supplied. A story is not required.',
    options: {
      goal: { value: 'text', description: 'Focus on a task or part of the app.' },
      steps: { value: 'n', description: 'Maximum browser actions (default: 60).' },
      ...target,
      view: { description: 'Open the HTML report when finished.' },
      video: media.video,
    },
    examples: ['pt explore http://localhost:3000 --view', 'pt explore --goal "Try creating and editing a project"'],
  },
  view: {
    summary: 'Open a run report', usage: 'view [path] [options]', maxArgs: 1,
    description: 'Open the latest HTML report, or give a run directory or HTML file.\nDoes not run stories or contact the app.',
    options: { json: { description: 'Print the report path as JSON without opening it.' } },
    examples: ['pt view', 'pt view playtest/.runs/<run>/'],
  },
  accept: {
    summary: 'Save a recorded baseline', usage: 'accept <story> [options]', minArgs: 1, maxArgs: 1,
    description: 'Save the latest verified recording as the baseline for this story.\nUse a story name or Markdown path. Review the run with pt view first.\nDoes not run the app or accept exploration findings.',
    examples: ['pt accept checkout'],
  },
  init: {
    summary: 'Create optional config and an example story', usage: 'init --url <url> [options]', maxArgs: 0,
    description: 'Create playtest/config.json, an example story and ignore rules.\nSetup is optional. Existing config is never overwritten.',
    options: {
      url: { value: 'url', description: 'App URL to save (required).' },
      seed: { value: 'command', description: 'Seed command to save (optional).' },
    },
    examples: ['pt init --url http://localhost:3000'],
  },
};

function optionsFor(command: Command): Record<string, Option> {
  const { json = common.json, ...options } = command.options ?? {};
  return { ...options, project: common.project, json, help: common.help };
}

function help(command?: Command): string {
  if (!command) return [
    'Usage: pt <command> [options]', '',
    'Test an already-running web app.', '',
    ...Object.entries(commands).map(([name, value]) => `  ${name.padEnd(9)}${value.summary}`),
    '', 'Run pt <command> --help for options and examples.',
  ].join('\n');
  const options = Object.entries(optionsFor(command)).map(([name, option]) => ({
    label: `${option.short ? `-${option.short}, ` : ''}--${name}${option.value ? ` <${option.value}>` : ''}`,
    description: option.description,
  }));
  const width = Math.max(...options.map(option => option.label.length));
  return [
    `Usage: pt ${command.usage}`, '', command.description, '', 'Options:',
    ...options.map(option => `  ${option.label.padEnd(width)}  ${option.description}`),
    '', 'Examples:', ...command.examples.map(example => `  ${example}`),
  ].join('\n');
}

export async function main(argv: string[]): Promise<number> {
  let [name, ...rest] = argv;
  const end = argv.indexOf('--');
  let json = argv.slice(0, end < 0 ? undefined : end).includes('--json');
  const fail = (message: string): number => {
    if (json) console.log(JSON.stringify({ error: message }));
    else console.error(`pt: ${message}\nSee pt ${name && Object.hasOwn(commands, name) ? name + ' ' : ''}--help.`);
    return 2;
  };
  if (name === 'help' && rest.length) {
    if (rest.length !== 1) return fail('Usage: pt help <command>');
    [name] = rest;
    rest = ['--help'];
  }
  if (!name || ['--help', '-h', 'help'].includes(name)) {
    if (rest.length) return fail('Usage: pt help [command]');
    console.log(help());
    return 0;
  }
  if (!Object.hasOwn(commands, name)) return fail(`Unknown command: ${name}`);
  const command = commands[name];
  try {
    const options: Record<string, { type: 'string' | 'boolean'; short?: string; multiple: false }> = Object.fromEntries(Object.entries(optionsFor(command)).map(([key, option]) => [key, {
      type: option.value ? 'string' : 'boolean', multiple: false, ...(option.short ? { short: option.short } : {}),
    }]));
    const parsed = parseArgs({ args: rest, allowPositionals: true, options });
    const args: CommandArgs = { positionals: parsed.positionals, values: parsed.values };
    json = args.values.json === true;
    if (args.values.help) {
      console.log(help(command));
      return 0;
    }
    if (args.positionals.length < (command.minArgs ?? 0) || args.positionals.length > (command.maxArgs ?? Infinity)) {
      return fail(`Usage: pt ${command.usage}`);
    }
    const module = (await import(`./commands/${name}.ts`)) as { run(args: CommandArgs): Promise<number> };
    return await module.run(args);
  } catch (error) {
    const message = (error as Error).message;
    const unknown = /^Unknown option '([^']+)'/.exec(message);
    return fail(unknown ? `${unknown[1]} is not an option for pt ${name}.` : message);
  }
}
