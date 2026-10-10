import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { decodePngGrey, fingerprintDistance, fingerprintOf, fingerprintsMatch } from '../src/browser/fingerprint.ts';
import { keyEvents } from '../src/browser/keys.ts';
import { buildEntries, findEntry, indexLocators, normalizedLines, type AXNode } from '../src/browser/snapshot.ts';

let nextId = 1;
const made: AXNode[] = [];
function n(role: string, name = '', children: AXNode[] = [], extra: Partial<AXNode> = {}): AXNode {
  const id = String(nextId++);
  const node: AXNode = {
    nodeId: id,
    ignored: role === 'none',
    role: { type: 'role', value: role },
    name: { type: 'string', value: name },
    childIds: children.map((c) => c.nodeId),
    backendDOMNodeId: Number(id),
    ...extra,
  };
  made.push(node);
  return node;
}
// The root goes first, as in Chrome's response; the rest in any order.
const tree = (root: AXNode) => [root, ...made.filter((x) => x !== root)];
const prop = (name: string, value: unknown) => ({ name, value: { type: 'x', value } });

test('snapshot: prunes, nests, merges text runs and drops text that repeats a name', () => {
  const root = n('RootWebArea', 'Title', [
    n('none', '', [
      n('banner', '', [n('StaticText', 'Tracker'), n('navigation', 'Main', [n('list', '', [n('listitem', '', [n('link', 'Projects', [n('StaticText', 'Projects')])])])])]),
      n('main', '', [
        n('heading', 'Projects', [n('StaticText', 'Projects')], { properties: [prop('level', 1)] }),
        n('LabelText', '', [n('StaticText', 'Status'), n('combobox', 'Status', [n('MenuListPopup', '', [n('option', 'All')])], { value: { type: 's', value: 'All' } })]),
        n('paragraph', '', [n('StaticText', 'active'), n('StaticText', '5'), n('StaticText', ' open of '), n('strong', '', [n('StaticText', '7')])]),
        n('none', '', [n('StaticText', 'Ada Admin'), n('StaticText', ' ('), n('StaticText', 'admin'), n('StaticText', ')')]),
        n('checkbox', 'Done', [], { properties: [prop('checked', 'true'), prop('focused', true)] }),
        n('button', 'Save', [n('StaticText', 'Save')], { properties: [prop('disabled', true)] }),
        n('list', '', [n('listitem', '', [n('ListMarker', '1. ', [n('StaticText', '1. ')]), n('StaticText', 'one')])]),
        n('generic', '', [n('StaticText', '   ')]),
      ]),
    ]),
  ]);
  const entries = buildEntries(tree(root));
  assert.deepEqual(normalizedLines(entries), [
    'banner',
    '  text "Tracker"',
    '  navigation "Main"',
    '    listitem',
    '      link "Projects"',
    'main',
    '  heading "Projects" level=1',
    '  combobox "Status" value="All"',
    '  text "active 5 open of 7"',
    '  text "Ada Admin (admin)"',
    '  checkbox "Done" checked',
    '  button "Save" disabled',
    '  listitem',
    '    text "one"',
  ]);
  const done = entries.find((e) => e.role === 'checkbox')!;
  assert.equal(done.focused, true);
  assert.equal(done.checked, 'true');
  assert.equal(entries.filter((e) => e.actionable).length, 4);
});

test('locators: nth only when the role and name repeat', () => {
  const root = n('RootWebArea', '', [n('button', 'Go'), n('button', 'Go'), n('button', 'Stop'), n('link', 'Go')]);
  const entries = buildEntries(tree(root));
  assert.deepEqual(indexLocators(entries)[0], { role: 'button', name: 'Go', nth: 0 });
  assert.deepEqual(indexLocators(entries)[1], { role: 'button', name: 'Go', nth: 1 });
  assert.deepEqual(indexLocators(entries)[2], { role: 'button', name: 'Stop' });
  assert.deepEqual(indexLocators(entries)[3], { role: 'link', name: 'Go' });
  assert.equal(findEntry(entries, { role: 'button', name: ' Go ', nth: 1 }), entries[1]);
  assert.equal(findEntry(entries, { role: 'button', name: 'Go', nth: 2 }), undefined);
});

test('keys: named keys, characters and modifiers', () => {
  assert.deepEqual(keyEvents('Enter').map((e) => [e.type, e.key, e.text]), [['keyDown', 'Enter', '\r'], ['keyUp', 'Enter', undefined]]);
  assert.deepEqual(keyEvents('Escape').map((e) => e.type), ['rawKeyDown', 'keyUp']);
  const a = keyEvents('Control+a');
  assert.equal(a[0].type, 'rawKeyDown');
  assert.equal(a[0].modifiers, 2);
  assert.equal(a[0].code, 'KeyA');
  assert.equal(keyEvents('Shift+A')[0].text, 'A');
  assert.throws(() => keyEvents('Hyper+q'), /Unknown modifier/);
  assert.throws(() => keyEvents('Banana'), /Unknown key/);
});

function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number], filter: (y: number) => number): Buffer {
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(width * 3);
  for (let y = 0; y < height; y++) {
    const raw = Buffer.alloc(width * 3);
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), x * 3);
    const f = filter(y);
    const out = Buffer.alloc(width * 3);
    for (let i = 0; i < raw.length; i++) {
      const a = i >= 3 ? raw[i - 3] : 0;
      const b = prev[i];
      const c = i >= 3 ? prev[i - 3] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][f];
      out[i] = (raw[i] - predictor) & 0xff;
    }
    rows.push(Buffer.from([f]), out);
    prev = raw;
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('png: decodes every filter type to luminance', () => {
  const pixel = (x: number, y: number): [number, number, number] => [(x * 37 + y * 11) & 0xff, (x * 5) & 0xff, (y * 23) & 0xff];
  const img = decodePngGrey(png(13, 10, pixel, (y) => y % 5));
  assert.deepEqual([img.width, img.height], [13, 10]);
  for (const [x, y] of [[0, 0], [12, 9], [6, 4], [3, 7]]) {
    const [r, g, b] = pixel(x, y);
    assert.ok(Math.abs(img.pixels[y * 13 + x] - (0.299 * r + 0.587 * g + 0.114 * b)) < 1e-9);
  }
});

test('fingerprint: stable hex, zero distance to itself, larger for bigger changes', () => {
  const base = (x: number, _y: number): [number, number, number] => (x < 40 ? [255, 255, 255] : [20, 20, 20]);
  const a = fingerprintOf(png(80, 50, base, () => 4));
  assert.match(a, /^[0-9a-f]{80}$/);
  assert.equal(fingerprintOf(png(80, 50, base, () => 0)), a);
  const small = fingerprintOf(png(80, 50, (x, y) => (x === 79 && y === 49 ? [255, 255, 255] : base(x, y)), () => 1));
  const big = fingerprintOf(png(80, 50, (x, y) => base(79 - x, y), () => 2));
  assert.equal(fingerprintDistance(a, a), 0);
  assert.ok(fingerprintsMatch(a, small));
  assert.ok(fingerprintDistance(a, big) > 50);
  assert.equal(fingerprintsMatch(a, big), false);
});
