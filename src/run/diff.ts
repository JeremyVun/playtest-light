export type DiffLine = { op: ' ' | '-' | '+'; line: string; a: number; b: number };

// Large changes use a coarse diff to keep the comparison matrix below 4 MB.
export function diffLines(a: string[], b: string[]): DiffLine[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  const width = m + 1;
  const coarse = (n + 1) * width > 1_000_000;
  const lcs = new Uint32Array(coarse ? 0 : (n + 1) * width);
  for (let i = coarse ? -1 : n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[head + i] === b[head + j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  for (let k = 0; k < head; k++) out.push({ op: ' ', line: a[k], a: k, b: k });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[head + i] === b[head + j]) {
      out.push({ op: ' ', line: a[head + i], a: head + i, b: head + j });
      i++;
      j++;
    } else if (i < n && (coarse || j === m || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
      out.push({ op: '-', line: a[head + i], a: head + i, b: head + j });
      i++;
    } else {
      out.push({ op: '+', line: b[head + j], a: head + i, b: head + j });
      j++;
    }
  }
  for (let k = 0; k < tail; k++) out.push({ op: ' ', line: a[head + n + k], a: head + n + k, b: head + m + k });
  return out;
}

// Unified-diff hunks with `context` unchanged lines around each change; empty when equal.
export function unifiedDiff(a: string[], b: string[], context = 2): string[] {
  const ops = diffLines(a, b);
  const changed = ops.map((o, k) => (o.op === ' ' ? -1 : k)).filter((k) => k >= 0);
  if (!changed.length) return [];
  const out: string[] = [];
  let k = 0;
  while (k < changed.length) {
    const start = Math.max(0, changed[k] - context);
    let end = Math.min(ops.length, changed[k] + context + 1);
    while (k + 1 < changed.length && changed[k + 1] - context <= end) end = Math.min(ops.length, changed[++k] + context + 1);
    k++;
    const hunk = ops.slice(start, end);
    const aLen = hunk.filter((o) => o.op !== '+').length;
    const bLen = hunk.filter((o) => o.op !== '-').length;
    out.push(`@@ -${hunk[0].a + 1},${aLen} +${hunk[0].b + 1},${bLen} @@`);
    for (const o of hunk) out.push(`${o.op}${o.line}`);
  }
  return out;
}
