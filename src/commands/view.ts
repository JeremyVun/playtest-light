import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { CommandArgs } from '../cli.ts';
import { listRunDirs } from '../env/runs.ts';
import { displayPath, projectFromArgs } from '../project.ts';
import type { Project } from '../types.ts';

function htmlFile(candidate: string): string | undefined {
  if (!existsSync(candidate)) return;
  const file = statSync(candidate).isDirectory() ? join(candidate, 'index.html') : candidate;
  if (file.endsWith('.html') && existsSync(file) && statSync(file).isFile()) return file;
}

export function resolveView(project: Project, ref?: string): string {
  const candidates = ref ? [resolve(project.cwd, ref), join(project.runsDir, ref)] : listRunDirs(project.runsDir).reverse().map((name) => join(project.runsDir, name));
  for (const candidate of candidates) {
    const file = htmlFile(candidate);
    if (file) return file;
  }
  throw new Error(ref ? `No HTML run view at ${ref}.` : 'No run view yet. Run a story or explore a URL first.');
}

export async function openView(file: string): Promise<void> {
  await promisify(execFile)(process.platform === 'darwin' ? 'open' : 'xdg-open', [pathToFileURL(file).href]);
}

export async function run(args: CommandArgs): Promise<number> {
  const ref = args.positionals[0];
  const view = (ref && htmlFile(resolve(ref))) || resolveView(projectFromArgs(args), ref);
  if (args.values.json) console.log(JSON.stringify({ view }));
  else {
    console.log(`view ${displayPath(view)}`);
    await openView(view);
  }
  return 0;
}
