// When the agent stays silent on a message that only thanks or declines, that message is settled, not owed.
// A silent end on a message that asks for something is still owed and re-served.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));

import { runMigrations } from '../../db/migrations.js';
import { installJudgment } from '../../agent/decision-hooks.js';
import { inboundAsksNothing, inboundIsWork } from '../../agent/v2/classifiers/inbound-routing.js';
import { askIdForMessage, claimAsk, stampClaimingTurn } from '../store.js';
import { settleAsksAtTurnFinalize } from '../ask-settlement.js';
import { insertMessage } from '../../memory/message-store.js';

const AGENT = 'asker';
const CONV = 'conv-dashboard';
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare("INSERT INTO agents (id, name, classification, status) VALUES (?, 'A', 'sensei', 'idle')").run(AGENT);
  db().prepare(
    "INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id) VALUES (?, ?, 'dashboard', 'dashboard', 'owner')",
  ).run(CONV, AGENT);
  insertMessage({ id: 'offer', agentId: AGENT, role: 'assistant', content: 'Snake plant. Want a care calendar for it?', conversationId: CONV } as never);
});

/** One turn on a person's message that the agent ends in silence, settled the way the turn's teardown settles it. */
async function silentTurnOn(text: string, declined: boolean, exitReason = 'no_reply_intended'): Promise<string> {
  installJudgment(async () => ({ needs_several_steps: false, declined }));
  insertMessage({
    id: 'm1', agentId: AGENT, role: 'user', content: text, conversationId: CONV,
    channel: 'dashboard', senderId: 'owner', displayKind: 'user-text', lane: 'owner',
  } as never);
  const workId = askIdForMessage('m1');
  claimAsk(workId, AGENT);
  stampClaimingTurn(workId, 1);
  db().prepare(
    "INSERT INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason, answered) VALUES (?, 1, datetime('now'), datetime('now'), ?, 0)",
  ).run(AGENT, exitReason);
  const turnCtx = { root: { kind: 'ask' as const, id: 'm1', sourceMessageId: 'm1', conversationId: CONV } };
  expect(await inboundIsWork(turnCtx, AGENT, text)).toBe(false);
  const askedNothing = await inboundAsksNothing(turnCtx) ? workId : null;
  settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 1, askedNothing });
  return (db().prepare('SELECT state FROM work WHERE id = ?').get(workId) as { state: string }).state;
}

describe('a silent reply to a message that asks for nothing settles it', () => {
  it('"thx!" answered with silence is settled, not re-opened', async () => {
    expect(await silentTurnOn('thx!', true)).toBe('abandoned');
  });

  it('a question answered with silence is still owed and re-opened', async () => {
    expect(await silentTurnOn('what time does the store close?', false)).toBe('open');
  });

  it('a thanks whose turn the engine cut is still re-opened: the agent never chose silence', async () => {
    expect(await silentTurnOn('thx!', true, 'iteration_cap')).toBe('open');
  });
});
