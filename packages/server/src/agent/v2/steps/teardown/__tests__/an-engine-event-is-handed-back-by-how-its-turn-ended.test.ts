// An engine event (a reminder, a notice) a turn claimed is handed back at finalize by how the turn ended: a
// first-call rate limit waits for the reset uncounted, a limit after paid calls is counted, a silent turn and a
// turn that made a side effect keep it served, and Stop sweeps it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../../../db/connection.js', async () => (await import('../../../__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {} }));
vi.mock('../../../../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: vi.fn(async () => 'ran') }) }));

import { runMigrations } from '../../../../../db/migrations.js';
import { insertEngineEvent, claimEngineEventByRowid } from '../../../../../memory/message-store.js';
import { finalizeTurnRecord } from '../finalize-record.js';
import { latchEngineCut } from '../../../engine-exit.js';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import type { TeardownContext } from '../index.js';
import { freshReplyDb, testDb, AGENT, T0 } from '../../../__tests__/helpers/reply-sender.js';

const TURN = 7;
const RESET = T0 + 5 * 60_000;
let rowid = 0;

const fresh = (): AgentTurnState => initState({
  agentId: AGENT, contextWindow: 200_000, isAutoRouted: false, configuredModelId: 'model-1', turnNumber: TURN,
  triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: null, lastUserMessageId: null,
  inboundChannel: 'dashboard', inboundContext: null,
});
const turnEnds = (state: AgentTurnState, bag: { retryAt?: number; abortHandBack?: boolean } = {}): Promise<void> =>
  finalizeTurnRecord(state, {
    agentId: AGENT, turnNumber: TURN, db: testDb(), chosenConvKey: null, chosenConversationId: null, lastAssembledAtIso: null,
    terminalAnswerRowId: null, triggerWorkId: null, toolPhaseEndedBySpinBrake: false,
    counterparty: { kind: 'user', name: 'the engine', relation: 'engine', channel: 'engine', senderId: null, threadId: null, senderIsAgent: false },
    isA2ATurn: false, isEngineTurn: true, turnStartedAt: '2030-01-01 00:00:00', inboundChannel: 'dashboard', inboundContext: null,
    reArmIfStrandedNoAnswer: () => {}, stopStatusHeartbeat: () => {},
    claimedEngineEvent: { rowid, turnNumber: TURN },
    turnCtx: { agentId: AGENT, root: null, retryAt: bag.retryAt ?? null, abortHandBack: bag.abortHandBack ?? false, lastAssembledAtIso: null },
  } as unknown as TeardownContext);
const event = (): { served: number | null; swept: number | null; attempts: number; due: number | null } =>
  testDb().prepare('SELECT served_by_turn AS served, swept_at AS swept, delivery_attempts AS attempts, next_attempt_at AS due FROM messages WHERE seq = ?')
    .get(rowid) as { served: number | null; swept: number | null; attempts: number; due: number | null };

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  freshReplyDb(runMigrations);
  rowid = insertEngineEvent({ agentId: AGENT, content: 'remind the owner to call the plumber', originIntent: 'scheduler', work: null }).seq;
  claimEngineEventByRowid({ rowid, agentId: AGENT, turnNumber: TURN });
  testDb().prepare("INSERT INTO turns (agent_id, turn_number, kind, subject_kind, answered, effectful_calls, started_at) VALUES (?, ?, 'engine', 'engine_event', 0, 0, datetime('now'))").run(AGENT, TURN);
});
afterEach(() => { vi.useRealTimers(); });

describe('an engine event is handed back by how its turn ended', () => {
  it('a rate limit on the first call releases it to wait for the reset, uncounted', async () => {
    await turnEnds(advance(latchEngineCut(fresh(), 'provider_error'), { loopCount: 1 }), { retryAt: RESET, abortHandBack: true });
    expect(event()).toEqual({ served: null, swept: null, attempts: 0, due: RESET });
  });

  it('a rate limit after paid calls releases it and counts the failed delivery', async () => {
    await turnEnds(advance(latchEngineCut(fresh(), 'provider_error'), { loopCount: 3 }), { retryAt: RESET, abortHandBack: true });
    expect(event()).toMatchObject({ served: null, swept: null, attempts: 1 });
  });

  it('a silent read-only turn keeps it served', async () => {
    await turnEnds(fresh());
    expect(event()).toEqual({ served: TURN, swept: null, attempts: 0, due: null });
  });

  it('an abort after a side effect keeps it served', async () => {
    await turnEnds(advance(latchEngineCut(fresh(), 'abort'), { nonIdempotentCallsThisTurn: 1 }), { abortHandBack: true });
    expect(event()).toMatchObject({ served: TURN, swept: null, attempts: 0 });
  });

  it('a stopped turn sweeps it, so it never comes back', async () => {
    await turnEnds(latchEngineCut(fresh(), 'stop'), { abortHandBack: true });
    expect(event().swept).not.toBeNull();
  });
});
