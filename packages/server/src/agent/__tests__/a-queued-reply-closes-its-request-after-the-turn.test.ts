// A reply still queued when its turn finalized is delivered later by the clock: its request closes then, even though
// a task linked to it is still open (the send-time job hold applies only while the request's turn is live).
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { settleAsksForDelivery } from '../../work/ask-settlement.js';
import { claimAsk, stampClaimingTurn } from '../../work/store.js';
import { openTrackerTask } from '../../work/tracker-store.js';
import { freshAgentsDb, testDb, HELPER } from './helpers/agent-requests.js';
import { ownerAsks, rowOf, delivered } from './helpers/long-job.js';

beforeEach(() => { freshAgentsDb(runMigrations); });

describe('a queued reply closes its request after the turn', () => {
  it('delivered after finalize with a linked task open: the request is done', async () => {
    const ask = await ownerAsks('m-1');
    openTrackerTask({ title: 'Sort the photos', assignedTo: HELPER, createdBy: HELPER, status: 'in_progress', origin: { kind: 'model', sourceMessageId: 'm-1', turn: 7, convKey: null } });
    claimAsk(ask, HELPER);
    stampClaimingTurn(ask, 7);   // the turn that claimed it has finalized: no turn is live
    delivered(7, 'conv-owner');
    const d = testDb().prepare('SELECT id FROM deliveries ORDER BY rowid DESC LIMIT 1').get() as { id: string };
    settleAsksForDelivery({ agentId: HELPER, turnNumber: 7, deliveryId: d.id, conversationId: 'conv-owner', tool: 'dashboard', outcome: 'delivered' });
    expect(rowOf(ask).state).toBe('done');
  });
});
