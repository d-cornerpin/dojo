// v3.5 fix round 1 (A3 lead c) — OLLAMA'S LOADED-MODEL LIMIT. Ollama's scheduler keeps at most
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
import { overrideOllamaHost, type OllamaHost } from '../../../services/ollama-host.js';

// Fix W: setup's "start" goes through the host seam (a fake here: no real `ollama serve` is ever started), so the
// Dojo also REMEMBERS the server it started and can restart it with a newer Ollama later.
const started = { envs: [] as Array<Record<string, string>> };
const fakeHost = (): OllamaHost => ({
  getenv: async () => null, setenv: async () => undefined, appPids: async () => [], appInstalled: async () => false,
  terminate: () => undefined, alive: () => false, launchApp: async () => undefined, answers: async () => true, sleep: async () => undefined,
  listener: async () => (started.envs.length > 0 ? { pid: 900, path: '/opt/homebrew/Cellar/ollama/0.40.6/bin/ollama' } : null),
  brewServicePid: async () => null, hasBrew: async () => true, brewCaskToken: async () => 'ollama-app', cliRuns: async () => true, brew: async () => undefined, restartBrewService: async () => undefined,
  startServe: (env) => { started.envs.push(env); return 900; },
});

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  started.envs.length = 0; overrideOllamaHost(fakeHost());
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
  overrideOllamaHost(null); vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null;
});

describe('setup starts Ollama with room for the Dojo\'s models', () => {
  it('OLLAMA_MAX_LOADED_MODELS = the embedder + the pair + the lock\'s agent slots (default 1 → 4)', async () => {
    await setupDepsRouter.request('/deps/install/ollama-start', { method: 'POST' });
    expect(started.envs).toEqual([{ OLLAMA_MAX_LOADED_MODELS: '4' }]);
    // …and the Dojo remembers which program it started, and that the limit is in place on this very server
    const rows = Object.fromEntries((mockDb.current!.prepare("SELECT key, value FROM config WHERE key = 'ollama_own_serve'").all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
    expect(JSON.parse(rows.ollama_own_serve)).toEqual({ pid: 900, exe: '/opt/homebrew/Cellar/ollama/0.40.6/bin/ollama', limit: '4' });
  }, 10_000);

  it('fix round 4 (NB-3): an owner\'s own higher value is never lowered', async () => {
    process.env.OLLAMA_MAX_LOADED_MODELS = '8';
    try {
      await setupDepsRouter.request('/deps/install/ollama-start', { method: 'POST' });
      expect(started.envs).toEqual([{ OLLAMA_MAX_LOADED_MODELS: '8' }]);
    } finally { delete process.env.OLLAMA_MAX_LOADED_MODELS; }
  }, 10_000);

  it('follows the owner\'s Max Concurrent Models setting', async () => {
    mockDb.current!.prepare("INSERT INTO config (key, value) VALUES ('ollama_max_concurrent_models', '2')").run();
    await setupDepsRouter.request('/deps/install/ollama-start', { method: 'POST' });
    expect(started.envs).toEqual([{ OLLAMA_MAX_LOADED_MODELS: '5' }]);
  }, 10_000);
});
