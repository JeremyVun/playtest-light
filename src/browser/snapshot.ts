export type AXValue = { type: string; value?: unknown };
export type AXNode = {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: { name: string; value: AXValue }[];
  childIds?: string[];
  backendDOMNodeId?: number;
};

export type Entry = {
  role: string;
  name: string;
  depth: number;
  // Normalized line without indentation; the model form adds a ref and focus.
  body: string;
  backendNodeId?: number;
  actionable: boolean;
  focused: boolean;
  value?: string;
  checked?: string;
  disabled?: boolean;
};

const ACTIONABLE = new Set([
  'link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'combobox', 'listbox', 'option',
  'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'DisclosureTriangle',
  'Date', 'DateTime', 'InputTime', 'ColorWell',
]);
const STRUCTURE = new Set([
  'heading', 'listitem', 'dialog', 'alertdialog', 'alert', 'status', 'log', 'progressbar', 'meter', 'table', 'grid',
  'row', 'cell', 'gridcell', 'columnheader', 'rowheader', 'navigation', 'main', 'banner', 'contentinfo',
  'complementary', 'search', 'tablist', 'tabpanel', 'menu', 'menubar', 'tree', 'toolbar',
]);
const NAMED_ONLY = new Set(['region', 'form', 'group', 'list', 'image', 'img', 'figure', 'article', 'radiogroup']);
// Their names come from their contents, so their text would repeat the name.
const NAME_FROM_CONTENTS = new Set([
  'link', 'button', 'heading', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem',
  'checkbox', 'radio', 'switch', 'cell', 'gridcell', 'columnheader', 'rowheader', 'image', 'img', 'LabelText',
  'DisclosureTriangle',
]);
// Native controls whose accessibility subtree is browser chrome (date fields, select options).
const OPAQUE = new Set(['textbox', 'searchbox', 'combobox', 'slider', 'spinbutton', 'progressbar', 'meter', 'Date', 'DateTime', 'InputTime', 'ColorWell', 'ListMarker', 'InlineTextBox']);
const INLINE = new Set(['strong', 'emphasis', 'time', 'mark', 'code', 'subscript', 'superscript', 'abbr', 'deletion', 'insertion', 'LineBreak']);
const VALUED = new Set(['textbox', 'searchbox', 'combobox', 'slider', 'spinbutton', 'progressbar', 'meter', 'Date', 'DateTime', 'InputTime', 'ColorWell']);

const TEXT_LIMIT = 300;

export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string): string {
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text;
}

function prop(node: AXNode, name: string): unknown {
  return node.properties?.find((p) => p.name === name)?.value.value;
}

function attributes(node: AXNode, role: string): { attrs: string; value?: string; checked?: string } {
  const parts: string[] = [];
  const level = prop(node, 'level');
  if (role === 'heading' && level !== undefined) parts.push(`level=${level}`);
  const value = VALUED.has(role) ? collapse(String(node.value?.value ?? '')) : undefined;
  if (value) parts.push(`value=${JSON.stringify(clip(value))}`);
  const checked = prop(node, 'checked');
  if (checked === 'true' || checked === true) parts.push('checked');
  else if (checked === 'mixed') parts.push('checked=mixed');
  const pressed = prop(node, 'pressed');
  if (pressed === 'true' || pressed === true) parts.push('pressed');
  const expanded = prop(node, 'expanded');
  if (expanded !== undefined && role !== 'combobox') parts.push(expanded ? 'expanded' : 'collapsed');
  if (prop(node, 'selected') === true && role !== 'option') parts.push('selected');
  if (prop(node, 'disabled') === true) parts.push('disabled');
  const invalid = prop(node, 'invalid');
  if (invalid !== undefined && invalid !== 'false' && invalid !== false) parts.push('invalid');
  if (prop(node, 'modal') === true) parts.push('modal');
  const current = prop(node, 'current');
  if (current !== undefined && current !== 'false' && current !== false) parts.push(`current=${current}`);
  return {
    attrs: parts.length ? ` ${parts.join(' ')}` : '',
    value,
    checked: checked === undefined ? undefined : String(checked),
  };
}

function joinText(a: string, b: string): string {
  if (!a) return b;
  return /[\p{L}\p{N}]$/u.test(a) && /^[\p{L}\p{N}]/u.test(b) ? `${a} ${b}` : a + b;
}

// Prunes Chrome's full accessibility tree to the nodes that matter, in document order.
export function buildEntries(nodes: AXNode[]): Entry[] {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const entries: Entry[] = [];
  let text = '';
  let textDepth = 0;
  const flush = () => {
    const t = collapse(text);
    if (t) entries.push({ role: 'text', name: t, depth: textDepth, body: `text ${JSON.stringify(clip(t))}`, actionable: false, focused: false });
    text = '';
  };

  const walk = (id: string, depth: number, quiet: boolean): void => {
    const node = byId.get(id);
    if (!node) return;
    const role = String(node.role?.value ?? '');
    if (node.ignored) {
      for (const child of node.childIds ?? []) walk(child, depth, quiet);
      return;
    }
    if (role === 'StaticText') {
      if (quiet) return;
      const value = String(node.name?.value ?? '');
      if (!collapse(value)) return;
      if (!text) textDepth = depth;
      text = joinText(text.replace(/\s+$/, ' '), value.replace(/^\s+/, text ? ' ' : ''));
      return;
    }
    if (INLINE.has(role)) {
      for (const child of node.childIds ?? []) walk(child, depth, quiet);
      return;
    }
    flush();
    if (OPAQUE.has(role) && !VALUED.has(role)) return;
    const name = collapse(String(node.name?.value ?? ''));
    const emit = ACTIONABLE.has(role) || STRUCTURE.has(role) || (NAMED_ONLY.has(role) && name !== '');
    let childDepth = depth;
    if (emit) {
      const { attrs, value, checked } = attributes(node, role);
      entries.push({
        role,
        name,
        depth,
        body: `${role}${name ? ` ${JSON.stringify(clip(name))}` : ''}${attrs}`,
        backendNodeId: node.backendDOMNodeId,
        actionable: ACTIONABLE.has(role),
        focused: prop(node, 'focused') === true,
        value,
        checked,
        disabled: prop(node, 'disabled') === true,
      });
      childDepth = depth + 1;
    }
    if (!OPAQUE.has(role)) {
      const childQuiet = quiet || NAME_FROM_CONTENTS.has(role);
      for (const child of node.childIds ?? []) walk(child, childDepth, childQuiet);
    }
    flush();
  };

  const root = nodes[0];
  if (root) walk(root.nodeId, 0, false);
  flush();
  return entries;
}

export function normalizedLines(entries: Entry[]): string[] {
  return entries.map((e) => `${'  '.repeat(e.depth)}${e.body}`);
}

// nth is set only when the role and name are not unique on the page.
export function indexLocators(entries: Entry[]): { role: string; name: string; nth?: number }[] {
  const groups = new Map<string, { role: string; name: string; nth?: number }[]>();
  return entries.map(({ role, name }) => {
    const key = JSON.stringify([role, name]);
    const locator: { role: string; name: string; nth?: number } = { role, name };
    const same = groups.get(key);
    if (same) {
      if (same.length === 1) same[0].nth = 0;
      locator.nth = same.length;
      same.push(locator);
    } else groups.set(key, [locator]);
    return locator;
  });
}

export function findEntry(entries: Entry[], locator: { role: string; name: string; nth?: number }): Entry | undefined {
  const name = collapse(locator.name);
  let nth = locator.nth ?? 0;
  return entries.find(e => e.role === locator.role && e.name === name && nth-- === 0);
}
