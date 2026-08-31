// Phase 4 §E (2026-05-04) — stub-and-store unit tests.
//
// stubOldToolResults runs in the v2 assembler path: tool_result messages at
// least V2_STUB_AFTER_TURNS turns old get their content replaced with a short
// stub so context stays roughly flat over a long session. Turn numbers here are
// derived from V2_STUB_AFTER_TURNS so the tests track the threshold if it is
// tuned (it moved 5 -> 12 during the memory remediation, which is what these
// tests now follow).
//
// ── T67b — WHO DECIDES, AND WHEN ────────────────────────────────────────────
// The RULE and the DISTANCE are unchanged; WHERE THE DECISION IS MADE moved.
// This function used to read the LIVE turn counter on every assembly, so a row
// twelve turns back flipped from full to stubbed MID-SESSION and rewrote bytes
// the provider had already cached — T56 leg (b)'s boundary rule, violated one
// column over. The decision is now a monotonic watermark advanced at a
// compaction boundary (`compaction.ts stubOldToolResultsAtBoundary`) and this
// function only renders it. Every clause below therefore seeds the WATERMARK
// where it used to seed the turn record, and two new clauses pin the halves
// that behaviour depends on: no watermark stubs nothing, and the watermark only
// ever moves forward.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Message } from '@dojo/shared';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { stubOldToolResults, V2_STUB_AFTER_TURNS } from '../assembler.js';
import { stubOldToolResultsAtBoundary } from '../compaction.js';

