// A standing instruction is classified on the words the person gave, and is saved as given. The bloat-strip used to
// run first and remove "Going forward, " (it is also a narrative-scaffolding phrase), so the rule then saw an entry with
// no trigger phrase left and bounced it as too long. Table: each trigger phrase at sentence start, capitalised,
// after a comma, and mid-sentence.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));
vi.mock('../embeddings.js', () => ({ generateEmbedding: vi.fn(async () => new Float32Array(8)), queueEmbedding: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import { executeVaultRemember } from '../tools.js';

const TAIL = 'copy my assistant on every invoice, whatever the amount, and keep the cc line on each reply that goes out about it, so nothing is ever missed by the people who need to see it';
const PHRASES = ['going forward', 'from now on', 'from this point on', 'always', 'never', 'do not ever', 'remember that', 'make sure you always'];

beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(mockDb.current); });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the standing-instruction rule sees the entry as written', () => {
  it('the reported case: "Going forward, copy my assistant on every invoice." is saved, with its words intact', async () => {
    const text = 'Going forward, copy my assistant on every invoice, whatever the amount, and keep the cc line on each reply that goes out about it.';
    const out = await executeVaultRemember('a1', { content: text, type: 'note' });
    expect(out).not.toMatch(/Too long|Reads like narrative prose/);
    const saved = mockDb.current!.prepare('SELECT content FROM vault_entries').all() as Array<{ content: string }>;
    expect(saved.map((r) => r.content).join('\n')).toMatch(/Going forward, copy my assistant/);
  });

  for (const phrase of PHRASES) {
    const cap = phrase[0].toUpperCase() + phrase.slice(1);
    const shapes: Array<[string, string]> = [
      ['sentence start', `${phrase} ${TAIL}.`],
      ['capitalised, then comma', `${cap}, ${TAIL}.`],
      ['after a comma', `Noted, ${phrase}, ${TAIL}.`],
      ['mid-sentence', `The owner asked that ${phrase} we ${TAIL}.`],
    ];
    for (const [where, text] of shapes) {
      it(`${phrase} (${where}) is not bounced for length`, async () => {
        expect(text.length).toBeGreaterThan(150);
        const out = await executeVaultRemember('a1', { content: text, type: 'note' });
        expect(out).not.toMatch(/Too long|Reads like narrative prose/);
      });
    }
  }

  it('the strip still removes filler from an entry that is not a standing instruction', async () => {
    await executeVaultRemember('a1', { content: 'In summary, the tunnel is named.', type: 'note' });
    const saved = mockDb.current!.prepare('SELECT content FROM vault_entries').all() as Array<{ content: string }>;
    expect(saved[0].content).not.toMatch(/In summary/);
  });
});
