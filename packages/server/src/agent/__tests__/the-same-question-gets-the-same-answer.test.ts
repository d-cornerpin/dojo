// The same question about the same text is the same request, byte for byte: each text's fence code is derived from the
// text, so the decision model (which answers identical requests identically) gives the same answer every time.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { decide } from '../decide.js';
import { installDecisionModel, scriptDecisions, yes } from './decision-fake.js';

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(mockDb.current); installDecisionModel(mockDb.current); });
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('a decision request is repeatable', () => {
  it('asking twice about the same text sends the same state; another text gets its own fence', async () => {
    const calls = scriptDecisions(() => yes(0.5));
    const asked = { q: { type: 'noul' as const, instructions: 'Is `message` a greeting?' } };
    await decide({ message: 'hello there' }, asked, { purpose: 'probe' });
    await decide({ message: 'hello there' }, asked, { purpose: 'probe' });
    await decide({ message: 'goodbye' }, asked, { purpose: 'probe' });
    const [a, b, c] = calls.map((x) => JSON.stringify(x.state));
    expect(a).toBe(b);
    expect(c.match(/code ([0-9a-f]{8})/)?.[1]).not.toBe(a.match(/code ([0-9a-f]{8})/)?.[1]);
  });
});
