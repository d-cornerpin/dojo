// v3.5 inspect B1 — the two pure time readers in scope.ts, the ones every view uses to put a turn
// on a timeline. A column read the wrong way (epoch ms vs SQLite's UTC text) puts the whole turn in
// the wrong place, so both `toMs` and `msExpr` get their own tests.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { toMs, msExpr } from '../scope.js';

describe('toMs', () => {
  it('reads a SQLite UTC datetime and an ISO string as the same epoch ms, and an hour:minute form too', () => {
    const t = Date.UTC(2026, 9, 19, 9, 23, 7);
    expect(toMs('2026-10-19 09:23:07')).toBe(t);
    expect(toMs('2026-10-19T09:23:07Z')).toBe(t);
    expect(toMs('2026-10-19 09:23')).toBe(Date.UTC(2026, 9, 19, 9, 23, 0));
  });

  it('passes epoch ms through, whether it is a number or a 10-or-more-digit string', () => {
    expect(toMs(1760000000000)).toBe(1760000000000);
    expect(toMs('1760000000000')).toBe(1760000000000);
  });

  it('returns null for nothing, an empty string, an unparseable string and NaN', () => {
    expect(toMs(null)).toBeNull();
    expect(toMs(undefined)).toBeNull();
    expect(toMs('')).toBeNull();
    expect(toMs('garbage')).toBeNull();
    expect(toMs(NaN)).toBeNull();
  });
});

describe('msExpr', () => {
  it('is the column itself for an ms-stored column, and the cast for a text-stored one', () => {
    expect(msExpr('c', 'ms')).toBe('c');
    expect(msExpr('c', 'text')).toBe("(CAST(strftime('%s', c) AS INTEGER) * 1000)");
  });

  it('reads a text time column as epoch ms through a real database, matching toMs of that text', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (created_at TEXT)');
    db.prepare('INSERT INTO t (created_at) VALUES (?)').run('2026-10-19 09:23:07');
    const got = db.prepare(`SELECT ${msExpr('created_at', 'text')} AS ms FROM t`).get() as { ms: number };
    expect(got.ms).toBe(toMs('2026-10-19 09:23:07'));
    db.close();
  });
});
