// ════════════════════════════════════════════════════════════════════════════════════════
// t140 fix round 1 — C1 and I4 (review `overhaul-plans/t140-review.md`).
//
// C1: the "view is full" check measured each live row CAPPED at the gate's 4K, while the token
// trim that takes rows off the front of the view costs each row at its REAL size. On an agent
// whose conversation carries large rows (a file read, a long paste) the trim kept setting
// unsummarised rows aside for a hundred turns or more before any fold — the lane's own named
// risk ("summaries must exist before a row leaves the view"), measured by the reviewer at 130
// trimmed turns on a 128K window with a ~12K row every 10 turns.
//
// I4: once the pressure sits inside the newest-row floor, a "full" fold clamped to the few rows
// above the floor folds 1–5 rows on EVERY turn — one summariser call and one prefix break each,
// the "condenses on every small ask" shape coming back.
//
// THE DOORS, the t94 instrument's own: the real assembler, the real tail horizon, the real
// `liveViewIsFull` / `rowsLeavingView` / `checkAndCompact`, a migrated DB; the routine gate is
// driven the way `context-gates.ts` drives it (awaited here, so a run is deterministic) and only
// the summariser's text is scripted. "Trimmed" means the assembler set rows after the boundary
// aside (`freshTailDropped > 0`) — rows leaving the view with no summary.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => new Float32Array([1, 0, 0, 0]),
  queueEmbedding: () => { /* not exercised */ },
  storeEmbedding: async () => { /* not exercised */ },
  refreshEmbedding: () => { /* not exercised */ },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* not exercised */ } }));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 1000 }));

const windowNow = { value: 32_000 };
const summariser = { calls: 0 };
vi.mock('../../agent/model.js', () => ({
  callModel: async () => {
    summariser.calls++;
    return { content: 'Earlier the crew counted the depot and filed the long manifests.', toolCalls: [], usage: {} };
  },
  getContextWindow: () => windowNow.value,
  getModelOutputCap: () => 4096,
  getProviderCeilingTokens: () => null,
}));

import { assembleContext } from '../assembler.js';
import { insertMessage } from '../message-store.js';
import { checkAndCompact, estimateAssembledTokens, liveViewIsFull } from '../compaction.js';
import { __resetBrakesForTests } from '../compaction-brakes.js';
import { getFreshTailCount, estimateTokens } from '../budget.js';
import { rowsLeavingView, tailTrimBlockGroups } from '../tail-horizon.js';
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-t140-large-rows';
const MODEL = 'model-t140-large-rows';
const db = (): Database.Database => mockDb.current!;

/** A fictional manifest, ~12K tokens at the /4 estimator: the shape of a file read. */
const LARGE = 'Manifest line: crate, bay, weight, seal number, inspector initials, remarks. '.repeat(620);

let turnNo = 0;
function appendTurn(large: boolean): void {
  turnNo++;
  db().prepare(
    `INSERT OR IGNORE INTO turns (agent_id, turn_number, kind, started_at, ended_at, exit_reason, answered)
     VALUES (?, ?, 'user', datetime('now'), NULL, NULL, 0)`,
  ).run(AGENT, turnNo);
  // Each row carries its OWN marker ([u7] / [a7]), so round 2's direct count can tell which
  // rows the assembled view holds without asking the assembler.
  insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `[t${turnNo}] [u${turnNo}] Which bay is the next crate for?`, turnNumber: turnNo });
  insertMessage({
    agentId: AGENT, role: 'assistant', lane: 'owner', turnNumber: turnNo,
    content: `[t${turnNo}] [a${turnNo}] ${large ? LARGE : 'Bay four, beside the ramp; the seal is intact and the weight is on the sheet.'}`,
  });
}

interface RunLog { trimmedTurns: number[]; folds: Array<{ turn: number; rows: number }> }

/** The production pre-call gate's routine arm, then the assembly — once per turn. */
async function drive(turns: number, largeEvery: number): Promise<RunLog> {
  const log: RunLog = { trimmedTurns: [], folds: [] };
  let lastSystemTokens = 0;
  for (let t = 1; t <= turns; t++) {
    appendTurn(t % largeEvery === 0);
    const est = await estimateAssembledTokens(AGENT, windowNow.value, MODEL);
    const leaving = rowsLeavingView(AGENT, { freshTailCount: getFreshTailCount(windowNow.value) },
      { viewFull: liveViewIsFull(est, lastSystemTokens) });
    if (leaving) {
      const r = await checkAndCompact(AGENT, MODEL, windowNow.value, { leaving, maxChunksPerRun: 10 });
      if (r.leafCreated > 0) log.folds.push({ turn: t, rows: leaving.rowsLeaving });
    }
    const ctx = await assembleContext(AGENT, MODEL);
    lastSystemTokens = estimateTokens(ctx.systemPrompt);
    if ((ctx.freshTailDropped ?? 0) > 0) log.trimmedTurns.push(t);
  }
  return log;
}

