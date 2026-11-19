// A presence change comes from the owner's toggle or from his agent on his ask; an open dashboard must
// switch with it, so the one writer of presence announces the new status.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-presence-broadcast', 'dojo.db'),
  };
});
const frames: Array<Record<string, unknown>> = [];
vi.mock('../../gateway/ws.js', () => ({ broadcast: (e: Record<string, unknown>) => { frames.push(e); }, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { getPresence, setPresence } from '../presence.js';

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  frames.length = 0;
});

describe('a presence change reaches an open dashboard', () => {
  it('setting away sends the new status', () => {
    setPresence('away');
    expect(getPresence()).toBe('away');
    expect(frames).toContainEqual({ type: 'presence:changed', status: 'away' });
  });
  it('setting in the dojo sends that too', () => {
    setPresence('in_dojo');
    expect(frames).toContainEqual({ type: 'presence:changed', status: 'in_dojo' });
  });
});
