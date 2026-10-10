import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { findProject } from '../src/project.ts';
import { Evidence } from '../src/run/evidence.ts';
import { recordStory } from '../src/run/record.ts';

const { values } = parseArgs({ options: { out: { type: 'string' }, count: { type: 'string', default: '200' } } });
if (!values.out) throw new Error('Pass --out <scratch-directory>');
const out = resolve(values.out), count = Number(values.count);
assert.ok(Number.isInteger(count) && count > 0 && count <= 500);
mkdirSync(out, { recursive: true });
const records = Array.from({ length: count }, (_, i) => {
  const hash = createHash('sha256').update(`queue-review-${i}`).digest('hex');
  return { id: hash.slice(0, 8).toUpperCase(), amount: parseInt(hash.slice(8, 12), 16) % 1000, stock: parseInt(hash.slice(12, 14), 16) % 3 };
});
const reference = '北極光-' + createHash('sha256').update('original queue reference').digest('hex').slice(0, 12);
let position = 0, rejected = 0, completed = false;
const trials: object[] = [];
const server = createServer(async (req, res) => {
  const body: Buffer[] = [];
  for await (const chunk of req) body.push(Buffer.from(chunk));
  const fields = new URLSearchParams(Buffer.concat(body).toString());
  let error = '';
  if (req.url === '/reset') {
    if (position || rejected || completed) trials.push({ position, rejected, completed });
    position = 0; rejected = 0; completed = false;
    res.end('reset'); return;
  }
  if (req.method === 'POST') {
    if (position < count) {
      const row = records[position]!;
      const expected = `${row.id}-${row.amount < 500 && row.stock > 0 ? 'A' : 'E'}`;
      if (fields.get('routing') === expected) position++;
      else { rejected++; error = 'Routing code does not match this order. Review its values again.'; }
    } else if (fields.get('reference') === reference) completed = true;
    else { rejected++; error = 'Original reference does not match.'; }
  }
  const row = records[position];
  const content = completed ? '<h1>Review complete</h1><p>All orders routed and original reference verified.</p>'
    : row ? `<h1>Order ${position + 1} of ${count}</h1>${position === 0 ? `<p>Original reference: ${reference}</p>` : ''}<p>Order ID: ${row.id}</p><p>Amount: ${row.amount}</p><p>Stock: ${row.stock}</p><form method="post"><label>Routing code <input name="routing" autocomplete="off"></label><button>Submit review</button></form>`
    : '<h1>Finish review</h1><form method="post"><label>Original reference <input name="reference" autocomplete="off"></label><button>Finish</button></form>';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Order review</title></head><body><main>${content}${error ? `<p role="alert">${error}</p>` : ''}</main></body></html>`);
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address() as { port: number };
const project = findProject(out);
project.config.url = `http://127.0.0.1:${address.port}/`;
const reset = join(out, 'reset.ts');
writeFileSync(reset, `const r = await fetch(process.env.PLAYTEST_URL + 'reset', { method: 'POST' }); if (!r.ok) process.exit(1);`);
project.config.seed = `node '${reset}'`;
const story = {
  name: 'order-review', path: join(out, 'story.md'), title: 'Review an order queue', start: '/',
  prose: `Review all ${count} orders. For each order, enter its exact displayed Order ID followed by -A if its Amount is below 500 AND its Stock is above zero, otherwise followed by -E. Submit the review and read the next order before deciding its code. The first order displays an Original reference: remember that exact value for the final Finish review form. Complete that form after all orders are routed.`,
  doneWhen: ['All orders routed correctly', 'Original reference verified and Review complete shown'],
};
writeFileSync(story.path, story.prose);
try {
  const result = await recordStory(project, story, { minutes: 35, runDir: out, evidence: new Evidence(out, false), progress: console.log });
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
  trials.push({ position, rejected, completed });
  writeFileSync(join(out, 'oracle.json'), JSON.stringify(trials, null, 2));
  console.log(JSON.stringify({ deterministic: result.deterministic, stats: result.stats, trials }, null, 2));
  assert.equal(result.deterministic, true);
  assert.ok(trials.length === 3 && trials.every((t: any) => t.position === count && t.rejected === 0 && t.completed));
  assert.ok(result.stats.context!.decisions >= count);
} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
