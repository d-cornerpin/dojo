// ════════════════════════════════════════════════════════════════════════════════════════
// OR-AUDIT-ANSWERS (d), owner ruling: the texts the Dojo itself sends the owner (the watchdog's and the platform's own,
// never an agent's) are exactly: offline and back online (an update that failed included), budget alerts, a broken
// agent, and the Mac critical (disk and memory). The server's door is censused in
// `services/__tests__/t138-every-owner-notice-has-a-class.test.ts` (budget, broken-agent, mac-critical, named by each
// call). This is the watchdog's half: every text it can send, by the alert key that gates it, and that key's kind.
// A new text, or a removed one, fails here until it is classified against the owner's set.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WATCHDOG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../watchdog/src/index.ts');
type Kind = 'offline' | 'back-online' | 'update-failed' | 'mac-critical';
const OWNERS_SET: readonly Kind[] = ['offline', 'back-online', 'update-failed', 'mac-critical'];

/** Every alert key the watchdog claims before a text, and every key it resolves with a follow-up text. */
const RAISED: Record<string, Kind> = {
  memory_low: 'mac-critical',
  disk_low: 'mac-critical',
  auto_rollback_failed: 'update-failed',
  auto_rollback: 'update-failed',
  platform_missing: 'offline',
  platform_down: 'offline',
  platform_restart_failed: 'offline',
};
const RESOLVED: Record<string, Kind> = {
  memory_low: 'mac-critical',
  disk_low: 'mac-critical',
  platform_down: 'back-online',
  platform_missing: 'back-online',
  auto_rollback_failed: 'back-online',
};

const code = (): string => fs.readFileSync(WATCHDOG, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const keysOf = (src: string, fn: string): string[] => [...src.matchAll(new RegExp(`\\b${fn}\\('([a-z_]+)'`, 'g'))].map((m) => m[1]);

describe('the watchdog texts only the owner\'s set (OR-AUDIT-ANSWERS (d))', () => {
  const src = code();

  it('every claimed alert is one of the declared texts, and every declared text exists', () => {
    expect([...new Set(keysOf(src, 'claimAlertFor'))].sort()).toEqual(Object.keys(RAISED).sort());
  });

  it('every follow-up text is declared, and every declared follow-up exists', () => {
    expect([...new Set(keysOf(src, 'resolveAndTell'))].sort()).toEqual(Object.keys(RESOLVED).sort());
  });

  it('every kind is in the owner\'s set', () => {
    for (const k of [...Object.values(RAISED), ...Object.values(RESOLVED)]) expect(OWNERS_SET).toContain(k);
  });

  it('each smart text is gated by one claim; the one raw text is the interrupted update (update failed)', () => {
    const smart = [...src.matchAll(/\bsendSmartAlert\(/g)].length - 1;   // less its definition
    expect(smart).toBe(keysOf(src, 'claimAlertFor').length);
    const raw = [...src.matchAll(/\bsendIMessage\(([^)]*)\)/g)].map((m) => m[1]).filter((a) => !/^recipient: string/.test(a));
    expect(raw.sort()).toEqual(['recipient, await composeSmartAlert(fixedText', 'to, interruptedUpdateText(marker', 'to, text'].sort());
  });

  it('a failed database integrity check is logged, not texted (not in the owner\'s set)', () => {
    expect(keysOf(src, 'claimAlertFor')).not.toContain('db_integrity');
    expect(/async function alertDbIntegrity[\s\S]*?\n}/.exec(src)?.[0]).not.toMatch(/sendSmartAlert|sendIMessage/);
  });
});
