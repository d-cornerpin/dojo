// v3.5 fix round 3 — ORCHESTRATOR RULING: `launchctl setenv` is lost on a Mac reboot, so the Dojo re-applies
// Ollama's model limit at EVERY start (the same idempotent routine), not only on the first boot of a
// version. The routine itself is stubbed: no real command runs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
const limit = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../ollama-model-limit.js', () => ({ ensureOllamaModelLimit: async () => { limit.calls++; return 'already'; } }));
vi.mock('../../gateway/routes/update.js', () => ({ getCurrentVersion: () => '3.5.0' }));

import { runMigrations } from '../../db/migrations.js';
import { ensureStandardModelsAtBoot } from '../local-standard.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  limit.calls = 0;
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no Ollama in this test'); }));
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('every Dojo start', () => {
  it('re-applies the limit, also when this version was already stamped and on a box with no Ollama set up', async () => {
    mockDb.current!.prepare("INSERT INTO config (key, value) VALUES ('standard_models_version', '3.5.0')").run();
    await ensureStandardModelsAtBoot();
    await ensureStandardModelsAtBoot();
    expect(limit.calls).toBe(2);
  });
});
