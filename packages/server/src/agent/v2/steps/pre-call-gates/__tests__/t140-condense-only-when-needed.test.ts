// ════════════════════════════════════════════════════════════════════════════════════════
// t140 — CONDENSE ONLY WHEN NEEDED (tracker #13; decision #16 re-opened and reversed by the
// owner, 2026-10-12: OR-V333-SET (1)).
//
// THE RULING, in his words as recorded: condense only when the working view is getting full
// for the model actually used, or messages are about to leave view — and then only the
// messages leaving view, never what the agent is reading.
//
// ── THE WITNESS ─────────────────────────────────────────────────────────────────────────
// The pre-call gate's routine arm fired a background summarise whenever more than 30
// unsummarised rows sat outside the newest N rows, "regardless of token level". After t94 the
// live view is every row since the compaction boundary, so those rows were IN VIEW: the agent
// was reading them word for word while they were folded into a summary, and the cache broke
// behind the summaries lane every time. A busy agent with a mailbox crosses 30 rows within a
// handful of small asks, so a small ask on a quiet window condensed.
//
// ── THE DOOR ────────────────────────────────────────────────────────────────────────────
// `runPreCallGates` — the engine's pre-call step, exactly as the driver calls it — against a
// REAL migrated database, the real compaction trigger, the real tail horizon and the real
// leaf compaction. Mocked: the summariser's model call (its text is not the subject), the
// vault archive (a file write), the websocket. A background condense is awaited by watching
// the same one-per-agent latch the gate sets, so "nothing was condensed" is never read before
// a condense could have finished.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { WsEvent } from '@dojo/shared';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: vi.fn(), stampPersistedRow: (e: unknown) => e }));

vi.mock('../../../../../tools/tool-docs.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  measureAgentToolPayloadTokens: async () => 2_000,
}));

const generateSummarySpy = vi.fn();
vi.mock('../../../../../memory/summarize.js', () => ({
  generateSummary: (...args: unknown[]) => generateSummarySpy(...args),
}));

vi.mock('../../../../../vault/archive.js', () => ({
  archiveMessagesBeforeCompaction: vi.fn(() => 'archive-1'),
  isDreamerIgnored: vi.fn(() => false),
  getArchiveHighWaterMark: vi.fn(() => null),
}));

vi.mock('../../../../../config/platform.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isSystemServiceAgent: vi.fn(() => false),
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { insertMessage } from '../../../../../memory/message-store.js';
import { backgroundDrains, pendingWakeups, stoppedAgents, turnContinuationCounts } from '../../../../shared-state.js';
import { __resetBrakesForTests } from '../../../../../memory/compaction-brakes.js';
import { __resetEstimateCacheForTests } from '../../../../../memory/assembled-estimate-cache.js';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runPreCallGates, PRE_CALL_GATES_PHASE, type PreCallGatesContext } from '../index.js';
import type { TurnCounterparty } from '../../../counterparty.js';

const AGENT = 'agent-t140-busy';
const MODEL = 'm-t140-200k';
const WINDOW = 200_000;   // getFreshTailCount(200_000) === 80 rows

const db = (): Database.Database => mockDb.current!;

