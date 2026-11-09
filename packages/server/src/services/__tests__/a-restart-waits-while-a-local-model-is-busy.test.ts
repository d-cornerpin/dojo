// An Ollama restart waits until no local model is busy (an agent's call holding a lock slot, the Dojo's own unslotted work, a
// model pull) and proceeds once it is quiet, so a restart never cuts a running call or a download. `fake-mac.ts` plays the Mac.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';

import { getOllamaLock, localWorkBegins } from '../ollama-lock.js';
import { upkeep } from '../ollama-upkeep.js';
import { STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL } from '../local-standard.js';
import { ollama, startFakeOllama, stopFakeOllama, fakeMac, appServe, LATEST, type Mac, useOllamaHost } from './fake-mac.js';

const LOCAL = 'ollama-local';
let mac: Mac;
beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  const baseUrl = await startFakeOllama();
  ollama.silent = new Set(); ollama.pulls = []; ollama.failPulls = false; ollama.refuseAllBelow035 = false;
  ollama.installed = new Set(['nomic-embed-text:latest', STANDARD_DECISION_MODEL.tag, STANDARD_DECISION_MODEL.windowTag, STANDARD_WRITER_MODEL.tag]);
  mockDb.current.prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES (?, 'Ollama', 'ollama', ?, 'none', 1)").run(LOCAL, baseUrl);
  mac = fakeMac({ running: appServe(LATEST), app: LATEST });   // current; its limit is not raised yet, so a start restarts it once
  useOllamaHost(mac);
});
afterEach(async () => {
  useOllamaHost(null);
  await stopFakeOllama();
  mockDb.current?.close(); mockDb.current = null;
});

const aWhile = (): Promise<void> => new Promise((r) => setTimeout(r, 700));

describe('an Ollama restart waits while a local model is busy', () => {
  it('an agent\'s call holds it off until the call is released', async () => {
    await getOllamaLock().acquire(LOCAL, 'agent-model:7b');
    const start = upkeep('boot');
    await aWhile();
    expect(mac.terms).toEqual([]);
    getOllamaLock().release(LOCAL, 'agent-model:7b');
    await start;
    expect(mac.launches).toBe(1);
  });

  it('the Dojo\'s own unslotted work (a pinned call, decide(), the embedder, a pull) holds it off the same way', async () => {
    await getOllamaLock().acquire(LOCAL, STANDARD_WRITER_MODEL.tag, undefined, true);
    const end = localWorkBegins();
    const start = upkeep('boot');
    getOllamaLock().release(LOCAL, STANDARD_WRITER_MODEL.tag, true);
    await aWhile();
    expect(mac.terms).toEqual([]);   // the decision call is still open
    end();
    await start;
    expect(mac.launches).toBe(1);
  });

  it('when nothing is busy it restarts at once', async () => {
    await upkeep('boot');
    expect(mac.log).toEqual(['setenv', 'term', 'term', 'launch']);   // the app and its server, then the app again
  });
});
