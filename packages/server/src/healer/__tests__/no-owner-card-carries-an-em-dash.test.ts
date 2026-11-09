// Owner standing rule "No em-dashes": every card sentence the one writer derives, and every fixed card text it ships,
// reaches the owner without an em-dash.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
const frames = vi.hoisted(() => [] as Array<{ error?: string }>);
vi.mock('../../gateway/ws.js', () => ({ broadcast: (f: object) => { frames.push(f); }, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import * as notices from '../owner-notices.js';

const EM_DASH = '\u2014';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare("INSERT INTO agents (id, name, status) VALUES ('a-1', 'Helper', 'idle')").run();
  frames.length = 0;
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('no owner card carries an em-dash', () => {
  it('every derived card sentence and every shipped card text, as pushed to the dashboard', () => {
    const derived = ['stuck', 'stall', 'nofit', 'budgetstop', 'healer-missing', 'embedding-switch', 'fitunchecked', 'healer-broken']
      .map((kind) => notices.wordsOf(`${kind}:a-1`)).filter((w) => w.length > 0);
    const fixed = Object.entries(notices).filter(([name, v]) => /_WORDS$/.test(name) && typeof v === 'string').map(([, v]) => v as string);
    for (const [i, words] of [...derived, ...fixed].entries()) notices.tellOwner(`probe:${i}`, words);
    expect(derived.length).toBeGreaterThan(4);
    expect(frames.length).toBe(derived.length + fixed.length);
    expect(frames.filter((f) => f.error?.includes(EM_DASH)).map((f) => f.error)).toEqual([]);
  });
});
