// t207 (t200 hand-up) — THE OLD-RESULT STUB NEVER ADVISES RUNNING THE TOOL AGAIN.
//
// A tool result that has aged out of the live view is replaced by a short stub. The stub used to say
// "Re-call the tool or check vault for findings." That is exactly the advice t200 removed everywhere
// else: a long result is kept whole and `tool_result_read` reads it back, so running the tool again is
// never the answer. The stub now names the reader and the call id.

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
  db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, config TEXT);`);
  db.prepare('INSERT INTO agents (id, config) VALUES (?, ?)')
    .run('primary', JSON.stringify({ toolResultsStubbedBeforeTurn: 100 }));
  mockDb.current = db;
});

function toolMsg(turnNumber: number | null, blocks: unknown[]): Message {
  return {
    id: 'm1', agentId: 'primary', role: 'tool', content: JSON.stringify(blocks),
    tokenCount: null, modelId: null, cost: null, latencyMs: null,
    createdAt: new Date().toISOString(), turnNumber,
  } as unknown as Message;
}

describe('t207 — the stub that replaces an aged-out tool result', () => {
  it('names tool_result_read with the call id, and never says to run the tool again', () => {
    const out = stubOldToolResults([toolMsg(3, [
      { type: 'tool_result', tool_use_id: 'call_abc', content: 'x'.repeat(2000), is_error: false },
    ])], 'primary');
    const stub = (JSON.parse(out[0].content) as Array<{ content: string }>)[0].content;
    expect(stub).toContain('cleared from context');
    expect(stub).toContain('turn 3');
    expect(stub).toContain('2000 chars');
    expect(stub).toContain('tool_result_read({"id":"call_abc"})');
    expect(stub).not.toMatch(/re-?call|call the (same )?tool again|run (it|the tool) again|check vault/i);
  });

  it('each result in a batch gets its own call id', () => {
    const out = stubOldToolResults([toolMsg(null, [
      { type: 'tool_result', tool_use_id: 'call_one', content: 'a', is_error: false },
      { type: 'tool_result', tool_use_id: 'call_two', content: 'b', is_error: false },
    ])], 'primary');
    const blocks = JSON.parse(out[0].content) as Array<{ content: string }>;
    expect(blocks[0].content).toContain('"id":"call_one"');
    expect(blocks[1].content).toContain('"id":"call_two"');
    expect(blocks[0].content).toContain('pre-v2 history');
  });
});
