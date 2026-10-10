type KeyDef = { key: string; code: string; keyCode: number; text?: string };

const NAMED: Record<string, KeyDef> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};
const ALIASES: Record<string, string> = { Esc: 'Escape', Return: 'Enter', ' ': 'Space', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' };
const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 };

export type KeyEvent = { type: 'keyDown' | 'rawKeyDown' | 'keyUp'; modifiers: number; key: string; code: string; windowsVirtualKeyCode: number; text?: string; unmodifiedText?: string };

// Turns "Enter", "a" or "Control+a" into the CDP key events for one press.
export function keyEvents(spec: string): KeyEvent[] {
  const parts = spec === '+' ? ['+'] : spec.split('+');
  const keyName = parts.pop()!;
  let modifiers = 0;
  for (const m of parts) {
    if (!(m in MODIFIERS)) throw new Error(`Unknown modifier "${m}" in "${spec}"`);
    modifiers |= MODIFIERS[m];
  }
  const name = ALIASES[keyName] ?? keyName;
  let def = NAMED[name];
  if (!def) {
    if ([...name].length !== 1) throw new Error(`Unknown key "${keyName}"`);
    const upper = name.toUpperCase();
    const code = /[a-z]/i.test(name) ? `Key${upper}` : /[0-9]/.test(name) ? `Digit${name}` : '';
    def = { key: name, code, keyCode: upper.charCodeAt(0), text: name };
  }
  // Text is suppressed under Control/Alt/Meta so shortcuts do not type.
  const text = modifiers & 7 ? undefined : def.text;
  const base = { modifiers, key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode };
  return [
    text ? { type: 'keyDown', ...base, text, unmodifiedText: text } : { type: 'rawKeyDown', ...base },
    { type: 'keyUp', ...base },
  ];
}
