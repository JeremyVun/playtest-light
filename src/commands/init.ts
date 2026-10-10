import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandArgs } from '../cli.ts';
import { displayPath, projectFromArgs } from '../project.ts';

const EXAMPLE_STORY = `---
start: /
---
# Open the home page

Open the app and look at the home page.

## Done when
- the home page shows its main heading
`;

export async function run(args: CommandArgs): Promise<number> {
  const project = projectFromArgs(args);
  const path = join(project.dir, 'config.json');
  if (existsSync(path)) throw new Error(`${displayPath(path)} already exists; init does not overwrite it.`);
  if (!project.config.url) throw new Error('Pass --url <url> to save a target.');
  const config = { url: project.config.url, ...(project.config.seed ? { seed: project.config.seed } : {}) };
  mkdirSync(join(project.dir, 'stories'), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  const written = [path];
  for (const [file, content] of [['.gitignore', '.runs/\n'], ['stories/example.md', EXAMPLE_STORY]]) {
    const target = join(project.dir, file);
    if (!existsSync(target)) { writeFileSync(target, content); written.push(target); }
    else if (file === '.gitignore') {
      const existing = readFileSync(target, 'utf8');
      const last = existing.trimEnd().split(/\r?\n/).at(-1);
      if (last !== '.runs/' && last !== '/.runs/') {
        appendFileSync(target, `${existing && !existing.endsWith('\n') ? '\n' : ''}.runs/\n`);
        written.push(target);
      }
    }
  }
  if (args.values.json) console.log(JSON.stringify({ written }));
  else { for (const file of written) console.log(`wrote ${displayPath(file)}`); console.log('Write a story, then run pt run <story> --accept.'); }
  return 0;
}
