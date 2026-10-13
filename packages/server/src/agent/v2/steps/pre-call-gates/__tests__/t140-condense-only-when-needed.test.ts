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
import { rowsLeavingView } from '../../../../../memory/tail-horizon.js';
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

  it('a fold never splits a tool_use from its tool_result: it extends by the one paired row', async () => {
    // Row 320 (the first row the fold would KEEP) is the tool result of row 319's call.
    seedBusyHistory(319);
    insertMessage({
      agentId: AGENT, role: 'assistant', lane: 'owner', turnNumber: 120,
      content: JSON.stringify([{ type: 'tool_use', id: 'call-dock', name: 'dock_status', input: {} }]),
    });
    insertMessage({
      agentId: AGENT, role: 'tool', lane: 'owner', turnNumber: 120,
      content: JSON.stringify([{ type: 'tool_result', tool_use_id: 'call-dock', content: 'open' }]),
    });
    seedBusyHistory(290);
    await runPreCallGates(freshState(), makeCtx());
    await settle();
    const seqs = allSeqs(AGENT);
    expect(summarisedSeqs(AGENT), 'the step (320 rows) plus the tool result paired with its last row').toEqual(seqs.slice(0, 321));
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

  it('THE FLOOR (fix round 1, I4): a full view with less than one trim block above the floor folds NOTHING', async () => {
    // 50 heavy rows: full, but only 10 rows sit above the 40-row floor — the pressure is INSIDE
    // the floor. Before fix round 1 the trigger folded those 10 (and then 1–5 rows every turn
    // after, one summariser call and one prefix break each). Now it answers null and the token
    // trim handles the floor's overflow, as it always has.
    seedSmallAgent(50);
    const state = advance(initState({
      agentId: SMALL_AGENT, contextWindow: SMALL_WINDOW, isAutoRouted: false, configuredModelId: SMALL_MODEL,
      turnNumber: 30, triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
      lastUserMessageContent: 'tally?', lastUserMessageId: null,
      inboundChannel: 'dashboard', inboundContext: null, pendingTechniqueAck: null,
    }), { phase: PRE_CALL_GATES_PHASE, loopCount: 1 });
    const ctx = Object.assign(makeCtx(), {
      agentId: SMALL_AGENT, contextWindow: SMALL_WINDOW, contextModelId: SMALL_MODEL, configuredModelId: SMALL_MODEL,
    });
    expect(rowsLeavingView(SMALL_AGENT, { freshTailCount: 40 }, { viewFull: true })).toBeNull();
    await runPreCallGates(state, ctx);
    for (let i = 0; i < 200 && backgroundDrains.has(SMALL_AGENT); i++) await new Promise((r) => setTimeout(r, 5));
    expect(summarisedSeqs(SMALL_AGENT)).toEqual([]);
    expect(generateSummarySpy).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// FIX ROUND 1 — I2: the gate measures the window of the model the loop has LOCKED; I3: the
// summary is still written by the owner's compaction model, else the cheapest text model —
// never by the (possibly expensive) routed model that happens to be locked.
// ════════════════════════════════════════════════════════════════════════════════════════
describe('t140 fix round 1 — an auto-routed tool loop locked to a small, expensive model', () => {
  const ROUTED_AGENT = 'agent-t140-routed-loop';
  const LOCKED = 'm-t140-locked-32k';
  const CHEAP = 'm-t140-cheap-writer';
  const OWNER_PICK = 'm-t140-owner-compaction';

  function seedRoutedLoop(): void {
    const model = db().prepare(
      `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, input_cost_per_m, output_cost_per_m)
       VALUES (?, 'p-t140', ?, ?, '["text","tools"]', ?, 4096, 1, ?, ?)`,
    );
    model.run(LOCKED, 'Locked Heavy', 'locked', 32_000, 15, 75);
    model.run(CHEAP, 'Cheap Writer', 'cheap', 32_000, 0.1, 0.4);
    model.run(OWNER_PICK, 'Owner Compaction Pick', 'owner-pick', 32_000, 1, 2);
    db().prepare('UPDATE models SET input_cost_per_m = 5 WHERE id = ?').run(MODEL);
    db().prepare(
      `INSERT INTO agents (id, name, model_id, status, config, created_at) VALUES (?, 'Routed Desk', 'auto', 'idle', '{}', datetime('now'))`,
    ).run(ROUTED_AGENT);
    const body = 'The north dock tally, row by row, with the damaged lids noted beside each stack. '.repeat(12);
    for (let i = 0; i < 100; i++) {
      insertMessage({
        agentId: ROUTED_AGENT, role: i % 2 === 0 ? 'user' : 'assistant', lane: 'owner',
        senderId: i % 2 === 0 ? 'owner' : null, content: `[row ${i}] ${body}`, turnNumber: 1 + Math.floor(i / 2),
      });
    }
  }

  async function gateLocked(): Promise<void> {
    const s = advance(initState({
      agentId: ROUTED_AGENT, contextWindow: 200_000, isAutoRouted: true, configuredModelId: 'auto',
      turnNumber: 60, triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
      lastUserMessageContent: 'tally?', lastUserMessageId: null,
      inboundChannel: 'dashboard', inboundContext: null, pendingTechniqueAck: null,
    }), { phase: PRE_CALL_GATES_PHASE, loopCount: 3, lockedModelId: LOCKED, lockedTier: 'heavy' });
    // The turn's own window is the roomy provisional one (200K); only the LOCK says 32K.
    const ctx = Object.assign(makeCtx(), {
      agentId: ROUTED_AGENT, contextWindow: 200_000, contextModelId: '__auto__', configuredModelId: 'auto', isAutoRouted: true,
    });
    await runPreCallGates(s, ctx);
    for (let i = 0; i < 200 && backgroundDrains.has(ROUTED_AGENT); i++) await new Promise((r) => setTimeout(r, 5));
  }

  it('I2: the view is full for the LOCKED 32K model (not for the 200K provisional window), and the front half is folded', async () => {
    seedRoutedLoop();
    await gateLocked();
    const seqs = allSeqs(ROUTED_AGENT);
    expect(summarisedSeqs(ROUTED_AGENT)).toEqual(seqs.slice(0, 40));
  });

  it('I3: with no compaction model set, the summary is written by the CHEAPEST text model, not the locked one', async () => {
    seedRoutedLoop();
    await gateLocked();
    expect(generateSummarySpy).toHaveBeenCalled();
    const writers = generateSummarySpy.mock.calls.map((c) => (c[0] as { modelId?: string }).modelId);
    expect(new Set(writers)).toEqual(new Set([CHEAP]));
  });

  it('I3: with a compaction model set in Settings, that model writes the summary', async () => {
    seedRoutedLoop();
    db().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('compaction_model_id', ?)").run(OWNER_PICK);
    await gateLocked();
    const writers = generateSummarySpy.mock.calls.map((c) => (c[0] as { modelId?: string }).modelId);
    expect(writers.length).toBeGreaterThan(0);
    expect(new Set(writers)).toEqual(new Set([OWNER_PICK]));
  });
});

describe('t140 round 3 — the gate replaces placeholder notes once a writer is eligible', () => {
  it('rows covered by a not-yet-condensed note get their real summary from the next gate, in the background', async () => {
    seedBusyHistory(30);
    const { writeUncondensedPlaceholders, hasUncondensedPlaceholders } = await import('../../../../../memory/uncondensed-placeholder.js');
    const tenth = (db().prepare('SELECT seq FROM messages WHERE agent_id = ? ORDER BY seq ASC LIMIT 1 OFFSET 9').get(AGENT) as { seq: number }).seq;
    expect(writeUncondensedPlaceholders(AGENT, tenth), 'precondition: ten rows covered by placeholder notes').toBe(10);
    const out = await runPreCallGates(freshState(), makeCtx());
    expect(out.directive).toBe('proceed');
    await settle();
    expect(generateSummarySpy, 'the replacement dialed a writer').toHaveBeenCalled();
    expect(hasUncondensedPlaceholders(AGENT), 'no placeholder note left').toBe(false);
  });
});

describe('t140 round 4, re-aimed round 7 — the gate\'s background fold runs to its end; no turn cancels it', () => {
  // Round 4 made this fold preemptible by the turn's own fold; round 7 (re-review I2') removed that:
  // setting it aside threw a working summary away and the turn labelled anyway. The fold's calls carry
  // no abort a turn could pull, and a slow writer's summary lands.
  it('a routine fold the gate started is handed no turn-owned abort, and its slow writer\'s summary lands', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    generateSummarySpy.mockImplementation(async (args: { abortSignal?: AbortSignal }) => {
      seen.push(args.abortSignal);
      await new Promise((r) => setTimeout(r, 50));
      return { ok: true, content: 'The dock opens at nine; the crane is booked.' };
    });
    seedBusyHistory(610);   // the ceiling cause: the gate starts a background fold
    await runPreCallGates(freshState(), makeCtx());
    expect(backgroundDrains.has(AGENT), 'precondition: a background fold is running').toBe(true);
    await settle();
    expect(seen.length, 'the fold dialled its writer').toBeGreaterThan(0);
    expect(seen.every((sig) => sig === undefined), 'no abort a turn could pull').toBe(true);
    expect(backgroundDrains.has(AGENT), 'it ran to its end').toBe(false);
  });
});
