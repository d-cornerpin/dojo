// The agent's add_safe_sender adds a contact; it never hands out the owner star and never moves it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../../effects/fs.js', () => ({ existsSync: () => false, statSync: () => ({}) }));
vi.mock('../../../../work/row-authority.js', async (orig) => ({ ...(await orig<typeof import('../../../../work/row-authority.js')>()), ownerAskedInThisTurn: () => ({ ok: true }) }));

import { runMigrations } from '../../../../db/migrations.js';
import { commsHandlers } from '../comms.js';

const AGENT = 'a1';
const setList = (key: string, list: unknown[]) => mockDb.current!.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(key, JSON.stringify(list));
const getList = (key: string) => JSON.parse((mockDb.current!.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string }).value) as Array<{ address: string; is_primary: boolean }>;
const rec = (address: string, is_primary: boolean) => ({ address, name: address, is_primary, sharing_level: 'dont_overshare' });
const add = (channel: string, address: string) => commsHandlers['add_safe_sender']!(
  { agentId: AGENT, args: { channel, address, user_quote: 'please start texting this person for me' } } as never);

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  mockDb.current.pragma('foreign_keys = ON');
  runMigrations();
  mockDb.current.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Primary', 'idle', '1970-01-01')`).run(AGENT);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('add_safe_sender', () => {
  // Stricter than "never stars": with no human-set owner in the list the tool refuses outright
  // (the-agent-cannot-become-the-owner), so an ownerless list is left exactly as it was.
  it('refuses to add to an ownerless list and leaves it unstarred and unchanged', async () => {
    setList('imessage_approved_senders', [rec('+15550001', false)]);
    const out = await add('imessage', '+15550002');
    expect(out.isError).toBe(true);
    expect(getList('imessage_approved_senders').map((s) => [s.address, s.is_primary])).toEqual([['+15550001', false]]);
  });
  it('refuses to add to an EMPTY list: the agent never makes the first entry the owner', async () => {
    const out = await add('imessage', '+15550002');
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/no owner is set/);
  });
  it('leaves the star where it was', async () => {
    setList('imessage_approved_senders', [rec('+15550001', false), rec('+15550002', true)]);
    await add('imessage', '+15550003');
    expect(getList('imessage_approved_senders').map((s) => [s.address, s.is_primary])).toEqual([['+15550001', false], ['+15550002', true], ['+15550003', false]]);
  });
  it('the Teams list is the same', async () => {
    setList('teams_approved_senders', [rec('a@x.test', true)]);
    await add('teams', 'b@x.test');
    expect(getList('teams_approved_senders').map((s) => s.is_primary)).toEqual([true, false]);
  });
});
