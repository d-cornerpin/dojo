// T79 FIX WAVE — FINDING 1 (CRITICAL): the durable effort meter must see lookup loops.
//
// THE DEFECT: the charge site (`countTrackerWorkThisIteration`'s call into `chargeEffort`)
// read `nonTrackerInThisIter`, which (FA-T3) deliberately excludes every `TRIVIAL_TOOLS`
// member — a carve-out that exists so a pure reconnaissance turn (checking email / calendar /
// contacts / vault / history) does not trip the SCAFFOLDING FLOORS' >=6 auto-scaffold. The
// effort meter inherited that same blind spot at a site that has no such reason for it: a wide
// loop built entirely of varied `gmail_search`/`gmail_inbox`-shaped calls — the plan's own
// motivating scenario, a mailbox sweep re-enumerating forever — charged the meter NOTHING, so
// on an uncapped provider row nothing else in the system ever stopped it.
//
// THE FIX: a charge-specific count, computed only at the charge site, of every tool call this
// iteration that is not tracker-family (`isTrackerFamilyCall`, the SAME authoritative predicate
// `trackerInThisIter` already applies a few lines up) — `TRIVIAL_TOOLS` included. This file
// pins two things:
//   §1 RED, now GREEN — a loop of TRIVIAL_TOOLS-shaped calls (and a mix of trivial + real work)
//      accumulates `effort_calls` on the agent's currently claimed task.
//   §2 CONTROL — `nonTrackerToolCalls` (the scaffolding floors' own count) is BYTE-IDENTICAL:
//      still excludes every TRIVIAL_TOOLS call, exactly as FA-T3 intended, even on the exact
//      same iteration that now charges the meter for those same calls.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { countTrackerWorkThisIteration } from '../tracker-counting.js';
import { initState, type AgentTurnState } from '../../../state.js';
import type { TurnCounterparty } from '../../../counterparty.js';
import type { ExecuteContext } from '../index.js';
import { createWorkTable, seedTrackerTask } from '../../../../../work/__tests__/work-fixture.js';

const AGENT = 'agent-f1';
const CLAIMED_TASK = 'claimed-1';

const USER: TurnCounterparty = {
  kind: 'user', name: 'Owner', relation: 'owner', channel: 'dashboard',
  senderId: 'owner', threadId: null, senderIsAgent: false,
};

function freshState(): AgentTurnState {
  return initState({
    agentId: AGENT, contextWindow: 100_000, isAutoRouted: false,
    configuredModelId: 'floor-model', turnNumber: 1, triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null, lastUserMessageContent: null,
    lastUserMessageId: null, inboundChannel: 'dashboard', inboundContext: null,
    pendingTechniqueAck: null,
  });
}

/** A model response carrying one tool call per given tool name, in order. */
function callsOf(names: string[]): { toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> } {
  return { toolCalls: names.map((name) => ({ id: `tc-${uuidv4()}`, name, arguments: {} })) };
}

function executeCtx(result: ReturnType<typeof callsOf>): ExecuteContext {
  return {
    agentId: AGENT,
    turnCtx: { convKey: 'human:owner', startAckSteerArmedThisTurn: false, startAckSteerRequested: false },
    counterparty: USER,
    counterpartyIsAgentSender: false,
    engineStartAckDeliveredThisTurn: true, // the start-ack path is not under test here
    result: result as unknown as ExecuteContext['result'],
  } as unknown as ExecuteContext;
}

function effortCalls(id: string): number {
  return (mockDb.current!.prepare(
    'SELECT effort_calls FROM work WHERE id = ?',
  ).get(id) as { effort_calls: number }).effort_calls;
}

beforeEach(() => {
  const db = new Database(':memory:');
  createWorkTable(db);
  mockDb.current = db;
  seedTrackerTask(db, { id: CLAIMED_TASK, agentId: AGENT, status: 'in_progress' });
});

