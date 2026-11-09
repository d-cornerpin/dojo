// An Ollama too old that the Dojo cannot update (another user's, so the TERM is refused) raises exactly one owner notice,
// and later runs of the upkeep raise none. `fake-mac.ts` plays the Mac; nothing real runs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
const frames = vi.hoisted(() => ({ list: [] as Array<{ type?: string; error?: string; severity?: string; cardClass?: string }> }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: (f: { error?: string }) => { frames.list.push(f); }, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';

import { upkeep, upkeepSettled, upkeepWhenIncomplete } from '../ollama-upkeep.js';
import { OLLAMA_TOO_OLD_WORDS } from '../../healer/owner-notices.js';
import { standingOwnerNotices } from '../../healer/owner-notice-kinds.js';
import { ollama, startFakeOllama, stopFakeOllama, fakeMac, formulaServe, useOllamaHost } from './fake-mac.js';

let baseUrl = '';
beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  baseUrl = await startFakeOllama();
  ollama.silent = new Set(); ollama.pulls = []; ollama.installed = new Set(['nomic-embed-text:latest']); ollama.failPulls = false; ollama.refuseAllBelow035 = false;
  mockDb.current.prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', ?, 'none', 1)").run(baseUrl);
  useOllamaHost(fakeMac({ running: formulaServe('0.30.1', { foreign: true }), formula: '0.30.1' }));
  frames.list.length = 0;
});
afterEach(async () => {
  await upkeepSettled();
  useOllamaHost(null);
  await stopFakeOllama();
  mockDb.current?.close(); mockDb.current = null;
});

const cards = (): Array<{ error?: string; cardClass?: string }> => frames.list.filter((f) => f.type === 'chat:error' && f.severity !== 'info');

describe('an Ollama the Dojo cannot update is told once', () => {
  it('one action card at the first run; a start, a health check and Repair after it raise none', async () => {
    await upkeep('boot');
    expect(cards()).toEqual([expect.objectContaining({ error: OLLAMA_TOO_OLD_WORDS, cardClass: 'action' })]);
    await upkeep('boot');
    upkeepWhenIncomplete([...ollama.installed], baseUrl); await upkeepSettled();
    await upkeep('repair');
    expect(cards()).toHaveLength(1);
    expect(standingOwnerNotices().map((c) => c.words)).toEqual([OLLAMA_TOO_OLD_WORDS]);   // it stands on a reload
  });
});
