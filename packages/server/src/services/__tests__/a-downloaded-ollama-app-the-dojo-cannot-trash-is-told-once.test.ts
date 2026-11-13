// When Finder will not move the downloaded Ollama app to the Trash, the owner hears one notice in the `ollama` key,
// a later start tells nothing new, and Ollama keeps serving. `fake-mac.ts` plays the Mac; nothing real runs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
const frames = vi.hoisted(() => ({ list: [] as Array<{ type?: string; error?: string }> }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: (f: { error?: string }) => { frames.list.push(f); }, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { upkeep, upkeepSettled } from '../ollama-upkeep.js';
import { OLLAMA_APP_LEFT_WORDS } from '../../healer/local-model-notice-words.js';
import { ollama, startFakeOllama, stopFakeOllama, fakeMac, serviceServe, LATEST, useOllamaHost } from './fake-mac.js';

beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  const baseUrl = await startFakeOllama();
  ollama.silent = new Set(); ollama.pulls = []; ollama.installed = new Set(['nomic-embed-text:latest']); ollama.failPulls = false; ollama.refuseAllBelow035 = false;
  mockDb.current.prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', ?, 'none', 1)").run(baseUrl);
  frames.list.length = 0;
});
afterEach(async () => { await upkeepSettled(); useOllamaHost(null); await stopFakeOllama(); mockDb.current?.close(); mockDb.current = null; });

describe('a downloaded Ollama app the Dojo cannot trash is told once', () => {
  it('one notice at the first start, none at the next, and Ollama keeps serving', async () => {
    const mac = fakeMac({ running: serviceServe(LATEST), formula: LATEST, app: '0.30.1', appCask: null });
    mac.failTrash = true;
    useOllamaHost(mac);
    expect((await upkeep('boot')).ok).toBe(true);
    await upkeep('boot');
    expect(frames.list.filter((f) => f.error === OLLAMA_APP_LEFT_WORDS)).toHaveLength(1);
    expect(mac.disk.app).toBe('0.30.1');
    expect(ollama.serving?.version).toBe(LATEST);
  });
});
