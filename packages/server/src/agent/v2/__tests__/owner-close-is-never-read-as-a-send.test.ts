// The owner closing his own task writes one receipt row that says nothing was delivered, and no reader of the
// delivery ledger takes it for a send: each query that decides "was something delivered" is run against it.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-owner-close-test', 'dojo.db'),
  };
});
vi.mock('../../../memory/conversations.js', () => ({
  resolveOrCreateConversation: () => 'conv-should-not-be-used',
}));

import { createWorkTable, seedTrackerTask } from '../../../work/__tests__/work-fixture.js';
import { recordDecisionReceipt, recordDelivery, deliveryIdOf } from '../deliveries.js';

const W = 'task-1';
const AGENT = 'a1';

const receipts = (): Array<Record<string, unknown>> =>
  mockDb.current!.prepare(
    `SELECT * FROM deliveries WHERE tool = 'owner-close' ORDER BY rowid`,
  ).all() as Array<Record<string, unknown>>;

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  createWorkTable(db);
  db.exec(`
    CREATE TABLE deliveries (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, turn_number INTEGER,
      tool TEXT NOT NULL, channel TEXT NOT NULL, recipient_id TEXT, recipient_display TEXT,
      conversation_id TEXT, root_kind TEXT, root_id TEXT, message_id TEXT, receipt_id TEXT,
      outcome TEXT NOT NULL, detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  seedTrackerTask(db, { id: W, title: 'something the owner is closing himself', agentId: AGENT });
});

describe('the receipt is an honest record, not a claimed send', () => {
  it('records one row that says exactly what happened', () => {
    const id = deliveryIdOf(recordDecisionReceipt(W, 'The owner', 'the dashboard task board'));
    expect(id).not.toBeNull();
    const rows = receipts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id, agent_id: AGENT, tool: 'owner-close', channel: 'none', outcome: 'owner_closed',
    });
    expect(rows[0].message_id).toBeNull();
    expect(rows[0].receipt_id).toBeNull();
    expect(rows[0].conversation_id).toBeNull();
    expect(String(rows[0].detail)).toMatch(/Nothing was delivered by this row/);
  });

  it('carries no root lineage, so it is never per-task delivery evidence', () => {
    recordDecisionReceipt(W, 'The owner', 'the dashboard task board');
    expect(receipts()[0].root_id).toBeNull();
    expect(receipts()[0].root_kind).toBeNull();
  });

  it('is one row PER CLOSE, so the instant of each is on the record', () => {
    seedTrackerTask(mockDb.current!, { id: 'task-2', title: 'another', agentId: AGENT });
    const a = deliveryIdOf(recordDecisionReceipt(W, 'The owner', 'the dashboard task board'));
    const b = deliveryIdOf(recordDecisionReceipt('task-2', 'The owner', 'the dashboard task board'));
    expect(a).not.toBe(b);
    expect(receipts()).toHaveLength(2);
  });

  it('refuses an id that does not resolve, so G7 refuses the close', () => {
    // A named refusal, apart from a ledger write that threw.
    const o = recordDecisionReceipt('no-such-work', 'The owner', 'the dashboard task board');
    expect(o.kind).toBe('refused');
    if (o.kind === 'refused') expect(o.reason).toBe('no-such-work');
    expect(deliveryIdOf(o)).toBeNull();
    expect(receipts()).toHaveLength(0);
  });
});

describe('the receipt is invisible to every consumer of the ledger', () => {
  it('NEGATIVE CONTROL: the PM consult path does not see it as delivery evidence', () => {
    recordDecisionReceipt(W, 'The owner', 'the dashboard task board');
    const channels = mockDb.current!.prepare(
      `SELECT DISTINCT channel FROM deliveries WHERE agent_id = ? AND outcome = 'delivered'`,
    ).all(AGENT);
    expect(channels).toEqual([]);
  });

  it('NEGATIVE CONTROL: the tracker-store close resolver does not offer it to a later close', () => {
    // If this returned the receipt, an agent's next close would inherit the owner's exemption.
    recordDecisionReceipt(W, 'The owner', 'the dashboard task board');
    const hit = mockDb.current!.prepare(
      `SELECT id FROM deliveries WHERE agent_id = ? AND outcome = 'delivered' AND tool <> 'engine-ack'`,
    ).get(AGENT);
    expect(hit).toBeUndefined();
  });

  it('NEGATIVE CONTROL: the dashboard dedup lookup cannot reach it', () => {
    // The one reader with no outcome filter is keyed on `channel='dashboard'` and a real message id.
    recordDecisionReceipt(W, 'The owner', 'the dashboard task board');
    const hit = mockDb.current!.prepare(
      `SELECT id FROM deliveries WHERE agent_id = ? AND channel = 'dashboard' AND message_id = ?`,
    ).get(AGENT, null);
    expect(hit).toBeUndefined();
  });

  it('POSITIVE CONTROL: a REAL delivery by the same agent IS seen by those same queries', () => {
    // Without this, the three clauses above would pass on an empty table and prove nothing.
    recordDecisionReceipt(W, 'The owner', 'the dashboard task board');
    recordDelivery({
      agentId: AGENT, tool: 'auto-route', channel: 'dashboard', outcome: 'delivered',
      messageId: 'm1', conversationId: 'c1',
    });
    const channels = mockDb.current!.prepare(
      `SELECT DISTINCT channel FROM deliveries WHERE agent_id = ? AND outcome = 'delivered'`,
    ).all(AGENT);
    expect(channels).toEqual([{ channel: 'dashboard' }]);
    const dedup = mockDb.current!.prepare(
      `SELECT id FROM deliveries WHERE agent_id = ? AND channel = 'dashboard' AND message_id = ?`,
    ).get(AGENT, 'm1');
    expect(dedup).toBeDefined();
  });
});
