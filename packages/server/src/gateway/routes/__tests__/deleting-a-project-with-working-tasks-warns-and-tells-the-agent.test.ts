// Deleting a project whose tasks are being worked on is a hurdle, never a block: the first try names the
// working tasks and deletes nothing; going on deletes it and tells each working agent.

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
import { seedTrackerTask, seedTrackerProject } from '../../../work/__tests__/work-fixture.js';
import { createServer } from '../../server.js';

const app = createServer().app;
const auth = { authorization: `Bearer ${jwt.sign({ userId: 'owner' }, 'test-secret')}` };
const del = (query = '') => app.request(`/api/tracker/projects/p1${query}`, { method: 'DELETE', headers: auth });
const count = (sql: string): number => (mockDb.current!.prepare(sql).get() as { n: number }).n;

describe('deleting a project with working tasks', () => {
  beforeEach(() => {
    mockDb.current = new Database(':memory:');
    runMigrations(mockDb.current);
    mockDb.current.prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES ('a1', 'Worker', NULL, 'idle', '{}')").run();
    seedTrackerProject(mockDb.current, { id: 'p1', title: 'Garden' });
    seedTrackerTask(mockDb.current, { id: 't1', title: 'Dig the beds', agentId: 'a1', status: 'in_progress', projectId: 'p1' });
    seedTrackerTask(mockDb.current, { id: 't2', title: 'Buy seeds', agentId: 'a1', status: 'on_deck', projectId: 'p1' });
  });
  afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

  it('warns first, naming the working task, and deletes nothing', async () => {
    const res = await del();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('Dig the beds');
    expect(body.error).not.toContain('Buy seeds');
    expect(count("SELECT COUNT(*) AS n FROM work WHERE id IN ('p1', 't1', 't2')")).toBe(3);
  });

  it('deletes when he goes on, and tells the working agent', async () => {
    const res = await del('?anyway=1');
    expect(res.status).toBe(200);
    expect(count("SELECT COUNT(*) AS n FROM work WHERE id IN ('p1', 't1', 't2')")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE agent_id = 'a1' AND content LIKE '%Dig the beds%'")).toBe(1);
  });
});
