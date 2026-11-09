// The writer de-duplicates on key AND words: the same sentence again pushes nothing, while a new sentence under a key
// that already stands (an informational Ollama notice, then the action one) replaces it in place and is pushed live.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
const frames = vi.hoisted(() => [] as Array<{ error?: string; cardKey?: string; cardClass?: string; severity?: string }>);
vi.mock('../../gateway/ws.js', () => ({ broadcast: (f: object) => { frames.push(f); }, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { noteUpkeep } from '../../services/ollama-version.js';
import { OLLAMA_TOO_OLD_WORDS, STANDARD_MODELS_MISSING_WORDS, tellOwner } from '../owner-notices.js';
import { standingOwnerNotices } from '../owner-notice-kinds.js';

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(mockDb.current); frames.length = 0; });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a new sentence under a standing key', () => {
  it('is pushed live in its own class; the same sentence again is not', () => {
    expect(tellOwner('ollama', STANDARD_MODELS_MISSING_WORDS)).toBe(true);
    expect(tellOwner('ollama', STANDARD_MODELS_MISSING_WORDS)).toBe(false);
    noteUpkeep({ held: '0.30.1' });
    tellOwner('ollama', OLLAMA_TOO_OLD_WORDS);
    expect(frames.map((f) => [f.cardKey, f.cardClass])).toEqual([['ollama', 'informational'], ['ollama', 'action']]);
    expect(frames[1].error).toContain('needs a newer Ollama');
    expect(standingOwnerNotices().map((c) => [c.cardKey, c.cardClass])).toEqual([['ollama', 'action']]);
  });
});
