// ════════════════════════════════════════════════════════════════════════════════════════
// PHASE-3 T6 — the read-side SANITY BOUND on stored turn thresholds (T5 acceptance,
// adjudication 1). Written RED-first: at `694fb96` the readers accept any positive number,
// so a threshold from an older numbering era is permanently in the future and the lane it
// gates fires on every turn forever.
//
// Measured on the live dev body when this was written: kevin 1598 vs turn 264,
// healer 122 vs 9, imaginer 19 vs 0 — three of the five agents holding a threshold.
// The bound is the WRITER'S OWN horizon (`currentTurn + 3`, `memory/compaction.ts`),
// never a number this test or that module invented.
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

import { assembleContext } from '../assembler.js';
import { readStoredTurnThreshold, CONTINUITY_BRIEF_HORIZON_TURNS } from '../../agent/v2/turn-record.js';
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-threshold';
const MODEL = 'threshold-model';
const H = CONTINUITY_BRIEF_HORIZON_TURNS;

const BRIEF =
  'The user asked about the north gym locker. We established the code and filed a task to ' +
  'confirm it with the front desk. Continue from there when the topic returns.';

function seed(validUntilTurn: number | null, turns: number): void {
  const db = mockDb.current!;
  db.prepare(
    "INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://x')",
  ).run();
  db.prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities)
     VALUES (?, 'p', 'thr', 'Thr', 128000, 4096, '["tools"]')`,
  ).run(MODEL);
  const config = JSON.stringify({
    continuityBrief: BRIEF,
    ...(validUntilTurn === null ? {} : { continuityBriefValidUntilTurn: validUntilTurn }),
  });
  db.prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'Thr', 'idle', ?, ?)")
    .run(AGENT, MODEL, config);
  for (let t = 1; t <= turns; t++) {
    db.prepare(
      "INSERT INTO turns (agent_id, turn_number, subject_kind, answered, effectful_calls, started_at) VALUES (?, ?, 'none', 0, 0, datetime('now'))",
    ).run(AGENT, t);
  }
  db.prepare(
    `INSERT INTO messages (id, agent_id, role, lane, sender_id, content, display_kind, display_tier,
                           turn_number, provenance, authorized, created_at)
     VALUES ('thr-1', ?, 'user', 'owner', 'owner', 'what was that locker code?', 'user-text',
             'user-visible', ?, 'live', 1, 1785000001000)`,
  ).run(AGENT, turns);
}

async function continuityAdmitted(): Promise<boolean> {
  const ctx = await assembleContext(AGENT, MODEL);
  return (ctx.allocation?.admittedIds ?? []).includes('lane.continuity');
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('readStoredTurnThreshold — the bound is the writer\'s own horizon', () => {
  it('a threshold the writer could have produced RIGHT NOW is valid (equality is inside)', () => {
    expect(readStoredTurnThreshold(10 + H, 10, H)).toBe(10 + H);
  });
  it('one turn past the horizon is not expressible by any writer on this clock → expired', () => {
    expect(readStoredTurnThreshold(10 + H + 1, 10, H)).toBeNull();
  });
  it('THE LIVE FOSSIL: kevin, 1598 against turn 264 → expired', () => {
    expect(readStoredTurnThreshold(1598, 264, H)).toBeNull();
  });
  it('an ordinary already-expired threshold is returned, not nulled — expiry is the reader\'s job', () => {
    expect(readStoredTurnThreshold(11, 730, H)).toBe(11);
  });
  it('absent, non-numeric, zero and negative all read as absent', () => {
    for (const v of [undefined, null, 'seven', Number.NaN, Infinity, 0, -4]) {
      expect(readStoredTurnThreshold(v, 10, H)).toBeNull();
    }
  });
});

describe('the assembly, end to end', () => {
  it('RED AT BASE: a fossil threshold admits the continuity lane on every turn', async () => {
    seed(1598, 5);
    // With the bound in place this is FALSE. Without it, 5 < 1598 and the lane is admitted
    // on this turn and on every turn thereafter, indefinitely.
    expect(await continuityAdmitted()).toBe(false);
  });

  it('a threshold inside the horizon still admits the lane — the bound did not break the feature', async () => {
    seed(5 + H, 5);
    expect(await continuityAdmitted()).toBe(true);
  });

  it('an honestly expired threshold still closes the lane', async () => {
    seed(3, 9);
    expect(await continuityAdmitted()).toBe(false);
  });
});
