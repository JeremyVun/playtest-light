import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listRunDirs } from '../env/runs.ts';
import type { Project } from '../types.ts';
import { bare, pattern } from './findings.ts';

const SESSIONS_SHOWN = 3;
const TITLES_SHOWN = 15;
const PAGES_SHOWN = 8;

// Earlier explore sessions of this project with the same target, seed and goal, newest first.
export type Earlier = { count: number; shown: string[]; titles: string[]; pages: [string, number][] };

type Stored = { app?: string; seedCommand?: string; seedCwd?: string; goal?: string; findings?: { title: string; reproduced: boolean }[]; steps?: { url?: string }[] };

export function earlierSessions(project: Project, goal: string | undefined): Earlier {
  const stored = listRunDirs(project.runsDir)
    .reverse()
    .flatMap((name) => {
      try {
        const r = JSON.parse(readFileSync(join(project.runsDir, name, 'findings.json'), 'utf8')) as Stored;
        return r.app === project.config.url && r.seedCommand === project.config.seed && r.seedCwd === (project.config.seed ? project.seedCwd : undefined) && r.goal === goal ? [{ name, r }] : [];
      } catch {
        return [];
      }
    });
  const recent = stored.slice(0, SESSIONS_SHOWN);
  const titles = [...new Set(recent.flatMap(({ r }) => (r.findings ?? []).filter((f) => f.reproduced).map((f) => f.title)))];
  const pages = new Map<string, number>();
  for (const { r } of recent) for (const s of r.steps ?? []) if (s.url) pages.set(pattern(bare(s.url)), (pages.get(pattern(bare(s.url))) ?? 0) + 1);
  return { count: stored.length, shown: recent.map((s) => s.name), titles, pages: [...pages].sort((a, b) => b[1] - a[1]) };
}

export function earlierSection(e: Earlier): string {
  if (!e.shown.length) return '';
  const sessions = e.shown.length === 1 ? 'The last explore session' : `The last ${e.shown.length} explore sessions`;
  const titles = e.titles.length
    ? `${sessions} with these settings already reported these problems; do not spend steps finding them again:\n${e.titles
        .slice(0, TITLES_SHOWN)
        .map((t) => `- ${t}`)
        .join('\n')}${e.titles.length > TITLES_SHOWN ? `\n- and ${e.titles.length - TITLES_SHOWN} more` : ''}`
    : `${sessions} with these settings reported no reproduced problems.`;
  const pages = e.pages
    .slice(0, PAGES_SHOWN)
    .map(([p, n]) => `${p} (${n})`)
    .join(', ');
  return `## What earlier sessions did
${titles}
They spent their steps on these pages (steps after which each was open): ${pages}. Spend yours mostly on what they did not reach.

`;
}