function seedAgent(): void {
  db().prepare(
    `INSERT INTO providers (id, name, type, auth_type) VALUES ('p-t140', 'P', 'openai-compatible', 'api_key')`,
  ).run();
  db().prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled)
     VALUES (?, 'p-t140', 'Roomy', 'roomy', '["text","tools"]', ?, 4096, 1)`,
  ).run(MODEL, WINDOW);
  db().prepare(
    `INSERT INTO agents (id, name, model_id, status, config, created_at) VALUES (?, 'Busy Desk', ?, 'idle', '{}', datetime('now'))`,
  ).run(AGENT, MODEL);
}

/** A busy, aged inbox: many small inbound notices and short exchanges, all tiny in tokens. */
function seedBusyHistory(rows: number): void {
  for (let i = 0; i < rows; i++) {
    if (i % 3 === 0) {
      insertMessage({
        agentId: AGENT, role: 'user', lane: 'owner', senderId: 'mailbox', authorized: false,
        content: `[SOURCE: GMAIL NOTIFICATION] New email ${i}: shipping update for order ${i}.`, turnNumber: 1 + Math.floor(i / 3),
      });
    } else if (i % 3 === 1) {
      insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `Quick one ${i}: is the dock open?`, turnNumber: 1 + Math.floor(i / 3) });
    } else {
      insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: `Yes, the dock is open (${i}).`, turnNumber: 1 + Math.floor(i / 3) });
    }
  }
}

function summaryCount(): number {
  return (db().prepare('SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ?').get(AGENT) as { n: number }).n;
}

const OWNER: TurnCounterparty = { kind: 'user', displayName: 'TestUser', id: 'owner' } as TurnCounterparty;

function freshState(): AgentTurnState {
  const s = initState({
    agentId: AGENT, contextWindow: WINDOW, isAutoRouted: false, configuredModelId: MODEL,
    turnNumber: 99, triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
    lastUserMessageContent: 'is the dock open?', lastUserMessageId: null,
    inboundChannel: 'dashboard', inboundContext: null, pendingTechniqueAck: null,
  });
  return advance(s, { phase: PRE_CALL_GATES_PHASE, loopCount: 1 });
}

function makeCtx(): PreCallGatesContext & { events: WsEvent[] } {
  const events: WsEvent[] = [];
  const ctx = {
    agentId: AGENT, turnNumber: 99, contextWindow: WINDOW, contextModelId: MODEL,
    configuredModelId: MODEL, isAutoRouted: false, counterparty: OWNER,
    assemblerOverheadTokens: 0, engineBlockEscapeHatch: '[escape hatch]',
    broadcast: (event: WsEvent) => { events.push(event); },
    stashContinuationIfHuman: vi.fn(),
    detectTaskThrashing: vi.fn(() => ({ thrashing: false })),
  } as unknown as PreCallGatesContext;
  return Object.assign(ctx, { events });
}

/** Wait until no background condense is in flight for this agent (bounded). */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 5));
    if (!backgroundDrains.has(AGENT)) return;
  }
  throw new Error('a background condense never settled');
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  backgroundDrains.clear();
  pendingWakeups.clear();
  stoppedAgents.clear();
  turnContinuationCounts.clear();
  __resetBrakesForTests();
  __resetEstimateCacheForTests();
  generateSummarySpy.mockReset();
  generateSummarySpy.mockImplementation(async () => ({ ok: true, text: 'Earlier dock questions, all answered.', tokenCount: 9 }));
  seedAgent();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t140 W2 — a small ask on an aged, busy agent condenses nothing', () => {
  it('RED at 00a2b34d: 150 tiny rows, no token pressure, and the gate still fires a summarise', async () => {
    seedBusyHistory(150);
    const out = await runPreCallGates(freshState(), makeCtx());
    expect(out.directive).toBe('proceed');
    await settle();
    expect(generateSummarySpy, 'no summariser call: the view is nowhere near full and nothing is leaving it').not.toHaveBeenCalled();
    expect(summaryCount()).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// THE TWO CAUSES THAT DO CONDENSE — each folds exactly the rows leaving the view.
// ════════════════════════════════════════════════════════════════════════════════════════

/** Rows a summary covers, by seq order: the first N seqs of the agent's history, or not. */
function summarisedSeqs(agentId: string): number[] {
  return (db().prepare(
    `SELECT m.seq AS seq FROM messages m JOIN summary_messages sm ON sm.message_id = m.id
      WHERE m.agent_id = ? ORDER BY m.seq`,
  ).all(agentId) as Array<{ seq: number }>).map((r) => r.seq);
}
function allSeqs(agentId: string): number[] {
  return (db().prepare('SELECT seq FROM messages WHERE agent_id = ? ORDER BY seq').all(agentId) as Array<{ seq: number }>)
    .map((r) => r.seq);
}

describe('t140 — rows ABOUT TO LEAVE the view are folded before the ceiling cuts them', () => {
  it('one trim block short of the row ceiling, the gate folds exactly the step the ceiling would cut, and nothing newer', async () => {
    // 200K window: row floor 80, ceiling 640, ceiling step 320, lead one block (40 rows).
    // 610 tiny rows: the view is nowhere near full, so the CEILING is the only cause.
    seedBusyHistory(610);
    const out = await runPreCallGates(freshState(), makeCtx());
    expect(out.directive).toBe('proceed');
    await settle();

    const seqs = allSeqs(AGENT);
    const folded = summarisedSeqs(AGENT);
    expect(folded, 'exactly the rows the ceiling\'s next cut would skip: the oldest 320').toEqual(seqs.slice(0, 320));
    // The 290 newest rows — everything the agent is still reading — are untouched.
    expect(folded.some((q) => q > seqs[319])).toBe(false);
  });

  it('BACKWARDS LIFECYCLE — a box upgraded with a 1,000-row unsummarised backlog catches up in ONE fold of what the ceiling is already cutting', async () => {
    // Past the ceiling already (640 on this window): the horizon is cutting 640 rows today
    // (`ceilingSkipRows(1000)`), so those rows have left the view and are owed their summary.
    seedBusyHistory(1000);
    await runPreCallGates(freshState(), makeCtx());
    await settle();
    const seqs = allSeqs(AGENT);
    expect(summarisedSeqs(AGENT)).toEqual(seqs.slice(0, 640));
    // And the next gate finds nothing more leaving: 360 rows is under the ceiling's lead.
    generateSummarySpy.mockClear();
    await runPreCallGates(freshState(), makeCtx());
    await settle();
    expect(generateSummarySpy).not.toHaveBeenCalled();
  });

  it('far from the ceiling and with room in the window, the same gate folds nothing', async () => {
    seedBusyHistory(300);
    await runPreCallGates(freshState(), makeCtx());
    await settle();
    expect(summarisedSeqs(AGENT)).toEqual([]);
  });
});

describe('t140 — when the view is FULL for the dialed window, only the rows the trim would take are folded', () => {
  const SMALL_AGENT = 'agent-t140-small-window';
  const SMALL_MODEL = 'm-t140-32k';
  const SMALL_WINDOW = 32_000;   // row floor 40, trim block 20

  function seedSmallAgent(rows: number): void {
    db().prepare(
      `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled)
       VALUES (?, 'p-t140', 'Snug', 'snug', '["text","tools"]', ?, 4096, 1)`,
    ).run(SMALL_MODEL, SMALL_WINDOW);
    db().prepare(
      `INSERT INTO agents (id, name, model_id, status, config, created_at) VALUES (?, 'Snug Desk', ?, 'idle', '{}', datetime('now'))`,
    ).run(SMALL_AGENT, SMALL_MODEL);
    const body = 'The north dock tally, row by row, with the damaged lids noted beside each stack. '.repeat(12);
    for (let i = 0; i < rows; i++) {
      insertMessage({
        agentId: SMALL_AGENT, role: i % 2 === 0 ? 'user' : 'assistant', lane: 'owner',
        senderId: i % 2 === 0 ? 'owner' : null, content: `[row ${i}] ${body}`, turnNumber: 1 + Math.floor(i / 2),
      });
    }
  }

  it('a full 32K view folds the front half in whole blocks — 40 of 100 rows — and keeps the newest 60 verbatim', async () => {
    seedSmallAgent(100);   // ~25K tokens of live tail against a ~13K content budget: full
    const state = advance(initState({
      agentId: SMALL_AGENT, contextWindow: SMALL_WINDOW, isAutoRouted: false, configuredModelId: SMALL_MODEL,
      turnNumber: 60, triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
      lastUserMessageContent: 'tally?', lastUserMessageId: null,
      inboundChannel: 'dashboard', inboundContext: null, pendingTechniqueAck: null,
    }), { phase: PRE_CALL_GATES_PHASE, loopCount: 1 });
    const ctx = Object.assign(makeCtx(), {
      agentId: SMALL_AGENT, contextWindow: SMALL_WINDOW, contextModelId: SMALL_MODEL, configuredModelId: SMALL_MODEL,
    });
    const out = await runPreCallGates(state, ctx);
    expect(out.directive).toBe('proceed');
    for (let i = 0; i < 200 && backgroundDrains.has(SMALL_AGENT); i++) await new Promise((r) => setTimeout(r, 5));

    const seqs = allSeqs(SMALL_AGENT);
    const folded = summarisedSeqs(SMALL_AGENT);
    // maxTrimUnits(100 rows, block 20) = floor(50 / 20) × 20 = 40: the token trim's own bound.
    expect(folded).toEqual(seqs.slice(0, 40));
    expect(folded.some((q) => q > seqs[39]), 'the newest 60 rows are the live view and stay raw').toBe(false);
  });
});
