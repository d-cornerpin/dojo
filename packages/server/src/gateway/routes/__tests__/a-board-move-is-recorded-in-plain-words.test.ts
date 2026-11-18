// The owner's own move of a card on the board is recorded in plain words, never as a route name.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({ getDb: () => mockDb.current, closeDb: () => undefined }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../config/loader.js', async (orig) => ({
  ...(await orig<typeof import('../../../config/loader.js')>()),
  getJwtSecret: () => 'test-secret',
}));

import { runMigrations } from '../../../db/migrations.js';
import { seedTrackerTask } from '../../../work/__tests__/work-fixture.js';
import { createServer } from '../../server.js';

const app = createServer().app;
const auth = { authorization: `Bearer ${jwt.sign({ userId: 'owner' }, 'test-secret')}`, 'content-type': 'application/json' };

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  seedTrackerTask(mockDb.current, { id: 'task1', agentId: 'a1', status: 'on_deck' });
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a board move is recorded in plain words', () => {
  it('the activity log says "moved on the task board" and names no route', async () => {
    const res = await app.request('/api/tracker/tasks/task1', { method: 'PUT', headers: auth, body: JSON.stringify({ status: 'in_progress' }) });
    expect(res.status).toBe(200);
    const log = await (await app.request('/api/tracker/tasks/task1/log', { headers: auth })).json() as { data: Array<{ actionTaken: string | null; reason: string | null }> };
    expect(log.data.some((e) => `${e.actionTaken ?? ''} ${e.reason ?? ''}`.includes('moved on the task board'))).toBe(true);
    expect(log.data.some((e) => `${e.actionTaken ?? ''} ${e.reason ?? ''}`.includes('PUT'))).toBe(false);
  });
});
