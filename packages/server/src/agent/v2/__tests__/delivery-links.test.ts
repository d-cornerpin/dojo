// deliveries.receipt_id is the link from a delivery to its receipt: the agent's own last message is
// quoted back to it through that link (`recentDeliveriesToConversation`), never through the old fuzzy
// `agent_id + turn_number + tool` join, which stays only for rows written before the link existed.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { recentDeliveriesToConversation } from '../outbound-ledger.js';

const AGENT = 'agent-1';

// ⚠ TIME-BOMB REPAIR (PHASE-2 T8c, 2026-07-29). These fixtures used to carry the LITERAL
// instants `2026-07-28 09:00:00 / 10:00:00 / 11:00:00`, and `recentDeliveriesToConversation`
// filters on `created_at >= datetime('now', '-24 hours')`. At 2026-07-29 10:04 UTC the window
// opened past 10:00:00 and all three clauses in section 1 went red — on the wall clock, with
// nothing in the tree changed. Verified as pre-existing rather than assumed: the same three
// fail in isolation at the parent commit. A fixture that is inside a rolling window on the day
// it is written and outside it the next day tests the calendar, so the instants are now
// RELATIVE to the run. The ordering the decoy clause depends on (right < delivery < decoy) is
// preserved exactly, in hours.
const HOUR = 3_600_000;
const rel = (hoursAgo: number): string =>
  new Date(Date.now() - hoursAgo * HOUR).toISOString().replace('T', ' ').slice(0, 19);


beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE deliveries (
      id TEXT PRIMARY KEY, agent_id TEXT, turn_number INTEGER, tool TEXT, channel TEXT,
      recipient_id TEXT, recipient_display TEXT, conversation_id TEXT, message_id TEXT,
      receipt_id TEXT, outcome TEXT, detail TEXT, created_at TEXT
    );
    CREATE TABLE tool_receipts (
      id TEXT PRIMARY KEY, agent_id TEXT, tool TEXT, turn_number INTEGER,
      sent_text TEXT, conv_key TEXT, verified INTEGER, created_at TEXT
    );
    CREATE TABLE turns (
      agent_id TEXT, turn_number INTEGER, exit_reason TEXT, answered INTEGER NOT NULL,
      started_at TEXT, ended_at TEXT, answer_message_id TEXT, source_message_id TEXT, conv_key TEXT
    );
    CREATE TABLE audit_log (agent_id TEXT, turn_number INTEGER);
    CREATE TABLE turn_artifacts (
      id TEXT PRIMARY KEY, agent_id TEXT, turn_number INTEGER, path TEXT,
      payload_json TEXT, delivered_at TEXT, delivery_id TEXT
    );
  `);
  mockDb.current = db;
});

// ════════════════════════════════════════════════════════════════════════
// 1. deliveries.receipt_id — the reader is the sent-text join
// ════════════════════════════════════════════════════════════════════════

function seedDelivery(over: Record<string, unknown> = {}): void {
  const row = {
    id: 'd-1', agent_id: AGENT, turn_number: 40, tool: 'imessage_send', channel: 'imessage',
    recipient_id: '+15550000', recipient_display: 'Dave', conversation_id: 'conv-im',
    message_id: null, receipt_id: null, outcome: 'delivered', detail: null,
    created_at: rel(2), ...over,
  };
  const cols = Object.keys(row);
  mockDb.current!.prepare(
    `INSERT INTO deliveries (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`,
  ).run(row);
}

function seedReceipt(id: string, over: Record<string, unknown> = {}): void {
  const row = {
    id, agent_id: AGENT, tool: 'imessage_send', turn_number: 40,
    sent_text: 'the roof quote is $4,200', conv_key: 'imessage:+15550000', verified: 1,
    created_at: rel(2), ...over,
  };
  const cols = Object.keys(row);
  mockDb.current!.prepare(
    `INSERT INTO tool_receipts (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`,
  ).run(row);
}

describe('deliveries.receipt_id is READ, not merely written', () => {
  it('POSITIVE: the sent text comes from the LINKED receipt, not from a turn+tool guess', () => {
    seedReceipt('r-right', { sent_text: 'the RIGHT text', created_at: rel(3) });
    // A decoy the fuzzy join would have preferred: same agent, same turn, same tool, LATER.
    seedReceipt('r-decoy', { sent_text: 'the WRONG text', created_at: rel(1) });
    seedDelivery({ receipt_id: 'r-right' });

    const d = recentDeliveriesToConversation(AGENT, 'conv-im', 24, 1)[0] ?? null;
    expect(d).not.toBeNull();
    expect(d!.sentText).toBe('the RIGHT text');
  });

  it('NEGATIVE CONTROL: a delivery whose receipt_id points at nothing reports no sent text', () => {
    seedDelivery({ receipt_id: 'r-missing' });
    const d = recentDeliveriesToConversation(AGENT, 'conv-im', 24, 1)[0] ?? null;
    expect(d!.sentText).toBeNull();
    expect(d!.verified).toBe(false);
  });

  it('LEGACY: a pre-T5 row with no receipt_id still resolves through the old turn+tool join', () => {
    // 44 rows of history exist with a NULL link. Dropping them on the floor would be a
    // regression dressed as a rekey.
    seedReceipt('r-legacy', { sent_text: 'legacy text' });
    seedDelivery({ receipt_id: null });
    const d = recentDeliveriesToConversation(AGENT, 'conv-im', 24, 1)[0] ?? null;
    expect(d!.sentText).toBe('legacy text');
  });
});
