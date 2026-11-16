// A migration import swaps in a 3.4.1 database that has never seen the owner-star conversion. The Dojo
// restarts after the import, and that boot runs it, so the owner exists straight away and the main agent can text him.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));

import { runMigrations } from '../../db/migrations.js';
import { parseSafeSenders } from '../../services/safe-senders.js';
import { starTheOwnersAtBoot } from '../../services/owner-star-upgrade.js';

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(); });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the boot after a migration import', () => {
  it('stars the owner a 3.4.1 list implied', async () => {
    const list = [{ address: '+15550001', name: 'A', sharing_level: 'dont_overshare' }, { address: '+15550002', name: 'B', sharing_level: 'dont_overshare' }];
    mockDb.current!.prepare("INSERT INTO config (key, value) VALUES ('imessage_approved_senders', ?)").run(JSON.stringify(list));
    mockDb.current!.prepare("INSERT INTO config (key, value) VALUES ('imessage_default_sender', '+15550002')").run();
    await starTheOwnersAtBoot();
    const stored = (mockDb.current!.prepare("SELECT value FROM config WHERE key = 'imessage_approved_senders'").get() as { value: string }).value;
    expect(parseSafeSenders(stored).find((s) => s.is_primary)?.address).toBe('+15550002');
    expect(JSON.parse(stored).filter((s: { is_primary?: boolean }) => s.is_primary)).toHaveLength(1);   // written down, not just inferred
  });
});
