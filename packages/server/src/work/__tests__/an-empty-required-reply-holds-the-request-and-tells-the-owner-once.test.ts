// A required reply that came back with nothing holds its request at once and tells the owner once, as the Dojo,
// on the request's own record; when the person writes again and it fails the same way, it is held with no second card.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../agent/v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../../memory/message-store.js';
import { askIdForMessage, claimAsk, stampClaimingTurn } from '../store.js';
import { liftStandDowns, settleAsksAtTurnFinalize } from '../ask-settlement.js';
import { freshReplyDb, testDb, AGENT } from '../../agent/v2/__tests__/helpers/reply-sender.js';

const ASK = askIdForMessage('m-1');
const state = (): string => (testDb().prepare('SELECT state FROM work WHERE id = ?').get(ASK) as { state: string }).state;
const cards = (): number => (testDb().prepare(`SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'floor_ghosted'
  AND json_extract(payload, '$.floor') = 'request-stood-down'`).get(ASK) as { n: number }).n;

function silentTurn(turnNumber: number, forcedEmpty: boolean): void {
  testDb().prepare(`INSERT INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason, answered)
    VALUES (?, ?, datetime('now'), datetime('now'), 'no_reply_intended', 0)`).run(AGENT, turnNumber);
  settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber, forcedEmpty });
}

beforeEach(() => {
  freshReplyDb(runMigrations);
  testDb().prepare("INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, counterparty_name) VALUES ('conv-owner', ?, 'dashboard', 'dashboard', 'owner', 'Sam')").run(AGENT);
  insertMessage({ id: 'm-1', agentId: AGENT, role: 'user', content: 'Which of the three quotes should I take?',
    conversationId: 'conv-owner', channel: 'dashboard', senderId: 'owner', lane: 'owner' } as never);
  claimAsk(ASK, AGENT);
  stampClaimingTurn(ASK, 1);
});

describe('an empty required reply', () => {
  it('holds the request on its first serve and cards the owner once', () => {
    silentTurn(1, true);
    expect(state()).toBe('blocked');
    expect(cards()).toBe(1);
    const line = testDb().prepare("SELECT content FROM messages WHERE role = 'system' AND content LIKE '%stopped trying%'").get() as { content: string };
    expect(line.content).toMatch(/after 1 try, so it has stopped trying\. It answers when Sam writes again\./);
  });

  it('a silent turn with no required reply is handed back, not held', () => {
    silentTurn(1, false);
    expect(state()).toBe('open');
    expect(cards()).toBe(0);
  });

  it('the person writes again and it fails the same way: held again, no second card', () => {
    silentTurn(1, true);
    insertMessage({ id: 'm-2', agentId: AGENT, role: 'user', content: 'Hello?',
      conversationId: 'conv-owner', channel: 'dashboard', senderId: 'owner', lane: 'owner' } as never);
    liftStandDowns(AGENT, askIdForMessage('m-2'), 2);
    expect(state()).toBe('claimed');
    silentTurn(2, true);
    expect(state()).toBe('blocked');
    expect(cards()).toBe(1);
  });
});
