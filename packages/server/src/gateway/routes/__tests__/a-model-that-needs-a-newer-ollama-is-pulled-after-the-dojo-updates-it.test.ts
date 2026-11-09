// THE SETUP SCREEN'S OWN PULL: a model the owner pulls (an agent's model) that the registry refuses as needing a newer
// Ollama. The one upkeep makes Ollama newer, then the model is pulled again; no text tells him to download or restart anything. `fake-mac.ts` plays the Mac; the route's fixed localhost address is
// pointed at the fake Ollama, so the real Ollama on this machine is never reached.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
const frames = vi.hoisted(() => ({ list: [] as Array<{ type?: string; error?: string; severity?: string }> }));
vi.mock('../../ws.js', () => ({ broadcast: (f: { error?: string }) => { frames.list.push(f); }, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { setupDepsRouter } from '../setup-deps.js';

import { upkeepSettled } from '../../../services/ollama-upkeep.js';
import { ollama, startFakeOllama, stopFakeOllama, fakeMac, formulaServe, LATEST, type Mac, useOllamaHost } from '../../../services/__tests__/fake-mac.js';

const MODEL = 'agent-model:7b';
const NO_CHORES = /download|ollama\.com|quit|start it again|restart it|brew upgrade/i;
const liveCards = (): string[] => frames.list.filter((f) => f.type === 'chat:error' && f.severity !== 'info').map((f) => f.error ?? '');
const pull = async (): Promise<{ ok: boolean; error?: string }> =>
  (await setupDepsRouter.request('/ollama/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL }) })).json() as Promise<{ ok: boolean; error?: string }>;
let mac: Mac;

beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  const baseUrl = await startFakeOllama();
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (u: string | URL | Request, init?: RequestInit) => realFetch(String(u instanceof Request ? u.url : u).replace('http://localhost:11434', baseUrl), init));
  ollama.silent = new Set(); ollama.pulls = []; ollama.installed = new Set(['nomic-embed-text:latest']); ollama.refuseAllBelow035 = true;
  frames.list.length = 0;
});
afterEach(async () => {
  await upkeepSettled();
  useOllamaHost(null); vi.unstubAllGlobals();
  await stopFakeOllama();
  mockDb.current?.close(); mockDb.current = null;
});

describe('setup\'s pull of a model that needs a newer Ollama', () => {
  it('the Dojo makes Ollama current (the same upkeep as Repair), then pulls it: no card, no chore', async () => {
    mac = fakeMac({ running: formulaServe('0.30.1'), formula: '0.30.1' }); useOllamaHost(mac);
    const r = await pull();
    expect(r.ok).toBe(true);
    expect(ollama.pulls).toEqual([MODEL, MODEL]);   // refused once, pulled after the update
    expect(ollama.serving?.version).toBe(LATEST);
    expect(mac.running?.by).toBe('brew-service');
    expect(liveCards()).toEqual([]);
  });

  it('an Ollama the Dojo truly cannot update: the plain reason on the screen, ONE card, and neither asks for a chore', async () => {
    mac = fakeMac({ running: formulaServe('0.30.1', { foreign: true }), formula: '0.30.1' }); useOllamaHost(mac);
    const r = await pull();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('it runs as another user or as the system');
    expect(r.error).not.toMatch(NO_CHORES);
    expect(liveCards().length).toBe(1);
    expect(liveCards()[0]).not.toMatch(NO_CHORES);
    expect(ollama.pulls).toEqual([MODEL]);   // not pulled again into the same refusal
  });
});
