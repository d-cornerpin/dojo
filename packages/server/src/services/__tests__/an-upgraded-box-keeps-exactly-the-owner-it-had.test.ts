// OWNER RULING #27 (never block the main agent from texting the owner) + the star ruling: a box upgraded
// from 3.4.1 keeps EXACTLY the owner it had. 3.4.1's reader (services/safe-senders.ts parseSafeSenders at
// v3.4.1) answered "who is the owner" for a list with no starred entry by promoting the entry matching the
// legacy `imessage_default_sender` key, else the FIRST entry; a bare-address list meant its first entry.
// The new reader never promotes, so a one-time conversion writes the old answer down as a star. It runs
// once (done-marker), never touches a list that already has a star, and never runs for later additions.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));

import { runMigrations } from '../../db/migrations.js';
import { parseSafeSenders, addressesMatch } from '../safe-senders.js';
import { starTheOwnersTheOldReaderImplied } from '../owner-star-upgrade.js';

const db = (): Database.Database => mockDb.current!;
const setConfig = (k: string, v: string): void => { db().prepare("INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v); };
const getConfig = (k: string): string | null => (db().prepare('SELECT value FROM config WHERE key = ?').get(k) as { value: string } | undefined)?.value ?? null;

/** v3.4.1's rule, transcribed: the owner a list had before this change. */
function ownerBefore(raw: string, legacy: string | null): string | null {
  const parsed = JSON.parse(raw) as unknown[];
  const valid: Array<{ address: string; primary: boolean }> = [];
  parsed.forEach((item, i) => {
    if (typeof item === 'string') { const a = item.trim(); if (a) valid.push({ address: a, primary: i === 0 }); }
    else if (item && typeof item === 'object') {
      const o = item as { address?: unknown; is_primary?: unknown };
      const a = typeof o.address === 'string' ? o.address.trim() : '';
      if (a) valid.push({ address: a, primary: o.is_primary === true });
    }
  });
  const starred = valid.filter((v) => v.primary);
  if (starred.length === 0 && valid.length > 0) {
    const idx = legacy ? valid.findIndex((v) => addressesMatch(v.address, legacy)) : -1;
    return (idx >= 0 ? valid[idx] : valid[0]).address;
  }
  return starred[0]?.address ?? null;
}
const ownerAfter = (raw: string): string | null => parseSafeSenders(raw).find((s) => s.is_primary)?.address ?? null;
const rec = (address: string, is_primary?: boolean) => ({ address, name: address, ...(is_primary === undefined ? {} : { is_primary }), sharing_level: 'dont_overshare' });

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(); });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the one-time owner conversion', () => {
  it.each([
    ['a bare-address list', JSON.stringify(['+15550001', '+15550002']), null],
    ['a list with no star and no legacy key (first entry was the owner)', JSON.stringify([rec('+15550001'), rec('+15550002')]), null],
    ['a list with no star and a legacy key naming the SECOND entry', JSON.stringify([rec('+15550001'), rec('+15550002')]), '+15550002'],
    ['a list with no star and a legacy key written in another phone format', JSON.stringify([rec('+15550001'), rec('+15550002')]), '(555) 0002'],
    ['a list whose legacy key names nobody on it (falls to the first entry)', JSON.stringify([rec('a@x.test'), rec('b@x.test')]), '+19998887777'],
    ['a list that already has a star', JSON.stringify([rec('+15550001', false), rec('+15550002', true)]), '+15550001'],
  ])('%s: the owner after the upgrade is the owner before', (_n, raw, legacy) => {
    setConfig('imessage_approved_senders', raw);
    if (legacy) setConfig('imessage_default_sender', legacy);
    const before = ownerBefore(raw, legacy);
    starTheOwnersTheOldReaderImplied();
    // the NEW reader, reading what the conversion left in the config
    const stored = getConfig('imessage_approved_senders')!;
    expect(ownerAfter(stored)).toBe(before);
    expect(before).not.toBeNull();
  });

  it('leaves a list that already has a star byte-for-byte alone', () => {
    const raw = JSON.stringify([rec('+15550001', false), rec('+15550002', true)]);
    setConfig('imessage_approved_senders', raw);
    starTheOwnersTheOldReaderImplied();
    expect(getConfig('imessage_approved_senders')).toBe(raw);
  });

  it('converts the channel lists too (3.4.1 used one reader for all of them)', () => {
    const raw = JSON.stringify([rec('a@x.test'), rec('b@x.test')]);
    setConfig('gmail_approved_senders_acct1', raw);
    setConfig('teams_approved_senders', raw);
    starTheOwnersTheOldReaderImplied();
    expect(ownerAfter(getConfig('gmail_approved_senders_acct1')!)).toBe('a@x.test');
    expect(ownerAfter(getConfig('teams_approved_senders')!)).toBe('a@x.test');
  });

  it('runs once: a list that loses its star later, or is made after the upgrade, is never starred by it', () => {
    setConfig('imessage_approved_senders', JSON.stringify([rec('+15550001', true)]));
    starTheOwnersTheOldReaderImplied();
    expect(getConfig('owner_star_conversion_done')).toBe('1');
    const ownerless = JSON.stringify([rec('+15550002')]);          // the owner removed his star on purpose, or an agent added entries
    setConfig('imessage_approved_senders', ownerless);
    setConfig('gmail_approved_senders_acct2', JSON.stringify([rec('c@x.test')]));
    starTheOwnersTheOldReaderImplied();
    expect(getConfig('imessage_approved_senders')).toBe(ownerless);
    expect(ownerAfter(getConfig('gmail_approved_senders_acct2')!)).toBeNull();
  });

  it('does not touch an empty or unreadable value', () => {
    setConfig('imessage_approved_senders', '{not json');
    setConfig('teams_approved_senders', '[]');
    starTheOwnersTheOldReaderImplied();
    expect(getConfig('imessage_approved_senders')).toBe('{not json');
    expect(getConfig('teams_approved_senders')).toBe('[]');
  });
});
