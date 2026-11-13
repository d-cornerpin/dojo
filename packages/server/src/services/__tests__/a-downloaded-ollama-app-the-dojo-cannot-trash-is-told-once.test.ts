// When the Dojo cannot retire the downloaded Ollama app, the owner hears one notice in the `ollama` key naming the step
// that failed, the app is tried again only at the next start, and Ollama keeps serving. `fake-mac.ts` plays the Mac.
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
import { ollamaAppLeftWords } from '../../healer/local-model-notice-words.js';
import { ownerToldOf } from '../../healer/owner-notices.js';
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
  const told = (words: string): number => frames.list.filter((f) => f.error === words).length;
  const attempts = (mac: { log: string[] }): number => mac.log.filter((l) => l === 'trash').length;

  it('one notice naming the Trash, one attempt across two passes of a start, one more at the next start', async () => {
    const mac = fakeMac({ running: serviceServe(LATEST), formula: LATEST, app: '0.30.1', appCask: null });
    mac.failTrash = true;
    useOllamaHost(mac);
    expect((await upkeep('boot')).ok).toBe(true);
    await upkeep('repair');
    expect(attempts(mac)).toBe(1);
    expect(told(ollamaAppLeftWords('trash'))).toBe(1);
    expect(ownerToldOf('ollama'), 'the notice stands after the second pass').toBe(true);
    await upkeep('boot');
    expect(attempts(mac)).toBe(2);
    expect(told(ollamaAppLeftWords('trash'))).toBe(1);
    expect(mac.disk.app).toBe('0.30.1');
    expect(ollama.serving?.version).toBe(LATEST);
  });

  it('a re-link that fails is told as the re-link, and the app is not trashed', async () => {
    const mac = fakeMac({ running: serviceServe(LATEST), formula: LATEST, app: '0.30.1', appCask: null });
    useOllamaHost(mac);
    mac.failBrew = true;
    await upkeep('boot');
    expect(told(ollamaAppLeftWords('link'))).toBe(1);
    expect(told(ollamaAppLeftWords('trash'))).toBe(0);
    expect(mac.disk.app).toBe('0.30.1');
  });
});
