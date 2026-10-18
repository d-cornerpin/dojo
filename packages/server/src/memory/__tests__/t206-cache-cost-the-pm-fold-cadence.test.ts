// ════════════════════════════════════════════════════════════════════════════════════════
// t206 (v3.4 D3) — THE PM'S TAIL OVER A LONG RUN: how often its prefix moves, and what that
// re-reads. The companion of `t206-cache-cost-the-pm-tail-holds-still.test.ts`: that file pins
// the rule pair by pair; this one drives the PRODUCTION cadence — situation reports arriving,
// the real compaction gate folding what leaves the view (fictional summariser), the real
// 60-second pruner — and measures the run with t94's instrument.
//
// The window is small (32K) so folds happen within a short fixture; the shape is the same on
// any window. Fictional rows only.
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
vi.mock('../../agent/model.js', () => ({
  callModel: async () => ({ content: 'Earlier review cycles: nothing needed a ruling.', toolCalls: [], usage: {} }),
  getContextWindow: () => 32_000,
  getModelOutputCap: () => 4096,
  getProviderCeilingTokens: () => null,
}));

import { assembleContext } from '../assembler.js';
import { insertMessage } from '../message-store.js';
import { checkAndCompact, estimateAssembledTokens, leavingFromView } from '../compaction.js';
import { __resetBrakesForTests } from '../compaction-brakes.js';
import { runMigrations } from '../../db/migrations.js';
import { runDeltas, discontinuities, renderTable, abridge, type TurnSnapshot } from './prefix-instrument.js';
import { pruneOldPMMessages } from '../../tracker/pm-agent.js';

const PM = 'pm';
const MODEL = 't206-fold-model';
const db = (): Database.Database => mockDb.current!;
let turnNo = 0;
/** The PM's review cadence: minutes apart, so a 15-minute compaction backoff expires as it does
 *  in production. A frozen clock would hold the backoff for ever and measure a broken writer. */
const CYCLE_MS = 4 * 60_000;
let clock = 1785000000000;

function seed(): void {
  db().prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://localhost:11434/v1')").run();
  db().prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities, is_enabled)
     VALUES (?, 'p', 't206fold', 'T206 Fold', 32000, 4096, '["tools","thinking"]', 1)`,
  ).run(MODEL);
  db().prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'PM', 'idle', ?, '{}')").run(PM, MODEL);
}

/** One review cycle: a situation report (about 300 tokens, the dev box's are larger), the PM's
 *  reply, and the turn-closed note. */
function reviewCycle(): void {
  turnNo += 1;
  clock += CYCLE_MS;
  const report = `Tracker review ${turnNo} -- 3 active tasks. ` + 'The report task is on deck; the inbox task is in progress; the filing task waits on validation. '.repeat(12);
  insertMessage({ agentId: PM, role: 'user', lane: 'events', senderId: 'system', content: report, turnNumber: turnNo });
  insertMessage({ agentId: PM, role: 'assistant', lane: 'owner', content: `Reviewed cycle ${turnNo}; nothing needs a ruling.`, turnNumber: turnNo });
}

async function foldIfLeaving(): Promise<boolean> {
  const { view } = await estimateAssembledTokens(PM, 32_000, MODEL);
  const leaving = leavingFromView(PM, 32_000, view);
  if (!leaving) return false;
  const r = await checkAndCompact(PM, MODEL, 32_000, { leaving });
  return r.leafCreated > 0;
}

beforeEach(() => {
  turnNo = 0;
  clock = 1785000000000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  __resetBrakesForTests();
  mockDb.current = new Database(':memory:');
  runMigrations();
  seed();
});

afterEach(() => {
  vi.restoreAllMocks();
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t206 §2 — over a long run the PM prefix moves only at folds', () => {
  it('2a — 160 review cycles: every discontinuity is a fold, and the run re-reads little more than it appends', async () => {
    const snaps: TurnSnapshot[] = [];
    let folds = 0;
    for (let t = 1; t <= 160; t += 1) {
      reviewCycle();
      const folded = await foldIfLeaving();
      if (folded) folds += 1;
      pruneOldPMMessages(PM);
      const ctx = await assembleContext(PM, MODEL);
      snaps.push({ turn: t, messages: JSON.parse(JSON.stringify(ctx.messages)), entryIds: ctx.messageEntryIds, note: folded ? 'fold' : '' });
    }
    const deltas = runDeltas(snaps);
    const bad = discontinuities(deltas);
    const reprefill = deltas.reduce((s, d) => s + d.reprefillBytes, 0);
    const appended = deltas.reduce((s, d) => s + Math.max(0, d.bytesAfter - d.bytesBefore), 0);
    // Printed for the lane report (fictional data).
    console.log(renderTable('t206 §2a — the PM over 160 review cycles (32K window)', deltas, abridge(deltas, 2, 2)));
    console.log(`folds: ${folds}`);

    expect(folds, 'the run never folded, so it measured nothing about folds').toBeGreaterThan(0);
    expect(bad.every((d) => d.note === 'fold'), `a discontinuity that is not a fold: turns ${bad.filter((d) => d.note !== 'fold').map((d) => d.turn).join(', ')}`).toBe(true);
    expect(reprefill / appended, 'the run re-reads far more than it appends').toBeLessThan(4);
  });
});
