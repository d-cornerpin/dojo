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
const put = (body: Record<string, unknown>) => app.request('/api/tracker/tasks/t1', { method: 'PUT', headers: auth, body: JSON.stringify(body) });
const assignee = (): string | null => (mockDb.current!.prepare("SELECT assignee_agent FROM work WHERE id = 't1'").get() as { assignee_agent: string | null }).assignee_agent;
const ENDED = 'That agent has ended, so it cannot take a task. Pick a live agent.';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  const add = mockDb.current.prepare('INSERT INTO agents (id, name, status) VALUES (?, ?, ?)');
  add.run('a1', 'Agent One', 'idle');
  add.run('a2', 'Gone Agent', 'terminated');
  add.run('a3', 'Agent Three', 'idle');
  seedTrackerTask(mockDb.current, { id: 't1', agentId: 'a1', status: 'on_deck' });
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

it('a task cannot be moved to an ended agent', async () => {
  const res = await put({ assignedTo: 'a2' });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe(ENDED);
  expect(assignee()).toBe('a1');
});

it('a new task cannot be made for an ended agent', async () => {
  const res = await app.request('/api/tracker/tasks', { method: 'POST', headers: auth, body: JSON.stringify({ title: 'Never made', assignedTo: 'a2' }) });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe(ENDED);
  expect(mockDb.current!.prepare("SELECT COUNT(*) AS n FROM work WHERE title = 'Never made'").get()).toEqual({ n: 0 });
});

it('CONTROL: a live agent can still be given the task', async () => {
  const res = await put({ assignedTo: 'a3' });
  expect(res.status).toBe(200);
  expect(assignee()).toBe('a3');
});
