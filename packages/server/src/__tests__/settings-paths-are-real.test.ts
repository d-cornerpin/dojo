// A message that tells a person where to click must name a tab and card that are on screen.
// The list of tabs and cards lives in @dojo/shared (settings-map.ts); this test makes two checks.
//   1. Every card title in that list is really shown by the dashboard.
//   2. Every "Settings → Tab → Card" typed into server or dashboard source names a real tab, and a
//      card that belongs to that tab, in the one arrow style.
// It ignores: test files and __tests__ folders (they may quote a wrong path on purpose), comment-only
// lines (the reader is a developer, not a person), and "System Settings …" (the macOS app, not ours).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS_CARDS, SETTINGS_TAB_LIST, settingsPath, type SettingsTabKey } from '@dojo/shared';

const here = path.dirname(fileURLToPath(import.meta.url));

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|\{\/\*)/;
const START = /(?<![A-Za-z])(?<!System )Settings\s*(?:→|->|›|>|▸)\s*(?=[A-Za-z$"'`])/g;
const ARROW = /^\s*(→|->|›|>|▸)\s*/;
// Audit round (rulings audit #13, V13): a path written from somewhere that is not the Settings menu ("Dashboard ->
// Integrations": there is no such place) is wrong whatever follows it.
const NOT_A_MENU = /(?<![A-Za-z])Dashboard\s*(?:→|->|›|>|▸)\s*[A-Za-z]/;

/** Every wrong path in one file, as "line: text". */
function badPaths(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const isMd = file.endsWith('.md');
  const lines = text.split('\n');
  const bad: string[] = [];
  lines.forEach((line, i) => {
    if (!isMd && COMMENT_LINE.test(line)) return;
    if (NOT_A_MENU.test(line)) bad.push(`${i + 1}: a path that starts outside Settings: ${line.trim().slice(0, 100)}`);
    for (const m of line.matchAll(START)) {
      if (!m[0].includes('→')) { bad.push(`${i + 1}: arrow other than "→": ${line.trim().slice(0, 100)}`); continue; }
      let rest = line.slice(m.index! + m[0].length);
      let tab: SettingsTabKey | null = null;
      let depth = 0;
      for (;;) {
        const known: string[] = depth === 0
          ? SETTINGS_TAB_LIST.map((t) => t.label)
          : Object.values(SETTINGS_CARDS).filter((c) => c.tab === tab).map((c) => c.title);
        const hit = known.filter((k) => rest.startsWith(k)).sort((a, b) => b.length - a.length)[0];
        if (!hit) { bad.push(`${i + 1}: "${rest.split(/[.,;)"'`]|\sand\s/)[0].slice(0, 40)}" is not a ${depth === 0 ? 'tab' : `card on the ${tab} tab`}`); break; }
        if (depth === 0) tab = SETTINGS_TAB_LIST.find((t) => t.label === hit)!.key;
        rest = rest.slice(hit.length);
        const next = ARROW.exec(rest);
        if (!next) break;
        if (!next[0].includes('→')) { bad.push(`${i + 1}: arrow other than "→" after "${hit}"`); break; }
        if (depth === 1) { bad.push(`${i + 1}: a path goes deeper than tab → card`); break; }
        rest = rest.slice(next[0].length);
        depth++;
      }
    }
  });
  return bad.map((b) => `${path.relative(path.resolve(here, '../../../..'), file)}:${b}`);
}

describe('menu paths in messages are real', () => {

  it('the helper builds paths from the tab label, not its key', () => {
    expect(settingsPath('platform')).toBe('Settings → Dojo');
    expect(settingsPath('ollama')).toBe('Settings → Dojo → Ollama (Local Models)');
    expect(settingsPath('imessage')).toBe('Settings → Channels → iMessage Bridge');
  });

  it('the scan can tell a wrong path from a right one', () => {
    const tmp = fs.mkdtempSync(path.join(process.env.DOJO_HOME ?? process.env.TMPDIR ?? '/tmp', 'paths-'));
    const f = path.join(tmp, 'x.ts');
    fs.writeFileSync(f, [
      "const a = 'Open Settings → Platform → Ollama';",
      "const b = 'Open Settings > Dojo';",
      "const c = 'Open Settings → Dojo → Ollama (Local Models).';",
      "const d = 'Open Settings → Channels → Twilio → Voice';",
      "const e = 'Open Settings → Models → Ollama (Local Models)';",
      "const g = 'System Settings > Privacy & Security';",
      "// Settings → Nowhere",
      "const h = 'reconnect in Dashboard -> Integrations';",
      "const i = 'reconnect in Settings ▸ Channels ▸ Google';",
    ].join('\n'));
    const bad = badPaths(f);
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(bad.map((b) => b.split(':')[1].trim())).toEqual(['1', '2', '4', '5', '8', '9']);
  });
});
