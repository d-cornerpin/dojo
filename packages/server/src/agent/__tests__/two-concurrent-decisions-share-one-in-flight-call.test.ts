// The local Ollama answers one request at a time, so two decisions asked together share the one call slot: the second
// is sent only when the first has settled, and its clock starts then. The decision model is a scripted fetch.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { decide, type Question } from '../decide.js';
import { installDecisionModel } from './decision-fake.js';

const Q: Record<string, Question> = { q: { type: 'noul', instructions: 'q?' } };

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(mockDb.current); installDecisionModel(mockDb.current); });
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('two concurrent decisions', () => {
  it('the second is sent only after the first is answered, and both are answered', async () => {
    const events: string[] = [];
    const answer: Array<() => void> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { body?: string }) => {
      const which = (JSON.parse(init?.body ?? '{}') as { state: { which: string } }).state.which;
      events.push(`sent ${which.includes('first') ? 'first' : 'second'}`);
      await new Promise<void>((r) => answer.push(r));
      return Response.json({ answers: { q: { noul: 0.9 } } });
    }));
    const first = decide({ which: 'first' }, Q, { purpose: 'probe' });
    const second = decide({ which: 'second' }, Q, { purpose: 'probe' });
    await vi.waitFor(() => expect(events).toEqual(['sent first']));
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual(['sent first']);
    answer.shift()!();
    expect(await first).toEqual({ q: { type: 'noul', noul: 0.9 } });
    await vi.waitFor(() => expect(events).toEqual(['sent first', 'sent second']));
    answer.shift()!();
    expect(await second).toEqual({ q: { type: 'noul', noul: 0.9 } });
  });
});
