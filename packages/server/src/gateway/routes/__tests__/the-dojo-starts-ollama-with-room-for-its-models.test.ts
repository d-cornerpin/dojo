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
const spawned = vi.hoisted(() => ({ calls: [] as Array<{ cmd: string; env?: Record<string, string | undefined> }> }));
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  exec: (cmd: string, opts: { env?: Record<string, string | undefined> }) => { spawned.calls.push({ cmd, env: opts?.env }); return { unref: () => {} }; },
}));

import { runMigrations } from '../../../db/migrations.js';
import { setupDepsRouter } from '../setup-deps.js';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  spawned.calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Ollama is running', { status: 200 })));
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('setup starts Ollama with room for the Dojo\'s models', () => {
  it('OLLAMA_MAX_LOADED_MODELS = the embedder + the pair + the lock\'s agent slots (default 1 → 4)', async () => {
    await setupDepsRouter.request('/deps/install/ollama-start', { method: 'POST' });
    const serve = spawned.calls.find((c) => c.cmd === 'ollama serve');
    expect(serve?.env?.OLLAMA_MAX_LOADED_MODELS).toBe('4');
  }, 10_000);

  it('fix round 4 (NB-3): an owner\'s own higher value is never lowered', async () => {
    process.env.OLLAMA_MAX_LOADED_MODELS = '8';
    try {
      await setupDepsRouter.request('/deps/install/ollama-start', { method: 'POST' });
      expect(spawned.calls.find((c) => c.cmd === 'ollama serve')?.env?.OLLAMA_MAX_LOADED_MODELS).toBe('8');
    } finally { delete process.env.OLLAMA_MAX_LOADED_MODELS; }
  }, 10_000);

  it('follows the owner\'s Max Concurrent Models setting', async () => {
    mockDb.current!.prepare("INSERT INTO config (key, value) VALUES ('ollama_max_concurrent_models', '2')").run();
    await setupDepsRouter.request('/deps/install/ollama-start', { method: 'POST' });
    expect(spawned.calls.find((c) => c.cmd === 'ollama serve')?.env?.OLLAMA_MAX_LOADED_MODELS).toBe('5');
  }, 10_000);
});
