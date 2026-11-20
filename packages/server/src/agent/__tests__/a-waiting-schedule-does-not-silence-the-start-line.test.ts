// The start line is skipped only when a fresh task the agent can work now is open: a quick follow-up rides under it.
// A schedule that was just set up and is waiting for its time is not such a task. A new request is judged either way.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import '../decision-ask.js';
import { __forgetResidencyForTests } from '../decide.js';
import { detectMultistepAndScaffold } from '../v2/steps/assemble/multistep-detection.js';
import { advance, initState } from '../v2/state.js';
import { installDecisionModel, scriptDecisions, yes } from './decision-fake.js';

const WORK = 'Plan five weeknight dinners for a family of four and make one shopping list grouped by store section.';

const task = (id: string, state: string, schedule: { status: string; nextRunAt: number } | null): void => {
  mockDb.current!.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at, schedule_status, next_run_at)
     VALUES (?, 'task', 'a1', 'owner', 'tracker', ?, ?, 'tracker', 0, 0, ?, ?, ?, ?, ?)`,
  ).run(id, id, state, id, Date.now(), Date.now(), schedule?.status ?? null, schedule?.nextRunAt ?? null);
};

async function arrive(): Promise<{ judged: number; armed: boolean }> {
  const calls = scriptDecisions(() => yes(0.9));
  const turnCtx = { startAckSteerArmedThisTurn: false, startAckSteersInjected: 0, startAckSteerInjectedAtLoop: null, inboundClassifiedAsWork: false };
  await detectMultistepAndScaffold(advance(initState({ agentId: 'a1' } as Parameters<typeof initState>[0]), { loopCount: 1 }), {
    agentId: 'a1', turnNumber: 1, turnCtx: turnCtx as never, db: mockDb.current! as never,
    counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard', senderId: null, threadId: null, senderIsAgent: false } as never,
    counterpartyIsAgentSender: false, lastUserMessageContent: WORK, engineStartAckDeliveredThisTurn: false, staleTaskWindowMinutes: 30,
  });
  return { judged: calls.length, armed: turnCtx.startAckSteerArmedThisTurn };
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.pragma('foreign_keys = OFF');
  installDecisionModel(mockDb.current);
  __forgetResidencyForTests();
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('a new work request while a task is open', () => {
  it('with only a fresh schedule waiting for its time, the request is judged and the start line armed', async () => {
    task('t-schedule', 'open', { status: 'waiting', nextRunAt: Date.now() + 86_400_000 });
    expect(await arrive()).toEqual({ judged: 1, armed: true });
  });

  it('with a fresh task really being worked, the request is judged and rides under it: no start line', async () => {
    task('t-working', 'claimed', null);
    expect(await arrive()).toEqual({ judged: 1, armed: false });
  });
});
