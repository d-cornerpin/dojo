// Restoring a version rewrites TECHNIQUE.md and bumps the version exactly like an
// instructions update does — so it must tell the dashboard too. Without the
// broadcast every open tab keeps showing the pre-restore text and version number.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
const broadcast = vi.fn();
vi.mock('../../gateway/ws.js', () => ({ broadcast: (m: unknown) => broadcast(m) }));

import { runMigrations } from '../../db/migrations.js';
import { createTechnique, updateTechniqueInstructions } from '../store.js';
import { getVersions, restoreVersion } from '../versioning.js';

beforeEach(() => {
  broadcast.mockClear();
  mockDb.current = new Database(':memory:');
  runMigrations();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('restoreVersion tells the dashboard', () => {
  it('broadcasts technique:updated with the new version after a restore', () => {
    const created = createTechnique({
      name: 'fake-restore-demo',
      displayName: 'Fake Restore Demo',
      description: 'fake technique for the restore-broadcast test',
      instructions: '# v1\nfake instructions before the edit',
    });
    updateTechniqueInstructions(created.id, '# v2\nfake edited instructions', 'fake edit');

    const v1 = getVersions(created.id).find(v => v.versionNumber === 1)!;
    expect(restoreVersion(created.id, v1.id)).toBe(true);

    expect(broadcast).toHaveBeenCalledWith({
      type: 'technique:updated',
      data: { id: created.id, name: 'Fake Restore Demo', version: 3 },
    });
  });
});
