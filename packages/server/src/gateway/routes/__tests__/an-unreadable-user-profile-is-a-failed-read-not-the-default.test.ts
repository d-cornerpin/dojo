// USER.md that exists but cannot be read is a FAILED read at the dashboard door: the card gets an error (and
// its Retry), never the shipped default, and a save cannot land over the real file.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));
vi.mock('../../ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { configRouter } from '../config.js';
import { userProfilePath, writeUserProfile } from '../../../prompt/user-profile.js';

const req = (method: string, body?: unknown) => configRouter.request('/identity/USER.md', {
  method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  writeUserProfile('REAL PROFILE', 'dashboard');
});
afterEach(() => {
  try { fs.chmodSync(userProfilePath(), 0o600); } catch { /* gone */ }
  mockDb.current?.close();
  mockDb.current = null;
});

describe('the USER.md door', () => {
  it('reads the file', async () => {
    const res = await req('GET');
    expect(((await res.json()) as { data: { content: string } }).data.content).toBe('REAL PROFILE');
  });
  it('GET is a 500 when the file exists but cannot be read - not the shipped default', async () => {
    fs.chmodSync(userProfilePath(), 0o000);
    const res = await req('GET');
    expect(res.status).toBe(500);
  });
  it('PUT is a 500 and writes nothing when the file cannot be read', async () => {
    fs.chmodSync(userProfilePath(), 0o000);
    const res = await req('PUT', { content: 'overwrite', base: 'whatever' });
    expect(res.status).toBe(500);
    fs.chmodSync(userProfilePath(), 0o600);
    expect(fs.readFileSync(userProfilePath(), 'utf-8')).toBe('REAL PROFILE');
  });
});