// PHASE-3 T5 (G24): currentTurn is now `MAX(turn_number)` from the `turns` RECORD, not
// `MAX(turn_number) + 1` over `messages` — the allocator owns the number and a turn that
// persisted no message used to leave the old derivation frozen (research 06 §7). The
// fixture therefore ALLOCATES a turn instead of seeding a message to imply one. Every age
// below, and every assertion, is unchanged: only where the clock is read from moved.
// Derive the recent/old/boundary turns from the live threshold.
const CURRENT_TURN = V2_STUB_AFTER_TURNS + 20;
// Deliberately FIVE behind, so the two clocks disagree: a reader still on
// `MAX(messages.turn_number) + 1` would compute CURRENT_TURN - 4 and every boundary
// assertion below would fail. A seed that agreed with the allocator would let the old
// reader pass silently, which is the whole trap this fixture exists to avoid.
const SEED_TURN = CURRENT_TURN - 5;
const RECENT_TURN = CURRENT_TURN - 1;                              // age 1 → keep
const OLD_TURN = CURRENT_TURN - V2_STUB_AFTER_TURNS - 5;          // well past threshold → stub
// The watermark is EXCLUSIVE (`turn_number < watermark`), which is the same cut the age
// comparison expressed: at watermark = CURRENT_TURN - V2_STUB_AFTER_TURNS, a row one turn
// older than the watermark is stubbed and a row AT the watermark is kept.
const STUB_BOUNDARY_TURN = CURRENT_TURN - V2_STUB_AFTER_TURNS - 1; // below the watermark → stub
const KEEP_BOUNDARY_TURN = CURRENT_TURN - V2_STUB_AFTER_TURNS;     // at the watermark → keep

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      turn_number INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.exec(`
    CREATE TABLE turns (
      agent_id TEXT NOT NULL,
      turn_number INTEGER NOT NULL,
      ended_at TEXT,
      PRIMARY KEY (agent_id, turn_number)
    );
  `);
  db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, config TEXT);`);
  // T67b: the watermark a compaction boundary would have left at this turn — the SAME
  // distance from the SAME active turn the live clock used to compute inline.
  db.prepare('INSERT INTO agents (id, config) VALUES (?, ?)').run(
    'primary', JSON.stringify({ toolResultsStubbedBeforeTurn: CURRENT_TURN - V2_STUB_AFTER_TURNS }),
  );
  // The message seed STAYS, five turns behind: it is what the OLD derivation read, and
  // keeping the two clocks in disagreement is what makes this fixture able to tell them
  // apart at all.
  db.prepare(
    `INSERT INTO messages (id, agent_id, role, content, turn_number) VALUES ('seed', 'primary', 'assistant', 'x', ?)`,
  ).run(SEED_TURN);
  db.prepare('INSERT INTO turns (agent_id, turn_number, ended_at) VALUES (?, ?, NULL)')
    .run('primary', CURRENT_TURN);
  mockDb.current = db;
});

function toolMsg(id: string, turnNumber: number | null, content: string): Message {
  return {
    id,
    agentId: 'primary',
    role: 'tool',
    content,
    tokenCount: null,
    modelId: null,
    cost: null,
    latencyMs: null,
    createdAt: new Date().toISOString(),
    turnNumber,
  };
}

function makeToolBlocks(toolUseId: string, content: string): string {
  return JSON.stringify([
    { type: 'tool_result', tool_use_id: toolUseId, content, is_error: false },
  ]);
}

describe('stubOldToolResults', () => {
  it('keeps tool results from recent turns intact (younger than the threshold)', () => {
    const recent = toolMsg('m1', RECENT_TURN, makeToolBlocks('tu_recent', 'fresh content'));
    const out = stubOldToolResults([recent], 'primary');
    expect(out[0].content).toBe(recent.content);
    expect(out[0].content).toContain('fresh content');
    expect(out[0].content).not.toContain('cleared from context');
  });

  it('stubs tool results from old turns (at least the threshold old)', () => {
    const old = toolMsg('m2', OLD_TURN, makeToolBlocks('tu_old', 'a'.repeat(2000)));
    const out = stubOldToolResults([old], 'primary');
    expect(out[0].content).not.toContain('a'.repeat(50));
    expect(out[0].content).toContain('cleared from context');
    expect(out[0].content).toContain(`turn ${OLD_TURN}`);
    expect(out[0].content).toContain('2000 chars');
  });

  it('stubs NULL turn_number (pre-v2 history) as very old', () => {
    const ancient = toolMsg('m3', null, makeToolBlocks('tu_legacy', 'pre-v2 dump'));
    const out = stubOldToolResults([ancient], 'primary');
    expect(out[0].content).toContain('cleared from context');
    expect(out[0].content).toContain('pre-v2 history');
    expect(out[0].content).not.toContain('pre-v2 dump');
  });

  it('preserves the tool_use_id on stubbed blocks (alternation invariant)', () => {
    const old = toolMsg('m4', OLD_TURN, makeToolBlocks('tu_pair', 'old'));
    const out = stubOldToolResults([old], 'primary');
    const blocks = JSON.parse(out[0].content) as Array<{ type: string; tool_use_id: string }>;
    expect(blocks[0].type).toBe('tool_result');
    expect(blocks[0].tool_use_id).toBe('tu_pair');
    expect(out[0].content).toContain('cleared from context');
  });

  it('does not touch non-tool messages (assistant, user, system)', () => {
    const assistant: Message = {
      id: 'a1',
      agentId: 'primary',
      role: 'assistant',
      content: 'I did the thing',
      tokenCount: null,
      modelId: null,
      cost: null,
      latencyMs: null,
      createdAt: new Date().toISOString(),
      turnNumber: OLD_TURN,
    };
    const out = stubOldToolResults([assistant], 'primary');
    expect(out[0].content).toBe('I did the thing');
  });

  it('handles invalid JSON tool content gracefully (returns original)', () => {
    const broken = toolMsg('m5', OLD_TURN, 'not valid json');
    const out = stubOldToolResults([broken], 'primary');
    expect(out[0].content).toBe('not valid json');
  });

  it('mixes recent + old correctly in one call', () => {
    const recent = toolMsg('m6', RECENT_TURN, makeToolBlocks('tu_r', 'fresh'));
    const old = toolMsg('m7', OLD_TURN, makeToolBlocks('tu_o', 'stale'));
    const out = stubOldToolResults([recent, old], 'primary');
    expect(out[0].content).toContain('fresh');
    expect(out[1].content).toContain('cleared from context');
    expect(out[1].content).not.toContain('stale');
  });

  it('threshold boundary: age == threshold stubbed, age == threshold-1 kept', () => {
    const stubbed = toolMsg('m8', STUB_BOUNDARY_TURN, makeToolBlocks('tu_x', 'boundary'));
    const kept = toolMsg('m9', KEEP_BOUNDARY_TURN, makeToolBlocks('tu_y', 'kept'));
    const out = stubOldToolResults([stubbed, kept], 'primary');
    expect(out[0].content).toContain('cleared from context');
    expect(out[1].content).toContain('kept');
  });

  // ── T67b: the two halves the boundary move depends on ──────────────────────────────────

  it('T67b: NO watermark stubs NOTHING — the fail-safe direction', () => {
    mockDb.current!.prepare('UPDATE agents SET config = ? WHERE id = ?').run('{}', 'primary');
    const old = toolMsg('m-old', OLD_TURN, makeToolBlocks('tu-1', 'a'.repeat(4000)));
    const out = stubOldToolResults([old], 'primary');
    // An agent that has never reached a compaction boundary replays its tool results whole.
    // That is the direction that cannot hurt: the alternative — stubbing on a guess — is the
    // mid-session prefix rewrite this move exists to remove.
    expect(out[0].content).toContain('aaaa');
  });

  it('T67b: the watermark only ever moves FORWARD', () => {
    const db = mockDb.current!;
    db.prepare('INSERT INTO turns (agent_id, turn_number, ended_at) VALUES (?, ?, NULL)')
      .run('primary', CURRENT_TURN + 40);
    const first = stubOldToolResultsAtBoundary('primary');
    expect(first).toBe(CURRENT_TURN + 40 - V2_STUB_AFTER_TURNS);
    // A boundary that would compute a LOWER watermark records nothing: a row already stubbed
    // may never render un-stubbed, because that would rewrite a cached byte in the other
    // direction, which is the same defect wearing the opposite sign.
    db.prepare('DELETE FROM turns WHERE turn_number = ?').run(CURRENT_TURN + 40);
    expect(stubOldToolResultsAtBoundary('primary')).toBe(0);
    const cfg = JSON.parse(
      (db.prepare('SELECT config FROM agents WHERE id = ?').get('primary') as { config: string }).config,
    ) as { toolResultsStubbedBeforeTurn: number };
    expect(cfg.toolResultsStubbedBeforeTurn).toBe(CURRENT_TURN + 40 - V2_STUB_AFTER_TURNS);
  });
});
