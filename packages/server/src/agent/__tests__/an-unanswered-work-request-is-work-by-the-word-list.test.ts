// When the decision model gives no answer, base's word list is the second opinion on "is this work": a request with
// several action verbs is work and arms the start acknowledgement; anything else stays without a verdict. When the
// model answers, even between its lines, the list is not read.
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
import { inboundIsWork } from '../v2/classifiers/inbound-routing.js';
import { detectMultistepAndScaffold } from '../v2/steps/assemble/multistep-detection.js';
import { advance, initState } from '../v2/state.js';
import { installDecisionModel, scriptDecisions, yes } from './decision-fake.js';

const WORK = 'Plan five weeknight dinners for a family of four and make one shopping list grouped by store section.';
const QUICK = 'How many teaspoons are in a tablespoon?';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.pragma('foreign_keys = OFF');
  installDecisionModel(mockDb.current);
  __forgetResidencyForTests();
});
afterEach(() => { vi.unstubAllGlobals(); mockDb.current?.close(); mockDb.current = null; });

describe('no answer from the decision model', () => {
  it('a plain request of several steps is work by the word list', async () => {
    scriptDecisions(() => 'fail');
    expect(await inboundIsWork({}, 'a1', WORK)).toBe(true);
  });

  it('a quick question is not work', async () => {
    scriptDecisions(() => 'fail');
    expect(await inboundIsWork({}, 'a1', QUICK)).toBeUndefined();
  });

  it('the assemble step marks the request as work and arms the start acknowledgement', async () => {
    const calls = scriptDecisions(() => 'fail');
    const turnCtx = { startAckSteerArmedThisTurn: false, startAckSteersInjected: 0, startAckSteerInjectedAtLoop: null, inboundClassifiedAsWork: false };
    await detectMultistepAndScaffold(advance(initState({ agentId: 'a1' } as Parameters<typeof initState>[0]), { loopCount: 1 }), {
      agentId: 'a1', turnNumber: 1, turnCtx: turnCtx as never, db: mockDb.current! as never,
      counterparty: { kind: 'user', relation: 'owner', channel: 'dashboard', senderId: null, threadId: null, senderIsAgent: false } as never,
      counterpartyIsAgentSender: false, lastUserMessageContent: WORK, engineStartAckDeliveredThisTurn: false, staleTaskWindowMinutes: 45,
    });
    expect(calls).toHaveLength(1);
    expect(turnCtx.inboundClassifiedAsWork).toBe(true);
    expect(turnCtx.startAckSteerArmedThisTurn).toBe(true);
  });
});

describe('an answer from the decision model', () => {
  it('between the lines stays without a verdict, though the word list would say work', async () => {
    scriptDecisions(() => yes(0.4));
    expect(await inboundIsWork({}, 'a1', WORK)).toBeUndefined();
  });
});
