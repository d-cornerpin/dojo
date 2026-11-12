// A settled takeover holds only while the limit it settled at is at least the one wanted: when the
// owner raises the agent slots, the Dojo's own fallback serve is restarted once with the higher limit;
// another user's Ollama, which the Dojo cannot stop, stays settled. `fake-mac.ts` plays the Mac.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { upkeep, upkeepSettled } from '../ollama-upkeep.js';
import { ollama, startFakeOllama, stopFakeOllama, fakeMac, formulaServe, LATEST, useOllamaHost } from './fake-mac.js';

const db = (): Database.Database => mockDb.current!;
const raiseSlots = (n: number): void => { db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('ollama_max_concurrent_models', ?)").run(String(n)); };

beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  const baseUrl = await startFakeOllama();
  ollama.serving = null; ollama.silent = new Set(); ollama.installed = new Set(['nomic-embed-text:latest']); ollama.pulls = [];
  ollama.refuseAllBelow035 = false; ollama.failPulls = false;
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', ?, 'none', 1)").run(baseUrl);
});
afterEach(async () => {
  await upkeepSettled();
  useOllamaHost(null);
  await stopFakeOllama();
  mockDb.current?.close(); mockDb.current = null;
});

describe('a settled Ollama gets the raised limit', () => {
  it("the Dojo's fallback serve is restarted once with the higher limit, then left alone", async () => {
    const mac = fakeMac({ running: formulaServe('0.30.1'), formula: '0.30.1' }); mac.serviceWorks = false;
    useOllamaHost(mac);
    await upkeep('repair'); await upkeepSettled();
    expect(mac.running?.by).toBe('unsupervised');
    const firstLimit = Number(mac.serves.at(-1)?.OLLAMA_MAX_LOADED_MODELS);
    const termsBefore = mac.terms.length;

    raiseSlots(6);
    await upkeep('boot'); await upkeepSettled();
    expect(mac.terms.length).toBe(termsBefore + 1);
    expect(Number(mac.serves.at(-1)?.OLLAMA_MAX_LOADED_MODELS)).toBeGreaterThan(firstLimit);

    await upkeep('boot'); await upkeepSettled();
    expect(mac.terms.length).toBe(termsBefore + 1);
  });

  it("another user's Ollama stays settled when the slots are raised: never signalled again", async () => {
    const mac = fakeMac({ running: formulaServe(LATEST, { foreign: true }), formula: LATEST });
    useOllamaHost(mac);
    await upkeep('boot'); await upkeepSettled();
    expect(mac.terms).toEqual([500]);
    raiseSlots(6);
    await upkeep('boot'); await upkeepSettled();
    expect(mac.terms).toEqual([500]);
  });
});
