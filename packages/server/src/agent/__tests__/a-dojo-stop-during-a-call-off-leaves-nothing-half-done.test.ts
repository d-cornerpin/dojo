// A stop of the Dojo during a call-off leaves nothing half done: every record a call-off changes is written in the one
// unit with the end (nothing waits on a step after commit), so the first start owes nothing. A box whose helpers' jobs
// were left open under pieces called off before this build has them ended once by its update (migration 910).
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../services/imessage-bridge.js', async (orig) => (await import('../v2/__tests__/helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));

import { getAgentRuntime } from '../runtime.js';
vi.spyOn(getAgentRuntime(), 'handleMessage').mockResolvedValue('ran' as never);

import { runMigrations } from '../../db/migrations.js';
import { resolveJoinsAtBoot } from '../a2a-transport.js';
import { nextOwed } from '../v2/owed.js';
import { testDb } from '../v2/__tests__/helpers/reply-sender.js';
import { boardCancel, delegated, endedBy, expectEndedAsHis, pieceOf, stateOf, task, ASK, AGENT } from './helpers/call-off-world.js';

describe('a Dojo stop during a call-off leaves nothing half done', () => {
  it('cut right after the cancel commits: every record is ended already, and the first start owes nothing', async () => {
    delegated();
    task('card-own');
    expect(await boardCancel('card-own')).toBe(200);   // nothing after commit is awaited: the process may die here
    expectEndedAsHis('card-own', ASK, pieceOf(), 'task-helper-1');
    await resolveJoinsAtBoot();
    expect([stateOf(ASK), nextOwed(AGENT)]).toEqual(['abandoned', []]);
  });

  it('the update ends a job left open under a piece called off before it, once (forward, back to the old copy, forward)', () => {
    delegated();
    testDb().prepare("UPDATE work SET state = 'abandoned', closed_at = ? WHERE id = ?").run(Date.now(), pieceOf());   // the old build's leftover
    const update = (): void => { testDb().prepare("DELETE FROM _migrations WHERE name = '910_end_jobs_of_called_off_pieces.sql'").run(); runMigrations(); };
    update();
    expect(endedBy('task-helper-1')?.state).toBe('abandoned');
    update();
    expect(stateOf('task-helper-1')).toBe('abandoned');
  });

  it('the update leaves alone a job reused by a new piece on its thread', () => {
    delegated();
    testDb().prepare("UPDATE work SET state = 'abandoned', closed_at = ? WHERE id = ?").run(Date.now(), pieceOf());
    // A new job for the same helper reuses the thread and its task: a new piece is open on it.
    testDb().prepare(`INSERT INTO work (id, kind, parent_id, agent_id, assignee_agent, requester, root_kind, root_id, state, intent, wakes, closes_thread, opened_at, updated_at)
      VALUES ('piece:new', 'task', ?, ?, 'agent-helper', 'agent', 'a2a_thread', 'thread-relay-0001', 'open', 'ASSIGN', 1, 0, ?, ?)`).run(ASK, AGENT, Date.now(), Date.now());
    testDb().prepare("DELETE FROM _migrations WHERE name = '910_end_jobs_of_called_off_pieces.sql'").run();
    runMigrations();
    expect(stateOf('task-helper-1')).toBe('claimed');
  });
});
