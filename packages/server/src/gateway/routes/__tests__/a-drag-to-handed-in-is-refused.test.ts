// A card dragged on the board never writes a hand-in state: Handed in is the worker's, with proof, and
// Sent back is the owner's decision with a reason, which has its own door.

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
const move = (status: string) => app.request('/api/tracker/tasks/t1', { method: 'PUT', headers: auth, body: JSON.stringify({ status }) });
const state = (): string => (mockDb.current!.prepare("SELECT state FROM work WHERE id = 't1'").get() as { state: string }).state;

describe('a drag to Handed in is refused', () => {
  beforeEach(() => {
    mockDb.current = new Database(':memory:');
    runMigrations(mockDb.current);
    seedTrackerTask(mockDb.current, { id: 't1', agentId: 'a1', status: 'in_progress' });
  });
  afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

  it('refuses Handed in with a plain reason and leaves the task where it was', async () => {
    const res = await move('handed_in');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('Only the agent working on a task hands it in, with its proof.');
    expect(state()).toBe('claimed');
  });

  it('refuses a raw Sent back on a handed-in card too: that is a decision with a reason', async () => {
    mockDb.current!.prepare("UPDATE work SET state = 'handed_in' WHERE id = 't1'").run();
    const res = await move('sent_back');
    expect(res.status).toBe(409);
    expect(state()).toBe('handed_in');
  });
});
