import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActResult, Baseline, Check, CheckResult, DecisionResult, Page, Snapshot } from '../types.ts';
import { unifiedDiff } from './diff.ts';
import { describeAction, describeCheck, describeIssue } from './format.ts';
import { findFfmpeg, makeVideo } from './render-video.ts';
import { runHtml, type RunView, type ViewDecision, type ViewFrame, type ViewSection } from './view-html.ts';

const traces = new WeakMap<Page, PageTrace>();

export async function checkPage(page: Page, condition: Check): Promise<CheckResult> {
  const result = await page.check(condition);
  await traces.get(page)?.check(condition, result);
  return result;
}

export async function captureResize(page: Page, width: number, durationMs: number): Promise<void> {
  await traces.get(page)?.capture(`Resize to ${width}px`, { ok: true, settleMs: 0, issues: [] }, false, durationMs);
}

export class Evidence {
  readonly sections: ViewSection[] = [];
  readonly model: ViewDecision[] = [];
  activeDecision?: string;
  readonly dir: string;
  screenshots: boolean;
  label = 'Run';
  baseline?: Baseline;

  constructor(dir: string, screenshots = false) {
    this.dir = dir;
    this.screenshots = screenshots;
    mkdirSync(dir, { recursive: true });
  }

  phase(label: string, baseline?: Baseline): void {
    this.label = label;
    this.baseline = baseline;
  }

  async watch(page: Page, opened: ActResult, durationMs?: number): Promise<void> {
    const section: ViewSection = { id: `s${this.sections.length + 1}`, label: this.label, frames: [] };
    this.sections.push(section);
    const trace = new PageTrace(this, section, page, this.baseline);
    traces.set(page, trace);
    opened.snapshot = await trace.capture('Open page', opened, true, durationMs);
    const act = page.act.bind(page);
    page.act = async (action) => {
      const decision = this.activeDecision;
      const started = performance.now();
      const result = await act(action);
      const durationMs = Math.round(performance.now() - started);
      const named = result.locator && 'target' in action ? { ...action, target: result.locator } : action;
      result.snapshot = await trace.capture(describeAction(named), result, false, durationMs, decision);
      return result;
    };
  }

  async decision(run: () => Promise<DecisionResult>): Promise<DecisionResult> {
    const decision: ViewDecision = { id: `d${this.model.length + 1}` };
    this.model.push(decision);
    this.activeDecision = decision.id;
    try {
      const result = await run();
      decision.usage = result.usage; decision.ms = result.ms;
      return result;
    } catch (error) {
      const failed = error as Error & { decision?: DecisionResult };
      decision.error = failed.message; decision.usage = failed.decision?.usage; decision.ms = failed.decision?.ms;
      throw error;
    } finally {
      const frames = this.sections.at(-1)?.frames ?? [];
      if (!frames.some(frame => frame.decisions?.includes(decision.id)) && frames.length)
        (frames.at(-1)!.decisions ??= []).push(decision.id);
      this.activeDecision = undefined;
    }
  }

  write(view: Omit<RunView, 'sections'>): string {
    const data = { ...view, sections: this.sections, model: this.model };
    const index = join(this.dir, 'index.html');
    writeFileSync(join(this.dir, 'evidence.json'), `${JSON.stringify(data, null, 2)}\n`);
    writeFileSync(index, runHtml(data));
    return index;
  }

  async video(): Promise<{ video?: string; videoSkipped?: string }> {
    const frames = this.sections.flatMap((section) => section.frames.flatMap((f) => f.screenshot ? [join(this.dir, f.screenshot)] : []));
    if (!frames.length) return { videoSkipped: 'No screenshots were captured.' };
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) return { videoSkipped: 'ffmpeg not found on PATH (or PLAYTEST_FFMPEG)' };
    const video = join(this.dir, 'video.mp4');
    await makeVideo(ffmpeg, frames, video);
    return { video };
  }
}

class PageTrace {
  #evidence: Evidence;
  #section: ViewSection;
  #page: Page;
  #baseline?: Baseline;
  #step = 0;

  constructor(evidence: Evidence, section: ViewSection, page: Page, baseline?: Baseline) {
    this.#evidence = evidence;
    this.#section = section;
    this.#page = page;
    this.#baseline = baseline;
  }

  async capture(action: string, result: ActResult, initial = false, durationMs?: number, decision = this.#evidence.activeDecision): Promise<Snapshot | undefined> {
    let snapshot: Snapshot | undefined;
    let captureError: string | undefined;
    try { snapshot = await this.#page.snapshot({ raw: true }); } catch (error) { captureError = (error as Error).message; }
    const step = initial ? 0 : this.#step + 1;
    const expected = this.#baseline?.steps[step - 1];
    const diff = expected && snapshot ? unifiedDiff(expected.snapshot, snapshot.lines, 2) : [];
    const known = new Set(this.#baseline?.startIssues.map((issue) => issue.key));
    for (const n of [step - 1, step, step + 1]) for (const issue of this.#baseline?.steps[n - 1]?.issues ?? []) known.add(issue.key);
    const frame: ViewFrame = { step, action, url: snapshot?.url ?? '', snapshot: snapshot?.lines ?? [],
      issues: result.issues.map(describeIssue), checks: [], diff, ms: result.settleMs, durationMs, error: result.error, captureError, ...(decision ? { decisions: [decision] } : {}) };
    this.#section.frames.push(frame);
    if (this.#evidence.screenshots || !result.ok || diff.length || result.issues.some((issue) => !known.has(issue.key))) await this.shoot(frame);
    if (!initial && result.ok) this.#step++;
    return snapshot;
  }

  async check(condition: Check, result: CheckResult): Promise<void> {
    const frame = this.#section.frames.at(-1)!;
    frame.checks.push(`${result.ok ? 'PASS' : 'FAIL'} ${describeCheck(condition)}${result.detail ? `: ${result.detail}` : ''}`);
    if (!result.ok) await this.shoot(frame);
  }

  async shoot(frame: ViewFrame): Promise<void> {
    if (frame.screenshot) return;
    try {
      const name = `${this.#section.id}-${String(this.#section.frames.indexOf(frame)).padStart(3, '0')}.png`;
      const png = await this.#page.screenshot({ fullPage: true });
      writeFileSync(join(this.#evidence.dir, name), png);
      frame.screenshot = name;
    } catch (error) { frame.captureError = (error as Error).message; }
  }
}
