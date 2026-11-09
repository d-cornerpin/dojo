// Owner standing rule "No em-dashes": the one card writer takes any em-dash out of a sentence before the owner sees
// it, on the live card and on the reload list.
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
import { tellOwner } from '../owner-notices.js';
import { servedOwnerNotices } from '../owner-notice-kinds.js';

const EM_DASH = String.fromCharCode(0x2014);

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(mockDb.current); frames.length = 0; });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('no owner card carries an em-dash', () => {
  it('a sentence written with one reaches the card and the reload list without it', () => {
    tellOwner('healer-broken', `The Healer stopped ${EM_DASH} open its page to look.`);
    expect(frames.map((f) => f.error)).toEqual(['The Healer stopped, open its page to look.']);
    expect(servedOwnerNotices().map((n) => n.words)).toEqual(['The Healer stopped, open its page to look.']);
  });
});
