// Saving the owner's name through the settings route changes the name the agents' message-sources text and
// the first-time profile carry, and an old user_name row is settled by migration 217 (the later edit wins).
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
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { Hono } from 'hono';
import { configRouter } from '../routes/config.js';
import { renderMessageSources } from '../../prompt/assembler.js';
import { defaultUserProfile } from '../../prompt/user-profile.js';
import { clearPlatformConfigCache } from '../../config/platform.js';

const app = new Hono().route('/config', configRouter);
const save = (key: string, value: string) =>
  app.request(`/config/settings/${key}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) });
const stored = (key: string) => (mockDb.current!.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined)?.value;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  clearPlatformConfigCache();
});

describe('editing the owner name', () => {
  it('names the new name in the text the agents are given', async () => {
    await save('owner_name', 'Alex');
    expect(renderMessageSources()).toContain('direct message from Alex via dashboard');
    expect(defaultUserProfile()).toContain('- Name: Alex');

    await save('owner_name', 'Sam');
    expect(renderMessageSources()).toContain('direct message from Sam via dashboard');
    expect(renderMessageSources()).not.toContain('Alex');
  });

  it('migration 217 moves a name saved under the old key onto owner_name, the later edit winning', () => {
    const db = mockDb.current!;
    const put = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
    put.run('owner_name', 'Old Setup Name');
    put.run('user_name', ' Alex ');
    db.prepare('DELETE FROM _migrations WHERE name = ?').run('217_one_owner_name_key.sql');
    runMigrations(db);
    expect(stored('owner_name')).toBe('Alex');
    expect(stored('user_name')).toBeUndefined();
  });

  it('migration 217 keeps owner_name when there is no old key or the old one is blank', () => {
    const db = mockDb.current!;
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('owner_name', 'Sam')").run();
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('user_name', '  ')").run();
    db.prepare('DELETE FROM _migrations WHERE name = ?').run('217_one_owner_name_key.sql');
    runMigrations(db);
    expect(stored('owner_name')).toBe('Sam');
    expect(stored('user_name')).toBeUndefined();
  });
});
