// A task the owner makes on the dashboard reaches its agent at once; a scheduled one waits for its fire time.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({ getDb: () => mockDb.current, closeDb: () => undefined }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => undefined }) }));
vi.mock('../../../config/loader.js', async (orig) => ({
  ...(await orig<typeof import('../../../config/loader.js')>()),
  getJwtSecret: () => 'test-secret',
}));

import { runMigrations } from '../../../db/migrations.js';
import { createServer } from '../../server.js';

const app = createServer().app;
const auth = { authorization: `Bearer ${jwt.sign({ userId: 'owner' }, 'test-secret')}`, 'content-type': 'application/json' };
const make = (body: object) => app.request('/api/tracker/tasks', { method: 'POST', headers: auth, body: JSON.stringify(body) });
const hints = (): number =>
  (mockDb.current!.prepare("SELECT COUNT(*) AS n FROM messages WHERE agent_id = 'a1' AND content LIKE '%Water the plants%'").get() as { n: number }).n;

describe('a task made on the dashboard reaches its agent at once', () => {
  beforeEach(() => {
    mockDb.current = new Database(':memory:');
    runMigrations(mockDb.current);
    mockDb.current.prepare("INSERT INTO agents (id, name, model_id, status, config) VALUES ('a1', 'Worker', NULL, 'idle', '{}')").run();
  });
  afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

  it('leaves one engine hint for its agent naming the task', async () => {
    expect((await make({ title: 'Water the plants', assignedTo: 'a1' })).status).toBe(201);
    await vi.waitFor(() => expect(hints()).toBe(1));
  });

  it('sends nothing for a scheduled task', async () => {
    expect((await make({ title: 'Water the plants', assignedTo: 'a1', scheduled_start: '2099-01-01T09:00:00.000Z' })).status).toBe(201);
    await new Promise((r) => setTimeout(r, 0));
    expect(hints()).toBe(0);
  });
});
