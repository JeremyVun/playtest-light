// Usage: node tools/probe-wait.ts <output-directory> [response-seconds=20]
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startSlowChat } from '../fixtures/slow-chat/server.ts';
import { recordStory, recordMarkdown } from '../src/run/record.ts';
import { Evidence } from '../src/run/evidence.ts';
import type { Project, Story } from '../src/types.ts';

if (!process.argv[2]) throw new Error('Pass an output directory.');
const dir = resolve(process.argv[2]);
const seconds = Number(process.argv[3] ?? 20);
if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) throw new Error('Invalid response delay.');
mkdirSync(dir, { recursive: true });
const app = await startSlowChat(seconds * 1000);
const evidence = new Evidence(dir, true);
const project: Project = { dir, cwd: dir, seedCwd: dir, runsDir: join(dir, '.runs'), config: { url: app.url, browser: { viewport: [1280, 800], widths: [1280] }, model: { name: 'gpt-6.1-sol', effort: 'medium' } } };
const story: Story = { name: 'slow-chat', path: join(dir, 'story.md'), title: 'Wait for a chat response', start: '/', prose: 'Enter “Please respond” into Message and press Enter. Wait for the complete chatbot response before finishing. Send the message only once.', doneWhen: ['The response contains “Your request is complete.”', 'Send is enabled and Generating is no longer shown'] };
writeFileSync(story.path, story.prose);
let beats = 0, maxGapMs = 0, lastBeat = performance.now();
const timer = setInterval(() => { const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - lastBeat); lastBeat = now; beats++; }, 50);
try {
  const result = await recordStory(project, story, { runDir: dir, evidence, progress: console.log });
  const log = readFileSync(join(dir, 'trajectory.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const waits = log.filter(e => e.event === 'action' && e.action.type === 'wait');
  const decisions = log.filter(e => e.event === 'decision');
  const view = evidence.write({ title: 'Run', url: app.url, status: result.deterministic ? 'pass' : 'fail', totalMs: result.stats.ms, stories: [{ name: story.name, status: result.deterministic ? 'pass' : 'fail', steps: result.steps.length, reason: result.reason ?? (result.deterministic ? 'Recorded and verified' : result.determinism.join('; ')), ms: result.stats.ms, sectionIds: evidence.sections.map(s => s.id) }], summary: [result.summary ?? result.reason ?? ''], details: recordMarkdown(story, result), links: [{ label: 'Trajectory', href: 'trajectory.jsonl' }, { label: 'Context', href: 'context.jsonl' }] });
  const metrics = { result, view, submissions: app.submissions, beats, maxGapMs: Math.round(maxGapMs), waits: waits.map(w => ({ ok: w.ok, waitMs: w.waitMs, timeoutMs: w.action.timeoutMs })), decisions: decisions.map(d => ({ tool: d.tool, ms: d.ms })) };
  writeFileSync(join(dir, 'probe.json'), JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify({ deterministic: result.deterministic, stats: result.stats, submissions: app.submissions, beats, maxGapMs: Math.round(maxGapMs), waits: metrics.waits, decisions: metrics.decisions, view }, null, 2));
  assert.equal(result.deterministic, true, result.determinism.join('; '));
  assert.ok(waits.some(w => w.ok && w.waitMs > 1000), 'Actor did not exercise a real wait');
  assert.equal(app.submissions, 3);
  for (const wait of waits) {
    const decision = log.findLast(e => e.event === 'decision' && e.id < wait.id);
    assert.equal(decision?.tool, 'wait_for');
    assert.ok(log.findLast(e => e.event === 'call' && e.tool === 'wait_for' && e.id < decision.id));
  }
} finally { clearInterval(timer); await app.close(); }