function seed(window: number): void {
  windowNow.value = window;
  db().prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://localhost:11434/v1')").run();
  db().prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled)
     VALUES (?, 'p', 'local', 'Local', ?, 4096, '["tools"]', 1)`,
  ).run(MODEL, window);
  db().prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'Depot Reader', 'idle', ?, '{}')").run(AGENT, MODEL);
}

beforeEach(() => {
  turnNo = 0;
  summariser.calls = 0;
  __resetBrakesForTests();
  mockDb.current = new Database(':memory:');
  runMigrations();
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t140 C1 — large rows never make the trim set unsummarised rows aside', () => {
  it('128K window, a ~12K row every 10 turns, 220 turns: ZERO trimmed turns, and the view is still folded', async () => {
    seed(128_000);
    const log = await drive(220, 10);
    // eslint-disable-next-line no-console
    console.log(`t140 C1 128K/10: trimmed ${log.trimmedTurns.length} turns ${JSON.stringify(log.trimmedTurns.slice(0, 8))}… · folds ${JSON.stringify(log.folds)}`);
    expect(log.trimmedTurns, 'a row left the live view without a summary').toEqual([]);
    expect(log.folds.length, 'the view did fill, and it was folded instead of trimmed').toBeGreaterThan(0);
  }, 600_000);
});

describe('t140 I4 — a full view whose pressure sits in the newest-row floor does not fold a few rows every turn', () => {
  it('32K window, a ~12K row every 15 turns, 220 turns: every fold is at least one trim block, never on consecutive turns', async () => {
    seed(32_000);
    const log = await drive(220, 15);
    const block = tailTrimBlockGroups(getFreshTailCount(32_000));
    // eslint-disable-next-line no-console
    console.log(`t140 I4 32K/15: trimmed ${log.trimmedTurns.length} turns · ${log.folds.length} folds ${JSON.stringify(log.folds)}`);
    expect(log.folds.filter((f) => f.rows < block), 'a fold smaller than one trim block').toEqual([]);
    const consecutive = log.folds.filter((f, i) => i > 0 && f.turn === log.folds[i - 1].turn + 1);
    expect(consecutive, 'folds on back-to-back turns').toEqual([]);
    // Bounded: a 32K view with 12K rows in it may fold, but never on more than one turn in ten.
    expect(log.folds.length).toBeLessThanOrEqual(22);
  }, 600_000);
});

// ════════════════════════════════════════════════════════════════════════════════════════
// ROUND 2 (re-review 1 §1) — THE DIRECT COUNT. After every assembly, a row is LOST when it is
// (a) not in the assembled view and (b) not covered by any summary. The invariant is absolute:
// zero lost rows, on every turn, at 32K and at 128K, whether the routine fold is awaited before
// the assembly or lands after it (production's fire-and-forget). The newest-row floor limits
// what a PRESSURE fold may take; it does not decide what the token trim takes, and every row
// the trim takes is owed its summary before it leaves.
// ════════════════════════════════════════════════════════════════════════════════════════
type FoldTiming = 'awaited' | 'after-assembly';
interface CountLog { lostRowTurns: number; turnsWithLoss: number; worstTurn: { turn: number; lost: string[] } | null; folds: number }

/** The assembly the turn actually dials. Round 2's fix changes which door the engine uses. */
const turnAssembly = async () => assembleContext(AGENT, MODEL);

function lostRows(view: string): string[] {
  const rows = db().prepare(
    `SELECT m.content AS content FROM messages m
      WHERE m.agent_id = ? AND NOT EXISTS (SELECT 1 FROM summary_messages sm WHERE sm.message_id = m.id)`,
  ).all(AGENT) as Array<{ content: string }>;
  const lost: string[] = [];
  for (const r of rows) {
    const marker = /\[(u|a)\d+\]/.exec(r.content)?.[0];
    if (marker && !view.includes(marker)) lost.push(marker);
  }
  return lost;
}

async function driveCounting(turns: number, largeEvery: number, timing: FoldTiming): Promise<CountLog> {
  const log: CountLog = { lostRowTurns: 0, turnsWithLoss: 0, worstTurn: null, folds: 0 };
  let lastSystemTokens = 0;
  for (let t = 1; t <= turns; t++) {
    appendTurn(t % largeEvery === 0);
    const before = summariser.calls;
    const est = await estimateAssembledTokens(AGENT, windowNow.value, MODEL);
    const leaving = rowsLeavingView(AGENT, { freshTailCount: getFreshTailCount(windowNow.value) },
      { viewFull: liveViewIsFull(est, lastSystemTokens) });
    const fold = leaving ? checkAndCompact(AGENT, MODEL, windowNow.value, { leaving, maxChunksPerRun: 10 }) : null;
    if (fold && timing === 'awaited') await fold;
    const ctx = await turnAssembly();
    const lost = lostRows(JSON.stringify(ctx.messages));
    if (fold && timing === 'after-assembly') await fold;
    if (summariser.calls > before) log.folds++;
    lastSystemTokens = estimateTokens(ctx.systemPrompt);
    if (lost.length > 0) {
      log.turnsWithLoss++;
      log.lostRowTurns += lost.length;
      if (!log.worstTurn || lost.length > log.worstTurn.lost.length) log.worstTurn = { turn: t, lost };
    }
  }
  return log;
}

describe('t140 round 2 — C1 direct count: no row is ever out of view without a summary', () => {
  for (const [window, every] of [[128_000, 10], [32_000, 15]] as const) {
    for (const timing of ['awaited', 'after-assembly'] as const) {
      const clause = `${window / 1000}K window, a ~12K row every ${every} turns, 220 turns, fold ${timing}: ZERO lost rows on every turn`;
      const body = async () => {
        seed(window);
        const log = await driveCounting(220, every, timing);
        // eslint-disable-next-line no-console
        console.log(`t140 C1-direct ${window / 1000}K/${every} ${timing}: ${log.turnsWithLoss} turns with loss, ${log.lostRowTurns} lost row-turns, worst ${JSON.stringify(log.worstTurn && { turn: log.worstTurn.turn, n: log.worstTurn.lost.length })} · ${log.folds} fold turns`);
        expect(log.worstTurn, 'a row was out of view with no summary covering it').toBeNull();
      };
      if (window === 32_000) it.fails(clause, body, 600_000);
      else it(clause, body, 600_000);
    }
  }
});
