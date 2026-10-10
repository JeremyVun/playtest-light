import assert from 'node:assert/strict';
import { test } from 'node:test';
import { earlierSection } from '../src/run/explore-history.ts';
import { explorerInstructions, FLAVOURS, flavourOf, shownIn } from '../src/run/explore.ts';
import { mergeExplained, priorStep, type Draft } from '../src/run/findings.ts';

test('the seed rotates through the flavours, the first being the default plan', () => {
  assert.equal(flavourOf(0).name, 'main tasks first');
  assert.equal(flavourOf(FLAVOURS.length + 1), FLAVOURS[1]);
  assert.equal(explorerInstructions({ steps: 60, minutes: 8 }), explorerInstructions({ steps: 60, minutes: 8 }, FLAVOURS[0].plan(1280)));
  const phone = explorerInstructions({ steps: 60, minutes: 8 }, flavourOf(2).plan(1440));
  assert.match(phone, /^1\. Call tools\.set_width\(\{ width: 420 \}\) before anything else/m);
  assert.match(phone, /set_width\(\{ width: 1440 \}\) and visit what you have not seen yet/);
  for (const f of FLAVOURS) assert.doesNotMatch(f.plan(1280), /Feedback|Reports|Northern|sparkline|BUGS/);
});

test('checks are read from the snapshot the model last saw', () => {
  const snapshot = ['main', '  [e4] button "Save task"', '  status', '    text "Task created"'].join('\n');
  assert.equal(shownIn(snapshot, [{ type: 'text', value: 'Task created' }, { type: 'no-text', value: 'Write launch email' }]), true);
  assert.equal(shownIn(snapshot, [{ type: 'element', locator: { role: 'button', name: 'Save task' } }]), true);
  assert.equal(shownIn(snapshot, [{ type: 'absent', locator: { role: 'button', name: 'Save task' } }]), false);
  assert.equal(shownIn(snapshot, [{ type: 'url', value: '/projects' }]), false);
});

test('a report is compared with the page just before the latest step it cites', () => {
  assert.equal(priorStep({ steps: [5, 6, 7], at: 7 }), 6);
  assert.equal(priorStep({ steps: [3], at: 9 }), 2);
  assert.equal(priorStep({ steps: [], at: 4 }), 3);
  assert.equal(priorStep({ steps: [], at: 0 }), -1);
});

test('a server error merges into the model bug that cites its step on the same page, not one on another record', () => {
  const evidence = { url: '', snapshot: [], issues: [] };
  const model = (at: number, steps: number[]): Draft => ({
    source: 'model',
    title: 'Tasks cannot be loaded',
    kind: 'bug',
    severity: 'medium',
    expected: 'the tasks load',
    actual: 'an error',
    steps,
    at,
    checks: [{ type: 'text', value: 'Could not load tasks' }],
    reproduced: true,
    confirmation: 'held',
    evidence,
  });
  const harness = (): Draft => ({
    source: 'mechanical',
    title: 'GET /api/projects/prj-031/tasks returned 500 on /projects/prj-031',
    kind: 'bug',
    severity: 'high',
    expected: 'it succeeds',
    actual: 'GET /api/projects/prj-031/tasks 500',
    steps: [46],
    at: 46,
    seen: [46, 56],
    issues: [{ key: 'request|/projects/prj-031||GET /api/projects/prj-031/tasks 500', kind: 'request', message: 'GET /api/projects/prj-031/tasks 500', path: '/projects/prj-031' }],
    reproduced: true,
    confirmation: 'came back',
    evidence,
  });
  const urls = Array.from({ length: 60 }, (_, i) => (i === 59 ? '/projects/prj-031' : i === 45 ? '/projects/prj-002' : '/projects'));
  const merged = mergeExplained([model(59, [46, 59]), harness()], urls);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].severity, 'high');
  assert.equal(merged[0].merged?.[0].title, 'GET /api/projects/prj-031/tasks returned 500 on /projects/prj-031');
  assert.equal(mergeExplained([model(45, [45]), harness()], urls).length, 2, 'another record');
  assert.equal(mergeExplained([model(59, [40, 59]), harness()], urls).length, 2, 'no cited step near the error');
});

test('earlier sessions are summarised for the model', () => {
  assert.equal(earlierSection({ count: 0, shown: [], titles: [], pages: [] }), '');
  const none = earlierSection({ count: 2, shown: ['a', 'b'], titles: [], pages: [['/settings', 3]] });
  assert.match(none, /^The last 2 explore sessions with these settings reported no reproduced problems\.$/m);
  assert.match(none, /: \/settings \(3\)\. Spend yours/);
});
