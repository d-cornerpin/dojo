// PHASE-2 T5 — THE TWO PHASE-1 §7 DEBTS, CLOSED WITH READERS.
//
// The exit summary handed Phase 2 two columns and said plainly that half-closing them —
// writing a column nothing reads — is the failure mode to avoid:
//
//   deliveries.receipt_id      44 rows / 0 populated. Phase 2 owes the WRITE **and** a reader.
//                              The fuzzy join it replaces is outbound-ledger.ts's
//                              `agent_id + turn_number + tool ORDER BY created_at DESC LIMIT 1`
//                              — three columns guessing at a link that now exists.
//
//   turn_artifacts.delivery_id 325 rows / 0 populated, zero production references of ANY kind.
//                              Phase 2 owes the write and either a reader or a written reason
//                              there is none. There IS one: `delivery-evidence.ts` can close a
//                              task by itself off "artifacts were handed over", and it was
//                              reading `delivered_at IS NOT NULL` — which means "the queue was
//                              drained", not "the user got it". A drained queue whose delivery
//                              FAILED is exactly the false evidence that consult must not act on.
//
// Both readers are load-bearing: one quotes the agent's own last message back to it, the other
// can make the engine close a task. Each has a negative control.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { mostRecentDeliveryToConversation } from '../outbound-ledger.js';
import { findDeliveryEvidenceForTask } from '../../../tracker/delivery-evidence.js';

const AGENT = 'agent-1';

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
    CREATE TABLE legacy_tasks (
      id TEXT PRIMARY KEY, assigned_to TEXT, source_message_id TEXT,
      origin_conv_key TEXT, created_at TEXT
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
    created_at: '2026-07-28 10:00:00', ...over,
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
    created_at: '2026-07-28 10:00:01', ...over,
  };
  const cols = Object.keys(row);
  mockDb.current!.prepare(
    `INSERT INTO tool_receipts (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`,
  ).run(row);
}

describe('deliveries.receipt_id is READ, not merely written', () => {
  it('POSITIVE: the sent text comes from the LINKED receipt, not from a turn+tool guess', () => {
    seedReceipt('r-right', { sent_text: 'the RIGHT text', created_at: '2026-07-28 09:00:00' });
    // A decoy the fuzzy join would have preferred: same agent, same turn, same tool, LATER.
    seedReceipt('r-decoy', { sent_text: 'the WRONG text', created_at: '2026-07-28 11:00:00' });
    seedDelivery({ receipt_id: 'r-right' });

    const d = mostRecentDeliveryToConversation(AGENT, 'conv-im', 24);
    expect(d).not.toBeNull();
    expect(d!.sentText).toBe('the RIGHT text');
  });

  it('NEGATIVE CONTROL: a delivery whose receipt_id points at nothing reports no sent text', () => {
    seedDelivery({ receipt_id: 'r-missing' });
    const d = mostRecentDeliveryToConversation(AGENT, 'conv-im', 24);
    expect(d!.sentText).toBeNull();
    expect(d!.verified).toBe(false);
  });

  it('LEGACY: a pre-T5 row with no receipt_id still resolves through the old turn+tool join', () => {
    // 44 rows of history exist with a NULL link. Dropping them on the floor would be a
    // regression dressed as a rekey.
    seedReceipt('r-legacy', { sent_text: 'legacy text' });
    seedDelivery({ receipt_id: null });
    const d = mostRecentDeliveryToConversation(AGENT, 'conv-im', 24);
    expect(d!.sentText).toBe('legacy text');
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2. turn_artifacts.delivery_id — the reader is the task-close evidence consult
// ════════════════════════════════════════════════════════════════════════

const TASK = 'task-1';
const ASK = 'msg-ask-1';

function seedTaskAndAnsweredTurn(): void {
  mockDb.current!.prepare(
    `INSERT INTO legacy_tasks VALUES (?, ?, ?, 'owner', '2026-07-28 07:15:34')`,
  ).run(TASK, AGENT, ASK);
  mockDb.current!.prepare(
    `INSERT INTO turns VALUES (?, 100, 'answered', 1, '2026-07-28 07:16:00', '2026-07-28 07:16:30', 'msg-answer', ?, NULL)`,
  ).run(AGENT, ASK);
}

function seedArtifact(id: string, deliveryId: string | null): void {
  mockDb.current!.prepare(
    `INSERT INTO turn_artifacts VALUES (?, ?, 100, '/tmp/report.md', '{"filename":"report.md"}', '2026-07-28 07:16:20', ?)`,
  ).run(id, AGENT, deliveryId);
}

describe('turn_artifacts.delivery_id decides whether an artifact is EVIDENCE', () => {
  it('POSITIVE: an artifact linked to a DELIVERED delivery counts as handed over', () => {
    seedTaskAndAnsweredTurn();
    seedDelivery({ id: 'd-ok', turn_number: 100, channel: 'dashboard', outcome: 'delivered' });
    seedArtifact('a-1', 'd-ok');
    const ev = findDeliveryEvidenceForTask(TASK)!;
    expect(ev.artifacts).toEqual(['report.md']);
  });

  it('NEGATIVE CONTROL: an artifact whose delivery FAILED is not evidence the user got it', () => {
    // The whole point of the column. `delivered_at` says the queue drained; only the
    // delivery says a person received it. This consult can CLOSE A TASK on its own.
    seedTaskAndAnsweredTurn();
    seedDelivery({ id: 'd-bad', turn_number: 100, channel: 'imessage', outcome: 'failed' });
    seedArtifact('a-2', 'd-bad');
    const ev = findDeliveryEvidenceForTask(TASK)!;
    expect(ev.artifacts).toEqual([]);
  });

  it('LEGACY: an artifact with no link falls back to delivered_at (325 pre-T5 rows)', () => {
    seedTaskAndAnsweredTurn();
    seedArtifact('a-3', null);
    const ev = findDeliveryEvidenceForTask(TASK)!;
    expect(ev.artifacts).toEqual(['report.md']);
  });
});
