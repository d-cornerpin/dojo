// ════════════════════════════════════════════════════════════════════════════
// HID ARGUMENT VECTORS (PHASE-5 T3 Step 2) — the six string-to-shell sites,
// turned into data.
//
// Every HID call in `system-control.ts` used to build a COMMAND STRING and hand
// it to `execSync`, which is `/bin/sh -c`. Five of the six interpolated a value
// the model chose, and the sharpest was `keyboard_type`:
//
//     const escaped = text.replace(/'/g, "'\\''");
//     execSync(`cliclick t:'${escaped}'`)
//
// — a hand-rolled single-quote escape, in front of a shell, on text an agent
// composed, gated by nothing but `system_control`. An agent granted *"control
// the mouse and keyboard"* held a shell.
//
// ── WHY BUILDERS AND NOT JUST `execFileSync` AT THE CALL SITES ──
// Because the shell was doing work nobody noticed. `cliclick kd:cmd t:c ku:cmd`
// is FOUR arguments, and the space-splitting that produced them was the shell's.
// Move to `execFileSync` without moving the splitting and cliclick receives one
// argument it does not understand — the keyboard silently stops working. So the
// splitting becomes explicit, here, where a test can read it, and each builder
// returns the vector rather than a line.
//
// These are PURE: no process, no fs, no logger. That is what lets the test above
// assert on injection payloads without ever running one.
// ════════════════════════════════════════════════════════════════════════════

/** cliclick's click verbs, by the tool's `click_type`. */
const CLICK_VERB: Readonly<Record<string, string>> = {
  left: 'c',
  right: 'rc',
  double: 'dc',
};

/** `mouse_click` → e.g. `['c:10,21']`. Coordinates are rounded exactly as
 *  before; they are numbers, so they were never the injection risk — the vector
 *  is for consistency, and so `system-control.ts` has ONE spawn shape. */
export function clickArgv(x: number, y: number, clickType = 'left'): string[] {
  const verb = CLICK_VERB[clickType] ?? CLICK_VERB.left;
  return [`${verb}:${Math.round(x)},${Math.round(y)}`];
}

/** `mouse_move` → e.g. `['m:3,5']`. */
export function moveArgv(x: number, y: number): string[] {
  return [`m:${Math.round(x)},${Math.round(y)}`];
}

/**
 * The named combos, VERBATIM from the map that stood in `system-control.ts` —
 * same keys, same cliclick verbs, now stored pre-split so nothing has to
 * re-derive where the spaces were.
 */
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

/** Combos cliclick presses rather than types — the generic parser's rule,
 *  verbatim: a one-character final key is `t:`, anything longer is `kp:`. */
function finalKeyArg(key: string): string {
  return key.length === 1 ? `t:${key}` : `kp:${key}`;
}

/**
 * `keyboard_type(key_combo)` → the vector, or `null` when the combo cannot be
 * parsed (which the caller turns into the same `Unknown key combo` message it
 * always returned).
 *
 * The generic branch reproduces the old parser exactly, INCLUDING its
 * modifier-reversal on release, so `cmd+shift+k` still presses and releases in
 * the order it did.
 */
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

/**
 * `keyboard_type(text)` → `['t:<text>']`, ONE element.
 *
 * ⚠ THERE IS NO ESCAPING HERE AND THAT IS THE FIX, not an omission. The text an
 * agent composed is one argument; `execFileSync` hands it to `cliclick` as
 * bytes, and no shell ever sees it, so a quote has nothing to close and a pipe
 * has nothing to pipe into. The old `replace(/'/g, "'\\''")` existed only
 * because the string was about to be parsed by `/bin/sh`.
 */
export function typeTextArgv(text: string): string[] {
  return [`t:${text}`];
}

/** `screen_screenshot` → the `screencapture` vector. A path with a space in it
 *  is ONE element, which the quoted string form only got right by accident. */
export function screencaptureArgv(
  outPath: string,
  region: { x: number; y: number; width: number; height: number } | null,
): string[] {
  const argv = ['-x'];
  if (region) argv.push(`-R${region.x},${region.y},${region.width},${region.height}`);
  argv.push(outPath);
  return argv;
}
