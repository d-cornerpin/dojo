// A fresh assignment opens its task on the thread before its message is written; a request never served is still
// owed, so the helper's next turn is the assignment's own A2A turn; a barge-in on that turn served nothing and leaves it so.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { deliverA2AMessage } from '../a2a-transport.js';
import { openTurnContext, endTurnContext } from '../turn-context.js';
import { runPreflight } from '../v2/steps/preflight/index.js';
import { nextOwed } from '../v2/owed.js';
import { freshAgentsDb, preflightCtx, testDb, helperTurn, requestRow, HELPER, ASKER } from './helpers/agent-requests.js';

beforeEach(() => { endTurnContext(HELPER); freshAgentsDb(runMigrations); });

describe('a fresh assignment is served in its own turn', () => {
  it('the assignment\'s working task does not hide it: the next turn is an A2A turn serving it', async () => {
    const sent = await deliverA2AMessage({
      intent: 'ASSIGN', threadId: '', requiresResponse: true, payload: 'tally the invoices', toAgent: HELPER, fromAgent: ASKER,
    });
    expect(sent.delivered).toBe(true);
    const task = testDb().prepare("SELECT state FROM work WHERE agent_id = ? AND a2a_thread_id = ? AND kind <> 'ask'")
      .get(HELPER, sent.threadId) as { state: string } | undefined;
    expect(task, 'the transport opened the assignment\'s task first').toBeDefined();
    expect(nextOwed(HELPER)[0]).toMatchObject({ kind: 'agentRequest' });

    const bag = openTurnContext(HELPER);
    expect((await runPreflight(bag, preflightCtx())).directive).toBe('proceed');
    expect(bag.kind).toBe('a2a');
    expect(bag.servedRequest).toMatchObject({ threadId: sent.threadId, intent: 'ASSIGN', fromId: ASKER });
  });

  it('a barge-in on its first turn leaves it owed, uncounted, and the next turn serves it', async () => {
    const THREAD = 'thread-barged-in-0001';
    await deliverA2AMessage({ intent: 'ASSIGN', threadId: THREAD, requiresResponse: true, payload: 'tally the invoices', toAgent: HELPER, fromAgent: ASKER });
    const first = await helperTurn('preempt');
    expect(first).not.toBeNull();
    expect(requestRow(THREAD)).toMatchObject({ served: null, attempts: 0 });
    expect(await helperTurn('silent')).toBe(first);
  });
});
