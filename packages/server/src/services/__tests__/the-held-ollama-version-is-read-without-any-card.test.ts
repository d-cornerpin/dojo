// The version the Dojo could not update is stored once, and a health check reads it, not whether the owner was told: with
// every card record gone, the held version still keeps a health check from trying again until Ollama's version changes.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { overrideOllamaHost } from '../ollama-host.js';
import { heldOllamaVersion } from '../ollama-version.js';
import { upkeep, upkeepSettled, upkeepWhenIncomplete } from '../ollama-upkeep.js';
import { ollama, startFakeOllama, stopFakeOllama, fakeMac, formulaServe, LATEST, type Mac } from './fake-mac.js';

const db = (): Database.Database => mockDb.current!;
let baseUrl = '';
let mac: Mac;
beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  baseUrl = await startFakeOllama();
  ollama.silent = new Set(); ollama.pulls = []; ollama.installed = new Set(['nomic-embed-text:latest']); ollama.failPulls = false; ollama.refuseAllBelow035 = false;
  db().prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', ?, 'none', 1)").run(baseUrl);
  mac = fakeMac({ running: formulaServe('0.30.1', { foreign: true }), formula: '0.30.1' });
  overrideOllamaHost(mac);
});
afterEach(async () => {
  await upkeepSettled();
  overrideOllamaHost(null);
  await stopFakeOllama();
  mockDb.current?.close(); mockDb.current = null;
});

const health = async (): Promise<void> => { upkeepWhenIncomplete([...ollama.installed], baseUrl); await upkeepSettled(); };

describe('the held Ollama version', () => {
  it('is stored at the run that could not update it, and a health check reads it with no card record left', async () => {
    await upkeep('boot');
    expect(heldOllamaVersion()).toBe('0.30.1');
    db().prepare("DELETE FROM healer_state WHERE scope IN ('owner_told', 'owner_dismissed')").run();
    const signals = mac.terms.length;
    await health(); await health();
    expect(mac.terms.length).toBe(signals);   // not tried again
    mac.running = formulaServe(LATEST, { foreign: true });   // another user restarted it on a new version
    await health();
    expect(heldOllamaVersion()).toBeNull();
    expect(ollama.pulls).toContain('tev1:4b-q4_K_M');
  });
});
