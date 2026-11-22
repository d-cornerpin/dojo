// v3.5 owner test 2, fix rank 4 (DIAGNOSIS-test2.md, Problem 1): "HAS THE PERSON HEARD ANYTHING" COUNTS WHAT HE WAS SHOWN.
//
// The probe (`preflight/start-ack.ts` `startAckRepliedNow`) counts only assistant rows with no origin stamp. A line the
// model wrote beside a tool call is demoted to a shown `[working-note]` row (role='system'), and a delivered start line
// is stamped `engine_start_ack`, so neither counts. The field duplicate: the model said "On it ..." before the 30s
// threshold (shown to the owner as a dimmed note), then at +30s the engine found "nothing heard" and steered "the user has
// not heard anything from you yet this turn" (false), and the model said "On it" again.
//
// The rule: the start-ack family (the threshold request, the steer, its reminder) never asks for a line after the person
// was shown one this turn: a plain working note, or the delivered start line. An INTERNAL note (routed channel or nobody
// waiting) never reached him, so it does not count.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { WORKING_NOTE_PREFIX, INTERNAL_WORKING_NOTE_PREFIX } from '@dojo/shared';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

import { runMigrations } from '../../../../../db/migrations.js';
import { insertMessageIfAbsent } from '../../../../../memory/message-store.js';
import { START_ACK_ORIGIN_INTENT } from '../../../../../memory/origin-intents.js';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runSteerCheckpoint } from '../steer-checkpoint.js';

const AGENT = 'agent-heard';
const TURN = 9;

type Bag = Record<string, unknown>;
const bag = (over: Bag = {}): Bag => ({ startAckSteerRequested: false, startAckSteerArmedThisTurn: false, startAckSteersInjected: 0, startAckSteerInjectedAtLoop: 0, ...over });

function checkpoint(turnCtx: Bag, loopCount: number): AgentTurnState {
  const state = advance(initState({ agentId: AGENT } as Parameters<typeof initState>[0]), { loopCount });
  return runSteerCheckpoint(state, {
    agentId: AGENT, turnCtx: turnCtx as never, turnNumber: TURN, engineStartAckDeliveredThisTurn: false,
    startAckRepliedNow: () => false,   // the old probe's answer in every clause: it cannot see either kind of line
    mctx: {} as never, messages: [] as never,
  }).state;
}
const floors = (s: AgentTurnState): string[] => (s.steerQueue.fired as unknown as Array<{ floor: string }>).map((f) => f.floor);

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO agents (id, name, status, config) VALUES (?, 'Heard', 'idle', '{}')").run(AGENT);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the start-ack family never asks after the person was shown a line', () => {
  it('a shown "On it" working note this turn: the threshold request does NOT become a steer', () => {
    insertMessageIfAbsent({ id: 'n1', agentId: AGENT, role: 'system', content: `${WORKING_NOTE_PREFIX}On it, checking the inbox.`, turnNumber: TURN });
    const turnCtx = bag({ startAckSteerRequested: true });
    const s = checkpoint(turnCtx, 2);
    expect(floors(s)).not.toContain('start-ack');
    expect(turnCtx.startAckSteerArmedThisTurn).toBe(false);
  });

  it('the delivered start line (stamped engine_start_ack) is heard: no hold after it', () => {
    insertMessageIfAbsent({ id: 'sl', agentId: AGENT, role: 'assistant', content: 'On it.', turnNumber: TURN, originIntent: START_ACK_ORIGIN_INTENT });
    const turnCtx = bag({ startAckSteerRequested: true, startAckSteerArmedThisTurn: true, startAckSteersInjected: 1, startAckSteerInjectedAtLoop: 1 });
    checkpoint(turnCtx, 3);
    expect(turnCtx.startAckSteersInjected).toBe(1);
  });

  it('CONTROL: an INTERNAL note never reached him, so the steer is still asked for', () => {
    insertMessageIfAbsent({ id: 'n2', agentId: AGENT, role: 'system', content: `${INTERNAL_WORKING_NOTE_PREFIX}On it.`, turnNumber: TURN });
    const s = checkpoint(bag({ startAckSteerRequested: true }), 2);
    expect(floors(s)).toContain('start-ack');
  });

  it('CONTROL: a note from an EARLIER turn does not count for this one', () => {
    insertMessageIfAbsent({ id: 'n3', agentId: AGENT, role: 'system', content: `${WORKING_NOTE_PREFIX}On it.`, turnNumber: TURN - 1 });
    const s = checkpoint(bag({ startAckSteerRequested: true }), 2);
    expect(floors(s)).toContain('start-ack');
  });
});
