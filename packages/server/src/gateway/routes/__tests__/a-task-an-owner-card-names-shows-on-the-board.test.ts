// The Dojo's own tasks stay off the board, except one that a standing owner card names.

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
vi.mock('../../../config/platform.js', async (orig) => ({
  ...(await orig<typeof import('../../../config/platform.js')>()),
  getDashboardHiddenAgentIds: () => new Set(['pm']),
}));

import { runMigrations } from '../../../db/migrations.js';
import { seedTrackerTask } from '../../../work/__tests__/work-fixture.js';
import { createServer } from '../../server.js';

const app = createServer().app;
const auth = { authorization: `Bearer ${jwt.sign({ userId: 'owner' }, 'test-secret')}` };
const listed = async (): Promise<string[]> =>
  ((await (await app.request('/api/tracker/tasks', { headers: auth })).json()).data as Array<{ id: string }>).map((t) => t.id);
const card = (scope: string) =>
  mockDb.current!.prepare("INSERT INTO healer_state (scope, key, at_ms, value) VALUES (?, 'stall:t1', 0, 'stuck')").run(scope);

describe('a task an owner card names shows on the board', () => {
  beforeEach(() => {
    mockDb.current = new Database(':memory:');
    runMigrations(mockDb.current);
    seedTrackerTask(mockDb.current, { id: 't1', agentId: 'pm', status: 'in_progress' });
  });
  afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

  it('stays hidden with no card', async () => {
    expect(await listed()).not.toContain('t1');
  });

  it('shows while its card stands', async () => {
    card('owner_told');
    expect(await listed()).toContain('t1');
  });

  it('hides again once he dismisses the card', async () => {
    card('owner_told');
    card('owner_dismissed');
    expect(await listed()).not.toContain('t1');
  });
});
