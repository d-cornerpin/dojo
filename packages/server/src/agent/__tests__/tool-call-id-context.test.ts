// PHASE-0 T12c Step 2 — the executing call id travels with its own execution.
//
// The loop runs read-only tool calls concurrently (Promise.all over runOne, see
// v2/loop.ts). Every execution-record writer — auditLog in agent/tools.ts and
// writeToolReceipt in receipts/store.ts — asks "which call am I inside?". While
// that answer lived in one per-agent slot, the last call to start overwrote it
// for everybody, so a batch of ten parallel file_reads stamped all ten audit
// rows with whichever id started last. Live evidence on the dev box before the
// fix: 705 call-id-bearing audit_log rows, 555 distinct ids, every collision a
// file_read — the parallel batch.
//
// Both tests below are about interleaving specifically: each execution suspends
// at an await while the other runs, which is exactly when a single shared slot
// loses track of who is who.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { runWithToolCallId, getCurrentToolCallId } from '../turn-state.js';
import { writeToolReceipt } from '../../receipts/store.js';

const AGENT = 'agent-under-test';
const OTHER_AGENT = 'someone-else';

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE audit_log (
      id TEXT PRIMARY KEY, agent_id TEXT, action_type TEXT, target TEXT,
      result TEXT, detail TEXT, turn_number INTEGER, call_id TEXT,
      root_kind TEXT, root_id TEXT, created_at TEXT
    );
    CREATE TABLE tool_receipts (
      id TEXT PRIMARY KEY, agent_id TEXT, tool TEXT, tier INTEGER, verified INTEGER,
      basis TEXT, provider_id TEXT, thread_id TEXT, recipient TEXT, detail TEXT,
      audit_id TEXT, sim INTEGER, conv_key TEXT, turn_number INTEGER, sent_text TEXT,
      call_id TEXT, root_kind TEXT, root_id TEXT, created_at TEXT, updated_at TEXT
    );
  `);
  mockDb.current = db;
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('the executing tool-call id is per execution, not per agent', () => {
  it('two interleaved async tool executions each read their own call id', async () => {
    const seenMidway: Record<string, string | null> = {};
    const seenAtEnd: Record<string, string | null> = {};

    const execute = (callId: string, firstPause: number, secondPause: number): Promise<void> =>
      runWithToolCallId(AGENT, callId, async () => {
        await new Promise((r) => setTimeout(r, firstPause));
        seenMidway[callId] = getCurrentToolCallId(AGENT);
        await new Promise((r) => setTimeout(r, secondPause));
        seenAtEnd[callId] = getCurrentToolCallId(AGENT);
      });

    // Pauses chosen so the two executions strictly interleave: A starts, A
    // suspends, B starts and overwrites any shared slot, B suspends, A resumes.
    await Promise.all([
      execute('call_A', 20, 40),
      execute('call_B', 5, 5),
    ]);

    expect(seenMidway).toEqual({ call_A: 'call_A', call_B: 'call_B' });
    expect(seenAtEnd).toEqual({ call_A: 'call_A', call_B: 'call_B' });
  });

  it('a receipt written inside an execution carries that execution\'s call id', async () => {
    // The real production reader: receipts/store.ts resolves call_id from the
    // live execution context, so two interleaved sends must not trade ids.
    const write = (callId: string, tool: string, pause: number): Promise<string> =>
      runWithToolCallId(AGENT, callId, async () => {
        await new Promise((r) => setTimeout(r, pause));
        return writeToolReceipt({
          agentId: AGENT, tool, tier: 1, verified: true, basis: 'provider-id',
          providerId: `provider-${callId}`, skipAudit: true,
        });
      });

    await Promise.all([
      write('call_slow', 'gmail_send', 30),
      write('call_fast', 'sms_send', 1),
    ]);

    const rows = mockDb.current!
      .prepare('SELECT tool, call_id FROM tool_receipts ORDER BY tool')
      .all() as { tool: string; call_id: string | null }[];

    expect(rows).toEqual([
      { tool: 'gmail_send', call_id: 'call_slow' },
      { tool: 'sms_send', call_id: 'call_fast' },
    ]);
  });

  it('reports no call id outside any execution, and never another agent\'s', async () => {
    expect(getCurrentToolCallId(AGENT)).toBeNull();

    await runWithToolCallId(AGENT, 'call_A', async () => {
      await Promise.resolve();
      // A record written FOR a different agent from inside this agent's tool
      // call is not part of that agent's call and must not borrow its id.
      expect(getCurrentToolCallId(OTHER_AGENT)).toBeNull();
      expect(getCurrentToolCallId(AGENT)).toBe('call_A');
    });

    expect(getCurrentToolCallId(AGENT)).toBeNull();
  });
});