describe('§1 the effort meter charges a loop of TRIVIAL_TOOLS-shaped calls (RED, then GREEN)', () => {
  it('a loop of gmail_search/gmail_inbox/gmail_read calls accumulates effortDelta even though none is a tracker call or a "real work" call', () => {
    const result = callsOf(['gmail_search', 'gmail_inbox', 'gmail_search', 'gmail_read', 'gmail_search']);

    countTrackerWorkThisIteration(freshState(), executeCtx(result));

    expect(
      effortCalls(CLAIMED_TASK),
      'a mailbox-sweep loop of trivial lookups must charge the durable effort meter',
    ).toBe(5);
  });

  it('a mix of trivial and real-work calls charges the WIDER (non-tracker-family) count, not just the real-work subset', () => {
    const result = callsOf(['gmail_search', 'gmail_search', 'file_write', 'file_write', 'file_write']);

    countTrackerWorkThisIteration(freshState(), executeCtx(result));

    expect(effortCalls(CLAIMED_TASK), '2 trivial + 3 real, all non-tracker-family, all chargeable').toBe(5);
  });

  it('across two iterations, trivial-only charges accumulate exactly like any other charge', () => {
    countTrackerWorkThisIteration(freshState(), executeCtx(callsOf(['gmail_search', 'gmail_search'])));
    countTrackerWorkThisIteration(freshState(), executeCtx(callsOf(['calendar_agenda', 'contacts_search', 'vault_search'])));

    expect(effortCalls(CLAIMED_TASK)).toBe(5);
  });

  it('no claimed task: a trivial-only loop still runs (nothing to charge, no throw)', () => {
    seedTrackerTask(mockDb.current!, { id: 'no-claim', agentId: 'someone-else', status: 'in_progress' });
    expect(() =>
      countTrackerWorkThisIteration(
        initState({
          agentId: 'nobody-claims-anything', contextWindow: 100_000, isAutoRouted: false,
          configuredModelId: 'floor-model', turnNumber: 1, triggeredByIMessage: false,
          triggeredByA2AReplyIntent: null, lastUserMessageContent: null, lastUserMessageId: null,
          inboundChannel: 'dashboard', inboundContext: null, pendingTechniqueAck: null,
        }),
        executeCtx(callsOf(['gmail_search', 'gmail_search'])),
      ),
    ).not.toThrow();
  });
});

describe('§2 CONTROL — byte-preservation of nonTrackerToolCalls, the scaffolding floors\' own count', () => {
  it('a trivial-only iteration leaves state.nonTrackerToolCalls at 0 — FA-T3\'s carve-out for the floors is untouched', () => {
    const result = callsOf(['gmail_search', 'gmail_inbox', 'gmail_search']);

    const after = countTrackerWorkThisIteration(freshState(), executeCtx(result));

    expect(after.nonTrackerToolCalls, 'the floors must still never see trivial lookups as work').toBe(0);
    expect(effortCalls(CLAIMED_TASK), 'yet the durable effort meter still charged all three').toBe(3);
  });

  it('a mix charges the floors\' own counter with ONLY the non-trivial calls, exactly as before this fix', () => {
    const result = callsOf(['gmail_search', 'file_write', 'file_write']);

    const after = countTrackerWorkThisIteration(freshState(), executeCtx(result));

    expect(after.nonTrackerToolCalls, 'trivial excluded from the floors\' count, unchanged behavior').toBe(2);
    expect(effortCalls(CLAIMED_TASK), 'the meter sees all three').toBe(3);
  });

  it('a pure real-work iteration (no trivial calls at all) charges the SAME number on both counters, as it always did', () => {
    const result = callsOf(['file_write', 'file_write']);

    const after = countTrackerWorkThisIteration(freshState(), executeCtx(result));

    expect(after.nonTrackerToolCalls).toBe(2);
    expect(effortCalls(CLAIMED_TASK)).toBe(2);
  });
});
