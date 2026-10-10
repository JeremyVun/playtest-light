import { connectBrowser, launchBrowser, stopBrowser } from '../browser/index.ts';
import type { Evidence } from './evidence.ts';
import { runSeed } from '../env/seed.ts';
import type { ActResult, Browser, Page, PageOptions, Project } from '../types.ts';

export type Run = { project: Project; url: string; browser: Browser; evidence?: Evidence; close(): Promise<void> };

export async function openRun(project: Project): Promise<Run> {
  const url = project.config.url;
  if (!url) throw new Error('No target URL; pass --url <url> or set url in playtest/config.json.');
  const launched = await launchBrowser();
  try {
    const browser = await connectBrowser(launched.wsUrl);
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
      try { await browser.disconnect(); } finally { await stopBrowser(launched); }
    };
    const interrupt = () => { void close().finally(() => process.exit(130)); };
    const terminate = () => { void close().finally(() => process.exit(143)); };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    return { project, url, browser, close };
  } catch (error) {
    await stopBrowser(launched);
    throw error;
  }
}

export function pageOptions(run: Run, viewport?: [number, number]): PageOptions {
  const { browser } = run.project.config;
  return { baseUrl: run.url, viewport: viewport ?? browser.viewport, widths: browser.widths,
    ...(browser.clock ? { clock: browser.clock } : {}),
    ...(browser.settleCapMs ? { settleCapMs: browser.settleCapMs } : {}) };
}

export type StoryPage = { page: Page; opened: ActResult; viewport: [number, number] };

export async function openStory(run: Run, story: { start: string; viewport?: [number, number] }): Promise<StoryPage> {
  await runSeed(run.project);
  const options = pageOptions(run, story.viewport);
  const page = await run.browser.newPage(options);
  try {
    const started = performance.now();
    const opened = await page.goto(story.start);
    await run.evidence?.watch(page, opened, Math.round(performance.now() - started));
    if (!opened.ok) throw new Error(`could not open ${story.start}: ${opened.error}`);
    return { page, opened, viewport: options.viewport };
  } catch (error) {
    await page.close();
    throw error;
  }
}
