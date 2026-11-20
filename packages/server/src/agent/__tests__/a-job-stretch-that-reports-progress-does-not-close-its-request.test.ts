// A progress text a long job delivers does not close its request: at send time it is held while a task linked to
// it works, and at the turn's end a parked job holds it, even one the turn closed on the way.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { settleAsksForDelivery } from '../../work/ask-settlement.js';
import { freshAgentsDb, testDb, HELPER } from './helpers/agent-requests.js';
import { ownerAsks, stretch, rowOf, delivered } from './helpers/long-job.js';

beforeEach(() => { freshAgentsDb(runMigrations); });

describe('a job stretch that reports progress does not close its request', () => {
  it('a progress line delivered mid-stretch, then the park: the request is held, not closed', async () => {
    const ask = await ownerAsks('m-1');
    await stretch('parks', () => {
      const turn = (testDb().prepare('SELECT MAX(turn_number) AS n FROM turns WHERE agent_id = ?').get(HELPER) as { n: number }).n;
      const conv = (testDb().prepare('SELECT conversation_id AS c FROM work WHERE id = ?').get(ask) as { c: string }).c;
      delivered(turn, conv);
      const d = testDb().prepare('SELECT id FROM deliveries ORDER BY rowid DESC LIMIT 1').get() as { id: string };
      settleAsksForDelivery({ agentId: HELPER, turnNumber: turn, deliveryId: d.id, conversationId: conv, tool: 'dashboard', outcome: 'delivered' });
    });
    expect(rowOf(ask).state).toBe('blocked');
  });

  it('the job\'s next stretch reports progress and parks again: still held', async () => {
    const ask = await ownerAsks('m-1');
    await stretch('parks');
    await stretch('parks', () => {
      const turn = (testDb().prepare('SELECT MAX(turn_number) AS n FROM turns WHERE agent_id = ?').get(HELPER) as { n: number }).n;
      delivered(turn, (testDb().prepare('SELECT conversation_id AS c FROM work WHERE id = ?').get(ask) as { c: string }).c);
    });
    expect(rowOf(ask).state).toBe('blocked');
  });

  it('the job\'s final stretch delivers its report without parking: the request closes', async () => {
    const ask = await ownerAsks('m-1');
    await stretch('parks');
    await stretch('answers');
    expect(rowOf(ask).state).toBe('done');
  });
});
