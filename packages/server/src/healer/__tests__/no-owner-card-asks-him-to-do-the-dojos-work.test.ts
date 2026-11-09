// Owner rulings: Ollama's upkeep is the Dojo's job, and the Dojo does its own recovery work. No owner card's sentence
// sends him to a command, a terminal, a download or a restart; each registered card kind's own sentence builder is
// called here with a fixture.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import * as notices from '../owner-notices.js';
import { pausedWords, brokenWords } from '../../agent/agent-owner-cards.js';
import { backupStuckWords } from '../../migration/import-recovery.js';
import { ownerWords as budgetWords } from '../../costs/budget-words.js';

const CHORE = /ollama\.com|\bbrew\b|launchctl|\bterminal\b|\.sh\b|\brun (it|the|this|`)|\b(restart|reinstall|quit|download|update) (ollama|it yourself|the app)\b/i;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare("INSERT INTO agents (id, name, status) VALUES ('a-1', 'Helper', 'idle')").run();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('no owner card asks him to do the Dojo\'s work', () => {
  it('every card kind with a sentence builder, and every fixed card text', () => {
    const sentences: Record<string, string | null> = {
      ...Object.fromEntries(['stuck', 'stall', 'nofit', 'budgetstop', 'healer-missing', 'embedding-switch', 'fitunchecked', 'healer-broken']
        .map((kind) => [kind, notices.wordsOf(`${kind}:a-1`)]).filter(([, w]) => w !== '')),
      ...Object.fromEntries(Object.entries(notices).filter(([name, v]) => /_WORDS$/.test(name) && typeof v === 'string')),
      paused: pausedWords('a-1'),
      broken: brokenWords('a-1', '[auth_invalid] the key was refused'),
      'import-failed-not-running': backupStuckWords('/tmp/example-backup'),
      budget: budgetWords({ scope: 'global', period: 'daily' }, 12, 10),
    };
    expect(Object.values(sentences).filter((s) => !s)).toEqual([]);
    expect(Object.keys(sentences).length).toBeGreaterThan(12);
    expect(Object.entries(sentences).filter(([, s]) => CHORE.test(s ?? ''))).toEqual([]);
  });
});
