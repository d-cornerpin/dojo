// ════════════════════════════════════════════════════════════════════════════════════════
// T84 (ANSWER-ANYWAY) — THE TURN-TIME BUDGET STOPS OVERRULING THE TOKEN MATH.
//
// THE INCIDENT (release ritual v3.1.26 round 5, blast `bmubdye4z6r`, subject `a504e5c9`,
// 2026-09-21 15:42:05Z). The 15-minute checkpoint fired after two HONEST full re-prefills
// (35K tokens at the provider's own declared 180 tok/s — roughly 400s of the 900s), and the
// `{force:true}` it passed into `checkAndCompact` ran a full reactive compaction on an
// assembly of 13,649 against a threshold of 51,300: 27% fill, with the engine's own log line
// reading `needsCompactionByTokens: false`. The agent came back severed from the half of a
// two-part ask it had not yet answered, and never delivered it.
//
// WHAT THIS FILE DRIVES, AND WHY IT IS NOT THE CONTRACT TEST. `contract.test.ts` mocks
// `checkAndCompact`, so it can only ever assert what the checkpoint ASKS for. The defect was
// not in the asking — it was that a wall-clock reason was allowed to answer a question only
// the token math can answer. So this file runs the REAL `checkAndCompact` against a REAL
// (in-memory, migrated) database, with the incident's own provider declaration and its own
// assembled total, and asks what actually happened to the agent's history.
//
// What is real: the DB, the message rows, the provider/model join `getProviderCeilingTokens`
// reads, `runCheckAndCompact`'s whole trigger and all three yield guards, `runLeafCompaction`,
// the park message the checkpoint writes, the continuation counter. What is mocked: the
// summarizer LLM call, the vault archive, the websocket — none of them participates in the
// decision this file is about.
//
// THE MUTANT THIS FILE IS PROVEN AGAINST: put `{ force: true }` back on the
// `checkAndCompact` call in `turn-budget.ts` and the two "far under the threshold" clauses go
// RED — a real summary row appears and the raw history stops being intact. That is the whole
// defect, in one flag.
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
}));

vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

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
import { turnContinuationCounts, pendingWakeups, stoppedAgents } from '../../../../shared-state.js';
import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runTurnTimeBudget } from '../turn-budget.js';
import { PRE_CALL_GATES_PHASE, type PreCallGatesContext } from '../index.js';
import type { TurnCounterparty } from '../../../counterparty.js';

const AGENT = 'agent-t84-turn-budget';
const MODEL = 'test-model';
const CONTEXT_WINDOW = 200_000; // getFreshTailCount(200_000) === 80

// The incident's own provider declaration: 600s of declared patience at a declared 180 tok/s.
// `getProviderCeilingTokens` turns that pair into the provider-aware ceiling the compaction
// trigger has keyed on since T82a — 51,300 for this row, the exact threshold in the incident's
// log line.
const DECLARED_PATIENCE_MS = 600_000;
const DECLARED_TOKENS_PER_SEC = 180;
const PROVIDER_AWARE_THRESHOLD = 51_300;

const FRESH_TAIL_ROWS = 80;
// 80 × 170 = 13,600 — the incident's assembled total (13,649) to within rounding, and 26.5% of
// the provider-aware threshold above.
const UNDER_THRESHOLD_TOKENS_EACH = 170;
// 80 × 750 = 60,000 — genuinely over the provider-aware threshold, so the token math itself
// asks for the compaction. This is the (b) arm: the path this fix does not touch.
const OVER_THRESHOLD_TOKENS_EACH = 750;

// Ten rows OLDER than the fresh tail. They are the reason a failure here is unambiguous:
// MIN_COMPACTABLE_ROWS is 6, so there IS a compactable region — "nothing happened" can never be
// explained away as "there was nothing to compact". And 10 is under UNCOMPACTED_GAP_THRESHOLD
// (30), so the routine GAP trigger cannot fire either, isolating the TOKEN trigger as the only
// thing in the tree that can rebuild this history.
const OUTSIDE_TAIL_ROWS = 10;

