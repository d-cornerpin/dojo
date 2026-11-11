// HID argument vectors: builders turn tool arguments into argv vectors.
// Nothing here reaches a shell: `system-control.ts` spawns these directly, so a
// model-chosen string is one inert argument, never parsed. No escaping exists
// here and that is the design: bytes reach the program, not a parser.
// Key combos are stored and built PRE-SPLIT: cliclick takes `kd:cmd t:c ku:cmd`
// as SEPARATE arguments, so the splitting is explicit data, not the shell's job.
// These functions are PURE: no process, no fs, no logger, so tests can pin the
// vectors (injection included) without running one.

/** cliclick's click verbs, by the tool's `click_type`. */
const CLICK_VERB: Readonly<Record<string, string>> = {
  left: 'c',
  right: 'rc',
  double: 'dc',
};

/** `mouse_click` argv: one element, e.g. `['c:10,21']`; coordinates round to integers. */
export function clickArgv(x: number, y: number, clickType = 'left'): string[] {
  const verb = CLICK_VERB[clickType] ?? CLICK_VERB.left;
  return [`${verb}:${Math.round(x)},${Math.round(y)}`];
}

/** `mouse_move` → e.g. `['m:3,5']`. */
export function moveArgv(x: number, y: number): string[] {
  return [`m:${Math.round(x)},${Math.round(y)}`];
}

/** Named combos, stored PRE-SPLIT: each vector is what cliclick receives verbatim. */
const KEY_COMBO_ARGV: Readonly<Record<string, readonly string[]>> = {
  'cmd+c': ['kd:cmd', 't:c', 'ku:cmd'],
  'cmd+v': ['kd:cmd', 't:v', 'ku:cmd'],
  'cmd+a': ['kd:cmd', 't:a', 'ku:cmd'],
  'cmd+z': ['kd:cmd', 't:z', 'ku:cmd'],
  'cmd+s': ['kd:cmd', 't:s', 'ku:cmd'],
  'cmd+x': ['kd:cmd', 't:x', 'ku:cmd'],
  'cmd+w': ['kd:cmd', 't:w', 'ku:cmd'],
  'cmd+q': ['kd:cmd', 't:q', 'ku:cmd'],
  'cmd+n': ['kd:cmd', 't:n', 'ku:cmd'],
  'cmd+t': ['kd:cmd', 't:t', 'ku:cmd'],
  'cmd+f': ['kd:cmd', 't:f', 'ku:cmd'],
  'cmd+tab': ['kd:cmd', 'kp:tab', 'ku:cmd'],
  'cmd+space': ['kd:cmd', 'kp:space', 'ku:cmd'],
  'cmd+shift+3': ['kd:cmd', 'kd:shift', 'kp:3', 'ku:shift', 'ku:cmd'],
  'cmd+shift+4': ['kd:cmd', 'kd:shift', 'kp:4', 'ku:shift', 'ku:cmd'],
  'cmd+shift+z': ['kd:cmd', 'kd:shift', 't:z', 'ku:shift', 'ku:cmd'],
  'cmd+shift+t': ['kd:cmd', 'kd:shift', 't:t', 'ku:shift', 'ku:cmd'],
  'cmd+option+esc': ['kd:cmd', 'kd:alt', 'kp:escape', 'ku:alt', 'ku:cmd'],
  'ctrl+c': ['kd:ctrl', 't:c', 'ku:ctrl'],
  'return': ['kp:return'],
  'enter': ['kp:return'],
  'escape': ['kp:escape'],
  'esc': ['kp:escape'],
  'tab': ['kp:tab'],
  'delete': ['kp:delete'],
  'backspace': ['kp:delete'],
  'space': ['kp:space'],
  'arrow-up': ['kp:arrow-up'],
  'arrow-down': ['kp:arrow-down'],
  'arrow-left': ['kp:arrow-left'],
  'arrow-right': ['kp:arrow-right'],
  'up': ['kp:arrow-up'],
  'down': ['kp:arrow-down'],
  'left': ['kp:arrow-left'],
  'right': ['kp:arrow-right'],
  'home': ['kp:home'],
  'end': ['kp:end'],
  'pageup': ['kp:page-up'],
  'pagedown': ['kp:page-down'],
  'f1': ['kp:f1'], 'f2': ['kp:f2'], 'f3': ['kp:f3'], 'f4': ['kp:f4'], 'f5': ['kp:f5'],
};

/** Combos cliclick presses rather than types: a one-character final key is
 *  `t:`, anything longer is `kp:`. */
function finalKeyArg(key: string): string {
  return key.length === 1 ? `t:${key}` : `kp:${key}`;
}

export function keyComboArgv(keyCombo: string): string[] | null {
  const combo = keyCombo.toLowerCase();
  const mapped = KEY_COMBO_ARGV[combo];
  if (mapped) return [...mapped];

  const modifiers: string[] = [];
  let finalKey = '';
  for (const part of combo.split('+')) {
    if (part === 'cmd' || part === 'command') modifiers.push('cmd');
    else if (part === 'ctrl' || part === 'control') modifiers.push('ctrl');
    else if (part === 'alt' || part === 'option' || part === 'opt') modifiers.push('alt');
    else if (part === 'shift') modifiers.push('shift');
    else finalKey = part;
  }
  if (!finalKey || modifiers.length === 0) return null;
  const down = modifiers.map((m) => `kd:${m}`);
  const up = [...modifiers].reverse().map((m) => `ku:${m}`);
  return [...down, finalKeyArg(finalKey), ...up];
}

/** Text is ONE element: `['t:<text>']`. No escaping, and no shell to escape out of. */
export function typeTextArgv(text: string): string[] {
  return [`t:${text}`];
}

export function screencaptureArgv(
  outPath: string,
  region: { x: number; y: number; width: number; height: number } | null,
): string[] {
  const argv = ['-x'];
  if (region) argv.push(`-R${region.x},${region.y},${region.width},${region.height}`);
  argv.push(outPath);
  return argv;
}
