// A request held on its job is released when no task linked to it still works: the owner's close or hold closes it
// on a real answer since the hold, else it goes back owed; the owner's cancel calls the request off with its job.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('./helpers/agent-requests.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));

import { runMigrations } from '../../db/migrations.js';
import { decide } from '../../work/done/decide.js';
import { setHold } from '../../work/done/hold.js';
import { transition } from '../../work/store.js';
import { freshAgentsDb, testDb, HELPER } from './helpers/agent-requests.js';
import { ownerAsks, stretch, rowOf, tasksOf, delivered } from './helpers/long-job.js';

beforeEach(() => { freshAgentsDb(runMigrations); });

async function aHeldJob(): Promise<{ ask: string; task: string }> {
  const ask = await ownerAsks('m-1');
  await stretch('parks');
  expect(rowOf(ask).state).toBe('blocked');
  return { ask, task: tasksOf('m-1')[0] };
}
const conversationOf = (ask: string): string | null => (testDb().prepare('SELECT conversation_id AS c FROM work WHERE id = ?').get(ask) as { c: string | null }).c;

describe('a held request is released when its job ends or the owner holds it', () => {
  it('the owner cancels the task: the request he waited on is called off with it', async () => {
    const { ask, task } = await aHeldJob();
    expect(decide({ workId: task, deciderAgentId: null, verdict: 'cancel', reason: 'not needed' }).kind).toBe('decided');
    expect(rowOf(ask).state).toBe('abandoned');
  });

  it('the task closes abandoned by anyone but the owner (here with its project): the request is owed again', async () => {
    const { ask, task } = await aHeldJob();
    expect(transition(task, { to: 'abandoned', by: 'pm', actorId: 'pm', claim: 'decided', reason: 'closed with its project' }).kind).toBe('applied');
    expect(rowOf(ask).state).toBe('open');
  });

  it('the owner holds the task: the request is owed again', async () => {
    const { ask, task } = await aHeldJob();
    expect(setHold(task, 'paused', 'wait for my word', 'owner')).toEqual({ ok: true });
    expect(rowOf(ask).state).toBe('open');
  });

  it('the job ends after its report reached the person: the request closes on that report', async () => {
    const { ask, task } = await aHeldJob();
    delivered(99, conversationOf(ask));
    expect(decide({ workId: task, deciderAgentId: null, verdict: 'owner_done', reason: 'finished' }).kind).toBe('decided');
    expect(rowOf(ask).state).toBe('done');
    void HELPER;
  });
});