function seed(opts: { declareCeiling: boolean; tailTokensEach: number }): void {
  const db = mockDb.current!;
  db.prepare(`INSERT INTO agents (id, name, status, created_at) VALUES (?, ?, 'idle', datetime('now'))`)
    .run(AGENT, 'Turn Budget Test');
  db.prepare(`
    INSERT INTO providers (id, name, type, auth_type, first_chunk_timeout_ms, prefill_tokens_per_sec)
    VALUES ('testprov', 'Test', 'openai', 'api_key', ?, ?)
  `).run(
    opts.declareCeiling ? DECLARED_PATIENCE_MS : null,
    opts.declareCeiling ? DECLARED_TOKENS_PER_SEC : null,
  );
  db.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, is_enabled, capabilities, input_cost_per_m, context_window)
    VALUES (?, 'testprov', 'Test Model', ?, 1, '["text"]', 1, ?)
  `).run(MODEL, MODEL, CONTEXT_WINDOW);

  const insert = db.prepare(`
    INSERT INTO messages (id, agent_id, role, content, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, (unixepoch('2026-09-21T00:00:00Z') + ?) * 1000)
  `);
  let i = 0;
  for (let n = 0; n < OUTSIDE_TAIL_ROWS; n++, i++) {
    insert.run(`outside-${n}`, AGENT, n % 2 === 0 ? 'user' : 'assistant', `Older message ${n}`, 500, i);
  }
  for (let n = 0; n < FRESH_TAIL_ROWS; n++, i++) {
    insert.run(`tail-${n}`, AGENT, n % 2 === 0 ? 'user' : 'assistant', `Recent message ${n}: filler`, opts.tailTokensEach, i);
  }
}

/** Every raw conversation row still on the record, by id. */
function rawHistoryIds(): string[] {
  return (mockDb.current!
    .prepare(`SELECT id FROM messages WHERE agent_id = ? AND role IN ('user','assistant') ORDER BY created_at`)
    .all(AGENT) as Array<{ id: string }>).map((r) => r.id);
}

/** How many summary rows the compaction machinery has written for this agent. */
function summaryCount(): number {
  return (mockDb.current!
    .prepare(`SELECT COUNT(*) AS n FROM summaries WHERE agent_id = ?`)
    .get(AGENT) as { n: number }).n;
}

/** The last `[System: …]` row the checkpoint wrote — the person's receipt. */
function lastSystemMessage(): string | null {
  const row = mockDb.current!
    .prepare(`SELECT content FROM messages WHERE agent_id = ? AND role = 'system' ORDER BY rowid DESC LIMIT 1`)
    .get(AGENT) as { content: string } | undefined;
  return row?.content ?? null;
}

const OWNER: TurnCounterparty = { kind: 'user', displayName: 'TestUser', id: 'owner' } as TurnCounterparty;

/** The state as the driver hands it over, with the turn already past its 15-minute budget. */
function stateOverBudget(overrides: Partial<AgentTurnState> = {}): AgentTurnState {
  const fresh = initState({
    agentId: AGENT,
    contextWindow: CONTEXT_WINDOW,
    isAutoRouted: false,
    configuredModelId: MODEL,
    turnNumber: 3,
    triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null,
    lastUserMessageContent: 'answer both of these in one reply',
    lastUserMessageId: 'msg-1',
    inboundChannel: 'dashboard',
    inboundContext: null,
    pendingTechniqueAck: null,
  });
  return advance(fresh, {
    phase: PRE_CALL_GATES_PHASE,
    loopCount: 1,
    turnStartMs: Date.now() - (16 * 60 * 1000),
    ...overrides,
  });
}

function makeCtx(): PreCallGatesContext & { events: WsEvent[] } {
  const events: WsEvent[] = [];
  const ctx = {
    agentId: AGENT,
    turnNumber: 3,
    contextWindow: CONTEXT_WINDOW,
    contextModelId: MODEL,
    configuredModelId: MODEL,
    isAutoRouted: false,
    counterparty: OWNER,
    assemblerOverheadTokens: 0,
    engineBlockEscapeHatch: '[escape hatch]',
    broadcast: (event: WsEvent) => { events.push(event); },
    stashContinuationIfHuman: vi.fn(),
    detectTaskThrashing: vi.fn(() => ({ thrashing: false })),
  } as unknown as PreCallGatesContext;
  return Object.assign(ctx, { events });
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  turnContinuationCounts.clear();
  pendingWakeups.clear();
  stoppedAgents.clear();
  generateSummarySpy.mockReset();
  generateSummarySpy.mockImplementation(async () => ({ ok: true, text: 'A summary of the older span.', tokenCount: 12 }));
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
  turnContinuationCounts.clear();
  pendingWakeups.clear();
  vi.clearAllMocks();
});

describe('T84 — the 15-minute checkpoint compacts only when the token math asks for it', () => {
  it('THE INCIDENT, reproduced: at 27% of the provider-aware threshold the checkpoint rebuilds NOTHING, and the history survives', async () => {
    // This is `a504e5c9` at 15:42:05, on a fixture that reproduces its numbers: a declared
    // 600s/180tps box (threshold 51,300) carrying an assembled tail of ~13,600. Under the old
    // `{force:true}` this ran a full reactive compaction and severed the agent from the ask it
    // still owed. The ONLY input that changed between the healthy calls and this one was the
    // clock.
    seed({ declareCeiling: true, tailTokensEach: UNDER_THRESHOLD_TOKENS_EACH });
    const before = rawHistoryIds();
    expect(FRESH_TAIL_ROWS * UNDER_THRESHOLD_TOKENS_EACH).toBeLessThan(PROVIDER_AWARE_THRESHOLD);

    const out = await runTurnTimeBudget(stateOverBudget(), makeCtx());

    // No rebuild, by the two measurements that cannot be faked: no summary was written, and
    // the summarizer was never dialled at all.
    expect(summaryCount()).toBe(0);
    expect(generateSummarySpy).not.toHaveBeenCalled();
    // And the agent's own history is byte-for-byte the one it had — the half-served ask
    // included.
    expect(rawHistoryIds()).toEqual(before);

    // THE AUTO-CONTINUE IS UNCHANGED, which is the other half of the requirement: the turn
    // still parks, the person is still told, the wakeup is still queued.
    expect(out).toMatchObject({ directive: 'exit', reason: 'turn-time-budget' });
    expect(pendingWakeups.has(AGENT)).toBe(true);
    expect(turnContinuationCounts.get(AGENT)).toBe(1);
    expect(lastSystemMessage()).toContain('Pausing here and continuing on a fresh turn (1 of 3)');
  });

  it('and the receipt tells the truth: no rebuild happened, so the park message does not claim one', async () => {
    // The engine claiming a rebuild it did not perform is the same class of untruth the
    // incident was filed over ("the work ledger records a delivery claim that did not
    // happen"). The re-homed recap content the person is owed — pick up where you left off,
    // do not start over — rides both arms unchanged.
    seed({ declareCeiling: true, tailTokensEach: UNDER_THRESHOLD_TOKENS_EACH });

    await runTurnTimeBudget(stateOverBudget(), makeCtx());

    const sys = lastSystemMessage()!;
    expect(sys).not.toContain('has been summarized');
    expect(sys).toContain('Your conversation history is intact, pick up where you left off');
    expect(sys).toContain('do not start over');
  });

  it('an UNDECLARED provider, far under the flat threshold: same answer — the clock is not evidence about size', async () => {
    // The arm that proves the fix is not merely "the provider-aware ceiling governs". With no
    // declaration at all the threshold is the standing 96% of 200K (192,000) and the 60,000
    // assembled here is nowhere near it, so nothing is rebuilt here either.
    seed({ declareCeiling: false, tailTokensEach: OVER_THRESHOLD_TOKENS_EACH });
    const before = rawHistoryIds();

    const out = await runTurnTimeBudget(stateOverBudget(), makeCtx());

    expect(summaryCount()).toBe(0);
    expect(generateSummarySpy).not.toHaveBeenCalled();
    expect(rawHistoryIds()).toEqual(before);
    expect(out).toMatchObject({ directive: 'exit', reason: 'turn-time-budget' });
    expect(pendingWakeups.has(AGENT)).toBe(true);
  });

  it('THE TOKEN PATH IS UNTOUCHED: genuinely over the provider-aware threshold, the checkpoint still compacts', async () => {
    // The control that keeps this fix from being a deletion. Same checkpoint, same clock, same
    // fixture shape — only the SIZE differs (60,000 against the same 51,300) — and the
    // compaction the 2026-04-29 requirement was written for still runs, unasked-for `force`
    // nowhere in sight.
    seed({ declareCeiling: true, tailTokensEach: OVER_THRESHOLD_TOKENS_EACH });
    expect(FRESH_TAIL_ROWS * OVER_THRESHOLD_TOKENS_EACH).toBeGreaterThan(PROVIDER_AWARE_THRESHOLD);

    const out = await runTurnTimeBudget(stateOverBudget(), makeCtx());

    expect(generateSummarySpy).toHaveBeenCalled();
    expect(summaryCount()).toBeGreaterThan(0);
    // And THIS receipt says the thing that is now true of it, in the bytes it always used.
    expect(lastSystemMessage()).toContain('Your earlier conversation has been summarized, pick up where you left off');
    expect(out).toMatchObject({ directive: 'exit', reason: 'turn-time-budget' });
    expect(pendingWakeups.has(AGENT)).toBe(true);
  });

  it('THE CONTINUATION LADDER IS UNTOUCHED: the count climbs on every park, and the cap still trips without compacting', async () => {
    // Ticket clause (d), driven rather than read: the fix is about WHAT the checkpoint does to
    // the history, never about how many times it may do it. An undeclared provider caps at 3.
    seed({ declareCeiling: true, tailTokensEach: UNDER_THRESHOLD_TOKENS_EACH });

    await runTurnTimeBudget(stateOverBudget(), makeCtx());
    expect(turnContinuationCounts.get(AGENT)).toBe(1);
    await runTurnTimeBudget(stateOverBudget(), makeCtx());
    expect(turnContinuationCounts.get(AGENT)).toBe(2);
    await runTurnTimeBudget(stateOverBudget(), makeCtx());
    expect(turnContinuationCounts.get(AGENT)).toBe(3);

    // The fourth crossing is one too many: the turn STOPS, the counter is cleared, and — as
    // before this task — the trip arm never reaches a compaction at all.
    const capped = await runTurnTimeBudget(stateOverBudget(), makeCtx());
    expect(capped).toMatchObject({ directive: 'exit', reason: 'turn-continuation-cap' });
    expect(turnContinuationCounts.has(AGENT)).toBe(false);
    expect(generateSummarySpy).not.toHaveBeenCalled();
    expect(summaryCount()).toBe(0);
  });
});
