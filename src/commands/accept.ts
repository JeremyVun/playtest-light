import type { CommandArgs } from '../cli.ts';
import { displayPath, loadStory, projectFromArgs } from '../project.ts';
import { acceptStory } from '../run/baseline.ts';

export async function run(args: CommandArgs): Promise<number> {
  const project = projectFromArgs(args);
  const accepted = acceptStory(project, loadStory(project, args.positionals[0]));
  if (args.values.json) console.log(JSON.stringify(accepted));
  else console.log(`accepted ${displayPath(accepted.to)} (recorded against ${accepted.url})`);
  return 0;
}
