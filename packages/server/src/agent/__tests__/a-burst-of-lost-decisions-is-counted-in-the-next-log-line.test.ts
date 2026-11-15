// Lost decisions are logged once per failure class per minute; the next line says how many were left unlogged.
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
const logged = vi.hoisted(() => [] as Array<Record<string, unknown> | undefined>);
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: () => {}, error: () => {}, debug: () => {}, warn: (_m: string, meta?: Record<string, unknown>) => { logged.push(meta); } }),
}));

import { runMigrations } from '../../db/migrations.js';
import { decide } from '../decide.js';
import { installDecisionModel } from './decision-fake.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:'); runMigrations(mockDb.current); installDecisionModel(mockDb.current);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

it('a burst of lost decisions logs one line, and the next minute\'s line carries the count left out', async () => {
  const ask = () => decide('text', { q: { type: 'noul', instructions: 'Is it?' } }, { purpose: 'burst' });
  const now = vi.spyOn(Date, 'now');
  now.mockReturnValue(1_000_000);
  await ask(); await ask(); await ask();
  expect(logged).toHaveLength(1);
  expect(logged[0]?.suppressed).toBeUndefined();
  now.mockReturnValue(1_000_000 + 61_000);
  await ask();
  expect(logged).toHaveLength(2);
  expect(logged[1]?.suppressed).toBe(2);
});
