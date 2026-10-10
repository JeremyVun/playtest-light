import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Evidence } from '../src/run/evidence.ts';
import type { Page } from '../src/types.ts';

test('evidence counts each decision once across batches, checks and failed calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pt-evidence-'));
  const result = { ok: true, settleMs: 1, issues: [] };
  const page = {
    act: async () => result,
    check: async () => ({ ok: true }),
    snapshot: async () => ({ url: '/', lines: [] }),
  } as unknown as Page;
  try {
    const evidence = new Evidence(dir);
    await evidence.watch(page, result);
    const usage = { input: 7000, cached: 6000, output: 150, reasoning: 20 };
    await evidence.decision(async () => {
      await page.act({ type: 'navigate', url: '/one' });
      await page.act({ type: 'navigate', url: '/two' });
      return { text: '', usage, ms: 1500 };
    });
    await evidence.decision(async () => ({ text: 'Done', ms: 50 }));
    const failed = Object.assign(new Error('Interrupted'), { decision: { text: '', usage, ms: 500 } });
    await assert.rejects(evidence.decision(async () => { throw failed; }), /Interrupted/);
    assert.equal(evidence.activeDecision, undefined);
    assert.deepEqual(evidence.sections[0].frames.map(f => f.decisions), [undefined, ['d1'], ['d1', 'd2', 'd3']]);
    evidence.write({ title: 'Run', url: '/', status: 'error', summary: [] });
    const saved = JSON.parse(readFileSync(join(dir, 'evidence.json'), 'utf8'));
    assert.equal(saved.model.length, 3);
    assert.deepEqual(saved.model[0].usage, usage);
    assert.equal(saved.model[1].usage, undefined);
    assert.deepEqual(saved.model[2].usage, usage);
    assert.equal(saved.model[2].error, 'Interrupted');
    assert.equal(saved.model.reduce((n: number, d: { usage?: { input: number } }) => n + (d.usage?.input ?? 0), 0), 14000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
