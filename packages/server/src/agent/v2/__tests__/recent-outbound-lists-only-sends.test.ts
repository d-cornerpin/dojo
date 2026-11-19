// ════════════════════════════════════════════════════════════════════════════════════════
// THE RECENT-OUTBOUND READERS LIST SENDS TO PEOPLE, NOT EVERY RECEIPTED SIDE EFFECT.
//
// tool_receipts is the receipt ledger for ALL side-effecting tools (store.ts RECEIPT_TOOLS),
// including calendar_create/calendar_update — writes to a calendar, not messages to a person.
// The two ledger readers here answer "what did the agent send, to whom": the RECENT OUTBOUND
// block names each row by channel + recipient, and a calendar row (recipient null, unknown
// channel -> 'a2a') rendered as `agent -> unknown` and spent one of the block's slots; the
// delivery-denial fallback then grounded "[Engine receipt: you DID send ...]" on a calendar
// event that was never a message. Both queries now return send receipts only.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => undefined }));

import { runMigrations } from '../../../db/migrations.js';
import { writeToolReceipt } from '../../../receipts/store.js';
import {
  findRecentDeliveriesKeyed, getRecentOutbound, renderRecentOutboundBlock,
} from '../outbound-ledger.js';

const AGENT = 'worker-1';

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Worker', 'idle', '1970-01-01')`).run(AGENT);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('recent outbound lists only sends', () => {
  it('a calendar receipt does not join a real send in getRecentOutbound', () => {
    writeToolReceipt({
      agentId: AGENT, tool: 'send_to_agent', tier: 1, verified: true, basis: 'provider-id',
      recipient: 'Project Lead', sentText: 'The audit is done.',
    } as never);
    writeToolReceipt({
      agentId: AGENT, tool: 'calendar_create', tier: 1, verified: true, basis: 'provider-id',
      recipient: null,
    } as never);
    const rows = getRecentOutbound(AGENT, 24, 5);
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe('send_to_agent');
  });

  it('a bare "not yet" lookup never grounds on a calendar receipt', () => {
    writeToolReceipt({
      agentId: AGENT, tool: 'calendar_update', tier: 1, verified: true, basis: 'provider-id',
      recipient: null,
    } as never);
    expect(findRecentDeliveriesKeyed(AGENT, null, 1)).toEqual([]);
  });

  it('an unverified iMessage send stays in the ledger', () => {
    writeToolReceipt({
      agentId: AGENT, tool: 'imessage_send', tier: 3, verified: false, basis: 'exit-code',
      recipient: 'Ann',
    } as never);
    const rows = getRecentOutbound(AGENT, 24, 5);
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe('imessage_send');
    expect(rows[0].verified).toBe(false);
  });

  it('the rendered block names the send and never shows an unknown recipient', () => {
    writeToolReceipt({
      agentId: AGENT, tool: 'send_to_agent', tier: 1, verified: true, basis: 'provider-id',
      recipient: 'Project Lead', sentText: 'The audit is done.',
    } as never);
    writeToolReceipt({
      agentId: AGENT, tool: 'calendar_create', tier: 1, verified: true, basis: 'provider-id',
      recipient: null,
    } as never);
    const block = renderRecentOutboundBlock(getRecentOutbound(AGENT, 24, 5));
    expect(block).toContain('agent -> Project Lead');
    expect(block).not.toContain('unknown');
  });
});
