// The delivery-denial guard reads one record of "was it sent to this person": a mail to one
// contact never contradicts a denial about another whose name happens to sit inside hers.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => undefined }));

import { runMigrations } from '../../../../../db/migrations.js';
import { writeToolReceipt } from '../../../../../receipts/store.js';
import { TRUTH_GUARDS } from '../reply-floors.js';

const AGENT = 'agent-under-test';
const denialGuard = TRUTH_GUARDS.find((g) => g.floor === 'delivery-denial')!;
const decide = (reply: string) => denialGuard.decide({} as never, { agentId: AGENT } as never, reply);

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Worker', 'idle', '1970-01-01')`).run(AGENT);
  db.prepare(`INSERT INTO contacts (id, display_name, preferred_name, emails) VALUES ('c-joanna', 'Joanna Example', 'Joanna', '["joanna@example.com"]')`).run();
  const receiptId = writeToolReceipt({
    agentId: AGENT, tool: 'gmail_send', tier: 1, verified: true, basis: 'provider-id',
    providerId: 'm-1', recipient: 'joanna@example.com', sentText: 'The invoice is attached.',
  });
  db.prepare(
    `INSERT INTO deliveries (id, agent_id, tool, channel, recipient_id, recipient_display, receipt_id, outcome, created_at)
     VALUES ('d-1', ?, 'gmail_send', 'email', 'joanna@example.com', 'Joanna', ?, 'delivered', datetime('now'))`,
  ).run(AGENT, receiptId);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('asked about Ann, the agent is not told it wrote to Joanna', () => {
  it('a denial about Ann stands: the mail went to Joanna', () => {
    expect(decide("I haven't sent it to Ann yet.")).toBeNull();
  });

  it('a denial about Joanna is still corrected by the mail to her', () => {
    expect(decide("I haven't sent it to Joanna yet.")).toEqual({
      content: '[Engine receipt: you DID send email to Joanna just now. Answer truthfully; do not re-send.]',
    });
  });
});
