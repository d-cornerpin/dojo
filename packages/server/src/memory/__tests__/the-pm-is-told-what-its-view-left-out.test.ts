// The project manager is told when its view leaves something out to fit: pinned memories too large for its room are
// named in one line after its conversation, and a view that holds everything carries no such line.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', async () => (await import('../../work/done/__tests__/helpers/ladder-world.js')).wsMock());
vi.mock('../../agent/runtime.js', async () => (await import('../../work/done/__tests__/helpers/ladder-world.js')).runtimeMock());
vi.mock('../embeddings.js', () => ({ generateEmbedding: async () => { throw new Error('no embeddings here'); }, queueEmbedding: () => {}, storeEmbedding: async () => {}, refreshEmbedding: () => {} }));

import { assembleContext } from '../assembler.js';
import { insertMessage } from '../message-store.js';
import { freshBoard, PM } from '../../work/done/__tests__/helpers/decision-world.js';
import { doneDb } from '../../work/done/__tests__/helpers/done-db.js';
import { pmCanRun } from '../../work/done/__tests__/helpers/ladder-world.js';

async function view(): Promise<string> {
  const messages = (await assembleContext(PM, 'm', { latestUserSource: null, isEngineTurn: true })).messages;
  return messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
}

function pin(content: string): void {
  doneDb().prepare(`INSERT INTO vault_entries (id, agent_id, type, content, confidence, is_permanent, is_pinned, is_obsolete, created_at, updated_at)
    VALUES (?, 'manual', 'note', ?, 1.0, 1, 1, 0, datetime('now'), datetime('now'))`).run(`pin-${content.length}`, content);
}

describe('the PM is told what its view left out', () => {
  it('pinned memories larger than its room are named in one line; a view that holds all says nothing', async () => {
    freshBoard(); pmCanRun(PM);
    doneDb().prepare('UPDATE models SET context_window = 128000').run();
    insertMessage({ agentId: PM, role: 'user', content: 'Which reports are still open?', conversationId: 'conv-owner-pm', senderId: 'owner', authorized: true });
    pin('Send back any hand-in without a test.');
    expect(await view(), 'everything fits').not.toContain('Left out of this view');

    pin(`The depot ledger, kept whole: ${'bay, crate, seal, weight. '.repeat(40_000)}`);
    const seen = await view();
    expect(seen).toContain('(Left out of this view to fit: your pinned memories. They are still stored.)');
    expect(seen, 'the conversation still shows').toContain('Which reports are still open?');
  });
});
