import { existsSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { CommandArgs } from '../cli.ts';
import { newRunDir, releaseRun } from '../env/runs.ts';
import { baselinePath, displayPath, listStories, loadStory, projectFromArgs } from '../project.ts';
import { acceptStory, readBaseline, type Accepted } from '../run/baseline.ts';
import type { ViewStory } from '../run/view-html.ts';
import { Evidence } from '../run/evidence.ts';
import { recordStory, recordMarkdown, type RecordResult } from '../run/record.ts';
import { checkStory, type StoryResult } from '../run/replay.ts';
import { checkMarkdown, checkSummary, shellQuote } from '../run/report.ts';
import { openRun, type Run } from '../run/session.ts';
import { openView } from './view.ts';

export async function run(args: CommandArgs): Promise<number> {
  const project = projectFromArgs(args);
  const stories = args.positionals.length ? args.positionals.map((name) => loadStory(project, name)) : listStories(project);
  if (!stories.length) throw new Error(`No stories in ${displayPath(project.dir)}/stories. Write a Markdown story first.`);
  if (!project.config.url) throw new Error('No target URL; pass --url <url> or set url in playtest/config.json.');
  const json = args.values.json === true;
  const record = args.values.record === true;
  const started = performance.now();
  const runDir = newRunDir(project, 'run', true);
  try {
    const reportJson = join(runDir, 'report.json');
    const evidence = new Evidence(runDir, args.values.view === true || args.values.video === true);
    const results: StoryResult[] = [];
    const recordings: (RecordResult & { accepted?: Accepted })[] = [];
    const recordingAttempts: string[] = [];
    const summary: string[] = [];
    const details: string[] = [];
    const storyViews: ViewStory[] = stories.map(story => ({ name: story.name, status: 'not-run', reason: 'Not run', sectionIds: [] }));
    let currentStory: ViewStory | undefined;
    let browser: Run | undefined;
    let error: string | undefined;
    try {
      for (const [i, story] of stories.entries()) {
        const row = storyViews[i];
        currentStory = row;
        row.status = 'error';
        row.reason = 'Story did not finish';
        const storyStarted = performance.now(), sectionStart = evidence.sections.length;
        try {
          const file = baselinePath(project, story);
          if (record || !existsSync(file)) {
            recordingAttempts.push(story.path);
            writeFileSync(reportJson, JSON.stringify({ kind: 'run', recordingAttempts, recordings: recordings.filter(r => r.storyPath !== story.path) }));
            if (!json) console.log(`recording ${story.name}`);
            const screenshots = evidence.screenshots;
            evidence.screenshots = true;
            let r: RecordResult;
            try {
              r = await recordStory(project, story, { runDir: join(runDir, `record-${i + 1}`), evidence, progress: json ? undefined : (line) => console.log(line) });
            } finally { evidence.screenshots = screenshots; }
            const accepted = r.deterministic && args.values.accept ? acceptStory(project, story, r.baseline) : undefined;
            recordings.push({ ...r, accepted });
            row.status = r.deterministic ? 'pass' : 'fail';
            row.steps = r.steps.length;
            row.reason = r.deterministic ? accepted ? 'Recorded and baseline saved' : 'Verified recording; baseline not saved' : r.reason ?? r.determinism.join('; ');
            summary.push(`${r.deterministic ? 'PASS' : 'FAIL'} ${story.name}: ${r.deterministic ? accepted ? 'baseline saved' : 'pending baseline; use pt accept ' + shellQuote(story.path) : r.reason ?? r.determinism.join('; ')}`);
            details.push(recordMarkdown(story, r));
          } else {
            browser ??= await openRun(project);
            browser.evidence = evidence;
            const r = await checkStory(browser, readBaseline(file));
            r.storyPath = story.path;
            results.push(r);
            row.status = r.status;
            row.steps = r.ran;
            const failedChecks = r.checks.filter(check => !check.ok).length;
            const failedSteps = [...r.drift, ...r.newIssues, ...r.slow, ...(r.stopped ? [r.stopped] : []), ...(failedChecks ? [{ step: r.ran }] : [])].map(item => item.step);
            if (failedSteps.length) row.focusStep = Math.min(...failedSteps);
            row.reason = r.error || (r.status === 'pass' ? r.checks.length ? `${r.checks.length} checks passed` : 'Matched baseline' : [
              r.stopped ? `Stopped at step ${r.stopped.step}` : '',
              failedChecks ? `${failedChecks} failed check${failedChecks === 1 ? '' : 's'}` : '',
              r.drift.length ? `Page changed at ${r.drift.length} step${r.drift.length === 1 ? '' : 's'}` : '',
              r.newIssues.length ? `${r.newIssues.length} new issue${r.newIssues.length === 1 ? '' : 's'}` : '',
              r.slow.length ? `${r.slow.length} slow step${r.slow.length === 1 ? '' : 's'}` : '',
            ].filter(Boolean).join(' · '));
            summary.push(checkSummary([r], r.ms, join(runDir, 'report.md'))[0]);
            if (r.status === 'error') { error = r.error; break; }
          }
        } finally {
          row.ms = Math.round(performance.now() - storyStarted);
          row.sectionIds = evidence.sections.slice(sectionStart).map(section => section.id);
        }
      }
    } catch (caught) {
      error = (caught as Error).message;
      if (currentStory) { currentStory.status = 'error'; currentStory.reason = error; }
      summary.push(`ERROR ${error}`);
    } finally { await browser?.close(); }
    const ms = Math.round(performance.now() - started);
    const code = error ? 2 : results.some((r) => r.status !== 'pass') || recordings.some((r) => !r.deterministic) ? 1 : 0;
    if (results.length) details.push(checkMarkdown(results, { ms, seeded: Boolean(project.config.seed), app: project.config.url, chrome: browser?.browser.version ?? '' }));
    let media: { video?: string; videoSkipped?: string } = {};
    if (args.values.video) {
      try { media = await evidence.video(); } catch (caught) { media.videoSkipped = (caught as Error).message; }
    }
    const markdown = details.join('\n\n') + (error ? `\nError: ${error}\n` : '');
    const report = join(runDir, 'report.md');
    writeFileSync(report, markdown);
    const view = evidence.write({ title: 'Run', url: project.config.url, status: code === 2 ? 'error' : code ? 'fail' : 'pass', stories: storyViews, totalMs: ms, summary, details: markdown, links: [{ label: 'Report JSON', href: 'report.json' }, {label: 'Report Markdown', href: 'report.md'}, ...recordings.flatMap((r) => [{label: `${r.story} trajectory`, file: 'trajectory.jsonl'}, {label: `${r.story} context`, file: 'context.jsonl'}, {label: `${r.story} instructions`, file: 'context-header.json'}].map(({label, file}) => ({label, href: relative(runDir, join(r.runDir, file)).replaceAll('\\', '/')}))), ...(media.video ? [{label: 'Video', href: 'video.mp4'}] : [])] });
    const output = { ms, runDir, url: project.config.url, seeded: Boolean(project.config.seed), report, view, results, recordings, recordingAttempts, error, ...media };
    writeFileSync(reportJson, `${JSON.stringify({ kind: 'run', ...output }, null, 2)}\n`);
    if (json) console.log(JSON.stringify(output));
    else {
      for (const line of summary) console.log(line);
      console.log(`view ${displayPath(view)}`);
      if (media.video) console.log(`video ${displayPath(media.video)}`);
      if (media.videoSkipped) console.log(media.videoSkipped);
    }
    if (args.values.view && !json) await openView(view).catch((caught) => console.error(`Could not open view: ${(caught as Error).message}. Open ${view} in a browser.`));
    return code;
  } finally { releaseRun(runDir); }
}
