// A standing rule re-said in close words is a correction: the new wording replaces the old one and
// keeps its pin and its permanent mark, so it is still in every turn and never fades.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
// Every text gets the same vector: similarity 1.0, so the second save is a correction of the first.
vi.mock('../../memory/embeddings.js', async (orig) => ({ ...(await orig<object>()), generateEmbedding: async () => { const v = new Float32Array(8); v[0] = 1; return v; }, queueEmbedding: () => {}, storeEmbedding: async () => {}, refreshEmbedding: () => {} }));
vi.mock('../../agent/decision-hooks.js', async (orig) => ({ ...(await orig<object>()), judgment: async () => null }));

import { freshBoard, call, MAIN } from '../../work/done/__tests__/helpers/decision-world.js';
import { doneDb } from '../../work/done/__tests__/helpers/done-db.js';

const live = () => doneDb().prepare('SELECT content, is_pinned, is_permanent FROM vault_entries WHERE is_obsolete = 0').all();

describe('a corrected standing rule keeps its pin', () => {
  it('carries the pin and the permanent mark to the new wording', async () => {
    freshBoard();
    await call(MAIN, 'vault_remember', { content: 'From now on, never ship on a Friday.', type: 'procedure', pin: true, verbatim: true });
    const saved = await call(MAIN, 'vault_remember', { content: 'From now on, never ship on a Friday or a Saturday.', type: 'procedure' });
    expect(saved.isError, saved.content).toBe(false);
    expect(live()).toEqual([{ content: expect.stringContaining('a Friday or a Saturday.'), is_pinned: 1, is_permanent: 1 }]);
  });
});
