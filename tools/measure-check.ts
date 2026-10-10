// Usage: node tools/measure-check.ts [--runs N] [--story name] [--url URL] [--seed command]. Start the app separately.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { runs: { type: 'string', default: '10' }, story: { type: 'string', default: 'busy-morning' }, url: { type: 'string' }, seed: { type: 'string' } } });
const count = Number(values.runs);
if (!Number.isInteger(count) || count < 1) throw new Error('--runs must be a positive integer');
const args = [join(import.meta.dirname, '../bin/playtest.js'), 'run', values.story!, '--json'];
if (values.url) args.push('--url', values.url);
if (values.seed) args.push('--seed', values.seed);
const times: number[] = [];
for (let i = 0; i < count; i++) {
  const t = performance.now();
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
console.log(JSON.stringify({ runs: count, medianMs: times[Math.floor(count / 2)], p90Ms: times[Math.ceil(count * .9) - 1], browser: 'started and stopped per invocation' }));
