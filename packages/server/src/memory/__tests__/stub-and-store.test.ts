// Phase 4 §E (2026-05-04) — stub-and-store unit tests.
//
// stubOldToolResults runs in the v2 assembler path: tool_result messages
// older than V2_STUB_AFTER_TURNS (5) get their content replaced with a
// short stub so context stays roughly flat over a long session.

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

import { stubOldToolResults } from '../assembler.js';

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
  // Seed some messages so MAX(turn_number) reflects "current turn = 10".
  db.prepare(`INSERT INTO messages (id, agent_id, role, content, turn_number) VALUES ('seed', 'kevin', 'assistant', 'x', 9)`).run();
  mockDb.current = db;
});

function toolMsg(id: string, turnNumber: number | null, content: string): Message {
  return {
    id,
    agentId: 'kevin',
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
  it('keeps tool results from recent turns intact (<5 turns old)', () => {
    // currentTurn = MAX(9) + 1 = 10. Recent = turns 6-10.
    const recent = toolMsg('m1', 8, makeToolBlocks('tu_recent', 'fresh content'));
    const out = stubOldToolResults([recent], 'kevin');
    expect(out[0].content).toBe(recent.content);
    expect(out[0].content).toContain('fresh content');
    expect(out[0].content).not.toContain('cleared from context');
  });

  it('stubs tool results from old turns (≥5 turns old)', () => {
    // currentTurn = 10, msg at turn 4 → age 6 → stub.
    const old = toolMsg('m2', 4, makeToolBlocks('tu_old', 'a'.repeat(2000)));
    const out = stubOldToolResults([old], 'kevin');
    expect(out[0].content).not.toContain('a'.repeat(50));
    expect(out[0].content).toContain('cleared from context');
    expect(out[0].content).toContain('turn 4');
    expect(out[0].content).toContain('2000 chars');
  });

  it('stubs NULL turn_number (pre-v2 history) as very old', () => {
    const ancient = toolMsg('m3', null, makeToolBlocks('tu_legacy', 'pre-v2 dump'));
    const out = stubOldToolResults([ancient], 'kevin');
    expect(out[0].content).toContain('cleared from context');
    expect(out[0].content).toContain('pre-v2 history');
    expect(out[0].content).not.toContain('pre-v2 dump');
  });

  it('preserves the tool_use_id on stubbed blocks (alternation invariant)', () => {
    const old = toolMsg('m4', 4, makeToolBlocks('tu_pair', 'old'));
    const out = stubOldToolResults([old], 'kevin');
    const blocks = JSON.parse(out[0].content) as Array<{ type: string; tool_use_id: string }>;
    expect(blocks[0].type).toBe('tool_result');
    expect(blocks[0].tool_use_id).toBe('tu_pair');
  });

  it('does not touch non-tool messages (assistant, user, system)', () => {
    const assistant: Message = {
      id: 'a1',
      agentId: 'kevin',
      role: 'assistant',
      content: 'I did the thing',
      tokenCount: null, modelId: null, cost: null, latencyMs: null,
      createdAt: new Date().toISOString(),
      turnNumber: 3,
    };
    const out = stubOldToolResults([assistant], 'kevin');
    expect(out[0].content).toBe('I did the thing');
  });

  it('handles invalid JSON tool content gracefully (returns original)', () => {
    const broken = toolMsg('m5', 4, 'not valid json');
    const out = stubOldToolResults([broken], 'kevin');
    expect(out[0].content).toBe('not valid json');
  });

  it('mixes recent + old correctly in one call', () => {
    const recent = toolMsg('m6', 8, makeToolBlocks('tu_r', 'fresh'));
    const old = toolMsg('m7', 3, makeToolBlocks('tu_o', 'stale'));
    const out = stubOldToolResults([recent, old], 'kevin');
    expect(out[0].content).toContain('fresh');
    expect(out[1].content).toContain('cleared from context');
    expect(out[1].content).not.toContain('stale');
  });

  it('STUB_AFTER_TURNS boundary: msg at exactly turn-5 still recent, turn-6 stubbed', () => {
    // currentTurn = 10. STUB_AFTER_TURNS = 5.
    // msg at turn 5 → age 5 → stub (per spec: stub when age >= STUB_AFTER_TURNS)
    // msg at turn 6 → age 4 → keep
    const stubbed = toolMsg('m8', 5, makeToolBlocks('tu_x', 'boundary'));
    const kept = toolMsg('m9', 6, makeToolBlocks('tu_y', 'kept'));
    const out = stubOldToolResults([stubbed, kept], 'kevin');
    expect(out[0].content).toContain('cleared from context');
    expect(out[1].content).toContain('kept');
  });
});
