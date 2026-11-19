// The waiting people come back in one order: the owner first, then a message never served before one handed back,
// then the oldest. The turn serves the first.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../db/connection.js', () => ({ getDb: () => mockDb.current!, getDbPath: () => ':memory:' }));
vi.mock('../../agent-notice.js', () => ({ postAgentNotice: vi.fn() }));

import { insertMessage } from '../../../memory/message-store.js';
import { getWaitingHumanConversations } from '../counterparty.js';
import { runMigrations } from '../../../db/migrations.js';
import { askIdForMessage, claimAsk, stampClaimingTurn, transition } from '../../../work/store.js';

const AGENT = 'agent-order';

const contactAsks = (content: string, sender: string): string => insertMessage({
  agentId: AGENT, role: 'user', lane: 'owner', channel: 'imessage', senderId: sender, authorized: true, content,
  inboundMeta: JSON.stringify({ channel: 'imessage', sender, authorized: true }),
}).id;
const ownerAsks = (content: string): string =>
  insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', channel: 'dashboard', senderId: 'owner', content }).id;
const servedAndHandedBack = (messageId: string): void => {
  const workId = askIdForMessage(messageId);
  claimAsk(workId, AGENT);
  stampClaimingTurn(workId, 1);
  transition(workId, { to: 'open', by: 'agent', actorId: AGENT, expectedState: 'claimed', reason: 'the turn ended without an answer' });
};
const order = (): string[] => getWaitingHumanConversations(AGENT).map((c) => c.oldest.content);

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Order', 'idle', '2000-01-01 00:00:00')").run(AGENT);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the waiting people come back in one order', () => {
  it("the owner's message comes before a contact's older one", () => {
    contactAsks('are we still on for Saturday?', '+15550001111');
    ownerAsks('book the dentist for next week');
    expect(order()).toEqual(['book the dentist for next week', 'are we still on for Saturday?']);
  });

  it('a message never served comes before an older one that was handed back', () => {
    servedAndHandedBack(contactAsks('send me the quote', '+15550001111'));
    contactAsks('what time is the call?', '+15550002222');
    expect(order()).toEqual(['what time is the call?', 'send me the quote']);
  });

  it("the owner's handed-back message still comes before a contact's newer one", () => {
    servedAndHandedBack(ownerAsks('compare the three quotes'));
    contactAsks('can you call me back?', '+15550001111');
    expect(order()).toEqual(['compare the three quotes', 'can you call me back?']);
  });
});
