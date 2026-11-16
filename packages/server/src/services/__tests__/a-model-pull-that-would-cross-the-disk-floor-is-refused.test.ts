// The Dojo's own model downloads ask first whether the disk has room: one that would leave less free than the
// floor the watchdog keeps is not started, and the owner is told why. A real HTTP server plays Ollama and
// `fake-mac.ts` plays the Mac; only the volume's free space is stood in for.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
const frames = vi.hoisted(() => ({ list: [] as Array<{ error?: string; severity?: string }> }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: (f: { error?: string }) => { frames.list.push(f); }, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { standardProgressLines, upkeep, upkeepSettled } from '../ollama-upkeep.js';
import '../decision-window.js';   // loaded here, not inside a case's clock
import { dismissOwnerNotice, ownerToldOf } from '../../healer/owner-notices.js';
import { STANDARD_MODELS_NO_ROOM_WORDS } from '../../healer/local-model-notice-words.js';
import { ollama, startFakeOllama, stopFakeOllama, fakeMac, formulaServe, LATEST, useOllamaHost } from './fake-mac.js';

function freeSpace(bytes: number): void {
  vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: bytes, bsize: 1, bfree: bytes, blocks: bytes, ffree: 0, files: 0, type: 0 } as unknown as ReturnType<typeof fs.statfsSync>);
}

beforeEach(async () => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  const baseUrl = await startFakeOllama();
  ollama.silent = new Set(); ollama.installed = new Set(); ollama.pulls = []; ollama.refuseAllBelow035 = false; ollama.failPulls = false;
  mockDb.current.prepare("INSERT INTO providers (id, name, type, base_url, auth_type, is_validated) VALUES ('ollama-local', 'Ollama', 'ollama', ?, 'none', 1)").run(baseUrl);
  useOllamaHost(fakeMac({ running: formulaServe(LATEST), formula: LATEST }));
  frames.list.length = 0;
});
afterEach(async () => {
  await upkeepSettled();
  useOllamaHost(null);
  vi.restoreAllMocks();
  await stopFakeOllama();
  mockDb.current?.close(); mockDb.current = null;
});

describe('a model pull that would cross the disk floor', () => {
  it('is not started, and the owner is told the disk is short', async () => {
    freeSpace(2_000_000_000);
    await upkeep('boot');
    expect(ollama.pulls).toEqual([]);
    expect(standardProgressLines().join(' ')).toMatch(/Not enough free disk space .*GB free/);
    expect(frames.list.some((f) => f.error === STANDARD_MODELS_NO_ROOM_WORDS)).toBe(true);
  });

  it('goes ahead when the disk has room', async () => {
    freeSpace(1e12);
    await upkeep('boot');
    expect(ollama.pulls).toHaveLength(2);
  });

  it('stays dismissed while the disk stays short, and a new shortage after room returned is told again', async () => {
    freeSpace(2_000_000_000);
    await upkeep('boot');
    expect(ownerToldOf('ollama')).toBe(true);
    dismissOwnerNotice('ollama');
    freeSpace(1_500_000_000);
    await upkeep('boot');
    expect(ownerToldOf('ollama')).toBe(false);
    freeSpace(1e12);
    await upkeep('boot');
    expect(ollama.pulls).toHaveLength(2);
    ollama.installed = new Set();
    freeSpace(2_000_000_000);
    await upkeep('boot');
    expect(ownerToldOf('ollama')).toBe(true);
  });
});
