import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { hostname } from 'node:os';
import type { Project } from '../types.ts';

export const KEEP_RUNS = 20;
const RUN_DIR = /^\d{8}-\d{6}-\d{3}-[\w-]+$/;

// Named <UTC stamp>-<kind> so that names sort by age.
export function newRunDir(project: Project, kind: string, active = false): string {
  pruneRuns(project.runsDir, KEEP_RUNS - 1);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').slice(0, 19);
  const safeKind = kind.replace(/[^\w-]/g, '-');
  const prefix = `${stamp}-${safeKind}`;
  const next = listRunDirs(project.runsDir).reduce((next, name) => {
    const suffix = name === prefix ? '1' : name.startsWith(prefix + '-') ? name.slice(prefix.length + 1) : '';
    return /^\d+$/.test(suffix) ? Math.max(next, Number(suffix) + 1) : next;
  }, 1);
  for (let n = next; ; n++) {
    const dir = join(project.runsDir, `${prefix}${n > 1 ? `-${n}` : ''}`);
    let leased = false;
    try {
      mkdirSync(project.runsDir, { recursive: true });
      if (existsSync(dir) || existsSync(ownerFile(dir))) continue;
      if (active) {
        writeFileSync(ownerFile(dir), JSON.stringify({ host: hostname(), pid: process.pid }), { flag: 'wx' });
        leased = true;
      }
      mkdirSync(dir);
      return dir;
    } catch (error) {
      if (leased) releaseRun(dir);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

function ownerFile(dir: string): string { return join(dirname(dir), `.${basename(dir)}.owner.json`); }

export function releaseRun(dir: string): void { rmSync(ownerFile(dir), { force: true }); }

function activeRun(dir: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(ownerFile(dir), 'utf8'));
    if (owner.host !== hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) return true;
    try { process.kill(owner.pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}

export function listRunDirs(runsDir: string): string[] {
  try {
    return readdirSync(runsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && RUN_DIR.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  } catch {
    return [];
  }
}

export function pruneRuns(runsDir: string, keep = KEEP_RUNS): string[] {
  const runs = listRunDirs(runsDir).filter(name => !activeRun(join(runsDir, name)));
  const old = runs.slice(0, Math.max(0, runs.length - keep));
  for (const name of old) {
    rmSync(join(runsDir, name), { recursive: true, force: true });
    releaseRun(join(runsDir, name));
  }
  return old;
}
