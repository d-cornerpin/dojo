// After an update parks what an older version left unanswered, the agent's catch-up notice waits three minutes,
// so a message the owner writes in those minutes is served first.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import { askIdForMessage, claimAsk, stampClaimingTurn } from '../store.js';
import { reconcileOrphanedClaims } from '../orphaned-claims.js';
import { insertMessage } from '../../memory/message-store.js';
import { getPendingEngineEvent, getNextEngineEventRetryAt } from '../../agent/v2/counterparty.js';
import { nextOwed } from '../../agent/v2/owed.js';

const AGENT = randomUUID();
const db = (): Database.Database => mockDb.current!;

function ownerWrites(id: string, content: string): void {
  insertMessage({
    id, agentId: AGENT, role: 'user', content, lane: 'owner', channel: 'dashboard', senderId: 'owner',
    authorized: true, conversationId: 'conv-owner',
    inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner', sender: 'owner', authorized: true }),
  } as never);
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare("INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Agent', 'idle', '1970-01-01')").run(AGENT);
  db().prepare("INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES ('conv-owner', ?, 'dashboard', 'owner')").run(AGENT);
  // A request an older version stranded: claimed by a turn a boot closed long ago.
  ownerWrites('m-old', 'Can you find the warranty card for the dishwasher?');
  claimAsk(askIdForMessage('m-old'), AGENT);
  stampClaimingTurn(askIdForMessage('m-old'), 5);
  db().prepare(`INSERT INTO turns (agent_id, turn_number, kind, root_kind, root_id, started_at, ended_at, exit_reason, answered)
    VALUES (?, 5, 'user', 'ask', 'm-old', datetime('now', '-9 days'), datetime('now', '-9 days'), 'terminated', 0)`).run(AGENT);
  reconcileOrphanedClaims({ inheritedBacklog: true });
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the owner\'s first message after an update comes before the catch-up', () => {
  it('right after the update the catch-up notice waits three minutes', () => {
    expect(getPendingEngineEvent(AGENT)).toBeNull();
    expect(nextOwed(AGENT)).toEqual([]);
    const at = getNextEngineEventRetryAt(AGENT);
    expect(at).not.toBeNull();
    expect(at! - Date.now()).toBeGreaterThan(170_000);
    expect(at! - Date.now()).toBeLessThanOrEqual(180_000);
  });

  it('a message the owner writes in those minutes is the only thing served now', () => {
    ownerWrites('m-new', 'Are you there?');
    expect(nextOwed(AGENT).map((i) => i.kind)).toEqual(['person']);
  });
});
