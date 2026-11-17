// The owner's word-for-word standing instructions all reach the agent, however many: the 21st is in the
// assembled turn beside the first, while ordinary pins stay capped at the 20 newest.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', async (orig) => ({ ...(await orig<object>()), generateEmbedding: async () => { throw new Error('no embeddings here'); }, queueEmbedding: () => {}, storeEmbedding: async () => {}, refreshEmbedding: () => {} }));
vi.mock('../../agent/decision-hooks.js', async (orig) => ({ ...(await orig<object>()), judgment: async () => null }));

import { assembleContext } from '../../memory/assembler.js';
import { freshBoard, call, MAIN } from '../../work/done/__tests__/helpers/decision-world.js';
import { doneDb } from '../../work/done/__tests__/helpers/done-db.js';

const rule = (n: number): string => `From now on, rule number ${n}: label every parcel before it leaves.`;

describe('the 21st standing instruction reaches the agent', () => {
  it('shows every permanent rule and only the 20 newest ordinary pins', async () => {
    freshBoard();
    for (let n = 1; n <= 21; n++) {
      const saved = await call(MAIN, 'vault_remember', { content: rule(n), type: 'procedure', pin: true, verbatim: true });
      expect(saved.isError, saved.content).toBe(false);
    }
    for (let n = 1; n <= 21; n++) {
      doneDb().prepare(
        `INSERT INTO vault_entries (id, agent_id, type, content, is_pinned, created_at) VALUES (?, ?, 'fact', ?, 1, datetime('now', ?))`,
      ).run(`pin-${n}`, MAIN, `Pinned fact number ${n} about the depot`, `-${100 - n} minutes`);
    }
    const turn = JSON.stringify((await assembleContext(MAIN, 'm')).messages);
    for (let n = 1; n <= 21; n++) expect(turn).toContain(rule(n));
    expect(turn).not.toContain('Pinned fact number 1 about');
    expect(turn).toContain('Pinned fact number 2 about');
    expect(turn).toContain('Pinned fact number 21 about');
  });
});
