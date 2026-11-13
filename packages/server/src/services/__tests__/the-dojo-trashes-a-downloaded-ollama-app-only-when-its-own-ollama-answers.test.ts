// An Ollama app Homebrew does not own (the one from ollama.com) is quit, moved to the Trash by Finder and the
// command re-linked to Homebrew's, but only while Homebrew's own Ollama answers on the Dojo's port. `fake-mac.ts`
// plays the Mac; nothing real runs.
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
import { makeRealDeps } from '../ollama-host.js';
import { ollama, startFakeOllama, stopFakeOllama, fakeMac, appServe, serviceServe, LATEST, type Mac, useOllamaHost } from './fake-mac.js';

beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  const baseUrl = await startFakeOllama();
  ollama.silent = new Set(); ollama.pulls = []; ollama.installed = new Set(['nomic-embed-text:latest']); ollama.failPulls = false; ollama.refuseAllBelow035 = false;
  mockDb.current.prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', ?, 'none', 1)").run(baseUrl);
});
afterEach(async () => { await upkeepSettled(); useOllamaHost(null); await stopFakeOllama(); mockDb.current?.close(); mockDb.current = null; });

const boot = async (mac: Mac): Promise<Mac> => { useOllamaHost(mac); await upkeep('boot'); return mac; };
const trashed = (mac: Mac): number => mac.log.filter((l) => l === 'trash').length;
const linked = (mac: Mac): boolean => mac.brews.some((a) => a.join(' ') === 'link --overwrite ollama');

describe('the Dojo trashes a downloaded Ollama app only when its own Ollama answers', () => {
  it("Homebrew's service answers and the app is not Homebrew's: the app goes to the Trash and the command is re-linked", async () => {
    const mac = await boot(fakeMac({ running: serviceServe(LATEST), formula: LATEST, app: '0.30.1', appCask: null }));
    expect(trashed(mac)).toBe(1);
    expect(mac.disk.app).toBeNull();
    expect(linked(mac)).toBe(true);
    expect(ollama.serving?.version).toBe(LATEST);
  });

  it('the app Homebrew owns is never trashed', async () => {
    const mac = await boot(fakeMac({ running: serviceServe(LATEST), formula: LATEST, app: LATEST, appCask: 'ollama-app' }));
    expect(trashed(mac)).toBe(0);
    expect(linked(mac)).toBe(false);
  });

  it('the app that is the one answering is never trashed', async () => {
    const mac = await boot(fakeMac({ running: appServe(LATEST), app: LATEST, appCask: null }));
    expect(trashed(mac)).toBe(0);
    expect(mac.disk.app).toBe(LATEST);
  });

  it('the real host only asks Finder to move the app bundle, never deletes, and never names the models folder', async () => {
    const argv: string[][] = [];
    const real = makeRealDeps(async (cmd, args) => {
      argv.push([cmd, ...args]);
      if (cmd === '/bin/test' && !args[1].startsWith('/Applications/')) throw new Error('not here');
      return { stdout: '' };
    }, () => true, () => { throw new Error('nothing is spawned'); });
    await real.trashApp();
    expect(argv.filter(([c]) => c === 'osascript').map((a) => a[2])).toEqual([
      'tell application "Finder" to delete POSIX file "/Applications/Ollama.app"',
      'tell application "System Events" to delete (every login item whose name is "Ollama")',
    ]);
    expect(argv.flat().some((w) => w === 'rm' || w.includes('.ollama'))).toBe(false);
  });
});
