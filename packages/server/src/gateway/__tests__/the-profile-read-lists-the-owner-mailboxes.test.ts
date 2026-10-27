// The identity GET for USER.md is the read the dashboard's Profile tab already makes, so it
// carries the owner's mailboxes too (owner ruling 2026-10-27) — one answer, no second route.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
const frames = vi.hoisted(() => ({ list: [] as Array<{ type?: string; error?: string; severity?: string }> }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: (f: { type?: string }) => { frames.list.push(f); }, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { Hono } from 'hono';
import { configRouter } from '../routes/config.js';
import { insertGoogleAccount } from '../../google/accounts.js';
import { insertMicrosoftAccount } from '../../microsoft/accounts.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
});

const app = new Hono().route('/config', configRouter);
const read = async () => (await (await app.request('/config/identity/user')).json()) as { ok: boolean; data: { content: string; mailboxes?: unknown } };

describe('the profile read lists the owner mailboxes', () => {
  it('answers with the profile content and an empty list when nothing is connected', async () => {
    const res = await read();
    expect(res.data.mailboxes).toEqual([]);
    expect(typeof res.data.content).toBe('string');
  });

  it('lists the connected user accounts, google first, addresses lowercased', async () => {
    const g = insertGoogleAccount({ kind: 'user', email: 'Me@Gmail.com', connected: true });
    const m = insertMicrosoftAccount({ kind: 'user', email: 'me@work.com', connected: true });
    const res = await read();
    expect(res.data.mailboxes).toEqual([
      { address: 'me@gmail.com', provider: 'google', accountId: g.id },
      { address: 'me@work.com', provider: 'microsoft', accountId: m.id },
    ]);
  });

  it("never lists an agent's mailbox as the owner's", async () => {
    insertGoogleAccount({ kind: 'agent', email: 'bot@gmail.com', connected: true });
    const res = await read();
    expect(res.data.mailboxes).toEqual([]);
  });
});
