// A standing rule reaches every project manager turn: "from now on" saved by the main agent word for word and
// pinned is permanent, the nightly maintenance a year later leaves it pinned, and the PM's view begins with it.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', async (orig) => ({ ...(await orig<object>()), generateEmbedding: async () => { throw new Error('no embeddings here'); }, queueEmbedding: () => {}, storeEmbedding: async () => {}, refreshEmbedding: () => {} }));
vi.mock('../../agent/decision-hooks.js', async (orig) => ({ ...(await orig<object>()), judgment: async () => null }));   // no decision model
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runEngineMaintenance } from '../maintenance.js';
import { assembleContext } from '../../memory/assembler.js';
import { freshBoard, call, PM, MAIN } from '../../work/done/__tests__/helpers/decision-world.js';
import { doneDb } from '../../work/done/__tests__/helpers/done-db.js';
import { pmCanRun } from '../../work/done/__tests__/helpers/ladder-world.js';

const RULE = 'From now on, send back any hand-in without a test.';

describe('a standing rule reaches every PM turn', () => {
  it('is permanent, survives a year of nightly maintenance, and opens the PM view', async () => {
    freshBoard(); pmCanRun(PM);
    const saved = await call(MAIN, 'vault_remember', { content: RULE, type: 'procedure', pin: true, verbatim: true });
    expect(saved.isError, saved.content).toBe(false);
    const row = () => doneDb().prepare('SELECT is_pinned, is_permanent FROM vault_entries WHERE content = ?').get(RULE) as { is_pinned: number; is_permanent: number };
    expect(row(), 'a verbatim pinned instruction is permanent').toEqual({ is_pinned: 1, is_permanent: 1 });
    doneDb().prepare("UPDATE vault_entries SET created_at = datetime('now', '-400 days'), last_retrieved_at = NULL").run();
    runEngineMaintenance();
    expect(row().is_pinned, 'still pinned a year later').toBe(1);
    const view = await assembleContext(PM, 'm');
    expect(JSON.stringify(view.messages[0]?.content)).toContain(RULE);
  });
});
