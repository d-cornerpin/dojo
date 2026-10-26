// ════════════════════════════════════════════════════════════════════════════════════════
// THE LOGGER NEVER THROWS ON WHAT IT WAS ASKED TO LOG.
//
// ── THE DEFECT ──
// `writeEntry` built each line with a bare `JSON.stringify(entry)`. `entry.meta` is
// whatever the caller handed in, and two legal inputs make `JSON.stringify` throw: a
// BigInt (`Do not know how to serialize a BigInt`) and a circular structure
// (`Converting circular structure to JSON` — an HTTP library's error that holds its
// own request/response, or a SQLite integer read in BigInt mode). `createLogger` called
// `writeEntry` with no guard, so the throw escaped into the code that only wanted to log;
// most call sites sit inside a `catch`, so a handled failure became a thrown one and the
// warn/error broadcast to the dashboard was skipped with it.
//
// ── WHAT IS PINNED HERE ──
//   the logger absorbs a BigInt and a cycle instead of propagating them;
//   warn/error still reach the broadcast callback;
//   a normal entry serialises byte for byte as before;
//   every line — even a salvaged one — keeps the `{"timestamp":"` prefix rotation trusts;
//   nothing is left stuck after a hard case, so the next line still lands.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import { createLogger, readLogFiles, setLogBroadcast } from '../logger.js';

// `logger.ts` computes its log folder at import time from `homeDir()`, so the home must
// be redirected before the import resolves.
const tmp = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-logger-'));
});
vi.mock('../home.js', () => ({ homeDir: () => tmp }));

const log = createLogger('logger-never-throws');

/** The live text: the file plus whatever is still in the not-yet-flushed buffer. */
function logged(): string {
  return readLogFiles()[1];
}

/** The lines logged so far, oldest first, blanks dropped. */
function lines(): string[] {
  return logged().split('\n').filter((l) => l.length > 0);
}

afterAll(async () => {
  // Wait out the 500 ms flush timer so the last lines land, then take the scratch home.
  await new Promise((r) => setTimeout(r, 700));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the logger never throws on what it was asked to log', () => {
  it('absorbs a BigInt in meta instead of throwing (case 1)', () => {
    expect(() => log.info('bigint-case', { n: 123n })).not.toThrow();
    const text = logged();
    expect(text).toContain('"message":"bigint-case"');
    expect(text).toContain('"n":"123"');
  });

  it('absorbs a circular meta instead of throwing (case 2)', () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    expect(() => log.info('circular-case', o)).not.toThrow();
    const text = logged();
    expect(text).toContain('"message":"circular-case"');
    expect(text).toContain('"self":"[Circular]"');
    expect(text).toContain('"a":1');
  });

  it('still reaches the broadcast callback for a warn that carries a BigInt (case 3)', () => {
    const seen: Array<{ level?: string; message?: string }> = [];
    setLogBroadcast((entry) => seen.push({ level: entry.level, message: entry.message }));
    expect(() => log.warn('warn-bigint', { n: 5n })).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(seen[0].level).toBe('warn');
    expect(seen[0].message).toBe('warn-bigint');
  });

  it('serialises a normal entry byte for byte as before (case 4)', () => {
    log.info('plain-case', { a: 1, b: 'x' });
    const last = lines().at(-1);
    expect(last).toBeDefined();
    expect(last!.startsWith('{"timestamp":"')).toBe(true);
    const entry = JSON.parse(last!) as {
      level: string;
      message: string;
      meta?: Record<string, unknown>;
    };
    expect(entry.level).toBe('info');
    expect(entry.message).toBe('plain-case');
    expect(entry.meta).toEqual({ a: 1, b: 'x' });
  });

  it('logs a further normal entry after the hard cases — nothing is stuck (case 5)', () => {
    log.info('still-logging', { ok: true });
    expect(logged()).toContain('"message":"still-logging"');
  });

  it('keeps the rotation-guard prefix on every line cases 1 and 2 wrote (case 6)', () => {
    const bigintLine = lines().find((l) => l.includes('"message":"bigint-case"'));
    const circularLine = lines().find((l) => l.includes('"message":"circular-case"'));
    expect(bigintLine).toBeDefined();
    expect(circularLine).toBeDefined();
    expect(bigintLine!.startsWith('{"timestamp":"')).toBe(true);
    expect(circularLine!.startsWith('{"timestamp":"')).toBe(true);
  });
});
