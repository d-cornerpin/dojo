// OLLAMA'S LOADED-MODEL LIMIT. Ollama's scheduler keeps at most
// OLLAMA_MAX_LOADED_MODELS runners (default 3 × GPUs; Apple Silicon is one GPU, so 3) and, at that
// limit, unloads one idle runner (shortest keep-alive first) to load the next. The embedder and the
// Dojo's resident pair are three runners by themselves, so an agent's local model would evict one and
// be evicted back, turn after turn. Where the Dojo itself starts Ollama (setup's "start" step), it
// starts it with room for its own three plus the Ollama lock's agent slots.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
import { runMigrations } from '../../../db/migrations.js';
import { setupDepsRouter } from '../setup-deps.js';
import { getOllamaLock } from '../../../services/ollama-lock.js';

import { upkeepSettled } from '../../../services/ollama-upkeep.js';
import { fakeMac, type Mac, useOllamaHost } from '../../../services/__tests__/fake-mac.js';

// Setup's "start" goes through the one Ollama upkeep (a fake Mac here: nothing real runs). What setup
// installed is started as a kind that LASTS (Homebrew's service, here), never as a child of the Dojo that dies with it, and
// the limit is in launchd's environment, which the service starts with.
let mac: Mac;
const start = async (): Promise<void> => { await setupDepsRouter.request('/deps/install/ollama-start', { method: 'POST' }); await upkeepSettled(); };

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mac = fakeMac({ running: null, formula: '0.41.0' }); useOllamaHost(mac);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Ollama is running', { status: 200 })));
});
afterEach(() => {
  // The lock is one per process, and its loadConfig keeps a cached setting when a later test's DB has no
  // row for it — put it back here, while this test's DB is still open.
  if (mockDb.current) {
    mockDb.current.prepare(`INSERT INTO config (key, value) VALUES ('ollama_max_concurrent_models', '1')
      ON CONFLICT(key) DO UPDATE SET value = '1'`).run();
    getOllamaLock().reloadConfig();
  }
  useOllamaHost(null); vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null;
});

describe('setup starts Ollama with room for the Dojo\'s models', () => {
  it('Homebrew\'s service is started, OLLAMA_MAX_LOADED_MODELS = the embedder + the pair + the lock\'s agent slots (default 1 → 4)', async () => {
    await start();
    expect(mac.running?.by).toBe('brew-service');
    expect(mac.setenvs).toEqual(['OLLAMA_MAX_LOADED_MODELS=4']);
  }, 10_000);

  it('an owner\'s own higher value is never lowered', async () => {
    mac.env.OLLAMA_MAX_LOADED_MODELS = '8';
    await start();
    expect(mac.running?.by).toBe('brew-service');
    expect(mac.setenvs).toEqual([]);
  }, 10_000);

  it('follows the owner\'s Max Concurrent Models setting', async () => {
    mockDb.current!.prepare("INSERT INTO config (key, value) VALUES ('ollama_max_concurrent_models', '2')").run();
    await start();
    expect(mac.setenvs).toEqual(['OLLAMA_MAX_LOADED_MODELS=5']);
  }, 10_000);
});
