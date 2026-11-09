// Setup, a Dojo start, Repair and a health check that finds the pair incomplete all run the one Ollama upkeep: on the same
// box each door runs the same commands, in the same order. `fake-mac.ts` plays the Mac; nothing real runs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';

import { upkeep, upkeepSettled } from '../ollama-upkeep.js';
import { checkOllamaHealth } from '../ollama.js';
import { setupDepsRouter } from '../../gateway/routes/setup-deps.js';
import { ollama, startFakeOllama, stopFakeOllama, fakeMac, formulaServe, LATEST, type Mac, useOllamaHost } from './fake-mac.js';

let baseUrl = '';
beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  baseUrl = await startFakeOllama();
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (u: string | URL | Request, init?: RequestInit) => realFetch(String(u instanceof Request ? u.url : u).replace('http://localhost:11434', baseUrl), init));
  ollama.silent = new Set(); ollama.pulls = []; ollama.installed = new Set(['nomic-embed-text:latest']); ollama.refuseAllBelow035 = false; ollama.failPulls = false;
  mockDb.current.prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', ?, 'none', 1)").run(baseUrl);
});
afterEach(async () => {
  await upkeepSettled();
  useOllamaHost(null); vi.unstubAllGlobals();
  await stopFakeOllama();
  mockDb.current?.close(); mockDb.current = null;
});

/** An old formula serve nothing supervises; what the door made the Mac do, once the upkeep it started has ended. */
async function through(door: () => Promise<unknown>): Promise<Mac> {
  const mac = fakeMac({ running: formulaServe('0.30.1'), formula: '0.30.1' });
  useOllamaHost(mac);
  await door();
  await upkeepSettled();
  return mac;
}

const DOORS: Record<string, () => Promise<unknown>> = {
  setup: () => setupDepsRouter.request('/deps/install/ollama-start', { method: 'POST' }),
  start: () => upkeep('boot'),
  repair: () => setupDepsRouter.request('/ollama/standard', { method: 'POST' }),
  'health check': () => checkOllamaHealth(baseUrl),
};

describe('every door runs the one Ollama upkeep', () => {
  it('each door updates, restarts and installs the same way, and the Mac ends the same', async () => {
    const seen: Record<string, unknown> = {};
    for (const [name, door] of Object.entries(DOORS)) {
      ollama.installed = new Set(['nomic-embed-text:latest']); ollama.pulls = [];
      mockDb.current!.prepare("DELETE FROM config WHERE key = 'ollama_upkeep'").run();   // each door on a fresh box
      const mac = await through(door);
      seen[name] = { brews: mac.brews, log: mac.log, by: mac.running?.by, version: ollama.serving?.version, pulls: [...ollama.pulls].sort() };
    }
    const first = seen.start as { by: string; version: string; pulls: string[]; log: string[] };
    expect(first.by).toBe('brew-service');
    expect(first.version).toBe(LATEST);
    expect(first.pulls).toHaveLength(2);
    expect(first.log).toEqual(['setenv', 'term', 'service']);
    for (const name of Object.keys(DOORS)) expect(seen[name], name).toEqual(first);
  }, 30_000);
});
