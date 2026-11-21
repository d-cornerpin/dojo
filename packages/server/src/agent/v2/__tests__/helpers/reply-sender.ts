// Shared fakes for the reply-sender tests: a database run through the real migration chain, the iMessage send
// faked at the bridge, and the finalize inputs of a person's turn. Mocks in each file:
//
//   vi.mock('<v2>/../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
//   vi.mock('<v2>/../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
import Database from 'better-sqlite3';
import { vi } from 'vitest';
import type { InboundMeta } from '@dojo/shared';

export const AGENT = 'agent-main';
export const OWNER = '+15550199';
export const PERSON = '+15550100';
export const OTHER = '+15550111';
export const T0 = 1_900_000_000_000;

const state: { db: Database.Database | null } = { db: null };
export const testDb = (): Database.Database => {
  if (!state.db) throw new Error('reply-sender: test DB not initialized');
  return state.db;
};
export const connectionMock = () => ({ getDb: testDb, closeDb: () => {}, getDbPath: () => ':memory:' });

/** The iMessage sends, faked where the bridge would run its program; `sent` is every send in order. */
export const imessage = {
  send: vi.fn(async (_to: string, _text: string): Promise<boolean> => true),
  sendFile: vi.fn(async (_to: string, _path: string): Promise<boolean> => true),
  sent: [] as string[],
  on: true,
};
export const bridgeMock = (orig: Record<string, unknown>) => ({
  ...orig,
  sendIMessage: (to: string, text: string) => { imessage.sent.push(text); return imessage.send(to, text); },
  sendIMessageWithAttachment: (to: string, path: string) => { imessage.sent.push(`file ${path}`); return imessage.sendFile(to, path); },
  isIMessageSwitchedOn: () => imessage.on,
});

/** A fresh migrated database with the approved iMessage list (the first entry is the owner) and the agent. */
export function freshReplyDb(runMigrations: () => void, approved: string[] = [OWNER, PERSON, OTHER]): void {
  state.db?.close();
  state.db = new Database(':memory:');
  runMigrations();
  setApproved(approved);
  testDb().prepare("INSERT INTO agents (id, name, status, classification) VALUES (?, ?, 'idle', 'standard')").run(AGENT, AGENT);
  imessage.send.mockReset();
  imessage.send.mockResolvedValue(true);
  imessage.sendFile.mockReset();
  imessage.sendFile.mockResolvedValue(true);
  imessage.sent = [];
  imessage.on = true;
}

export function setApproved(addresses: string[]): void {
  testDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)").run(JSON.stringify(addresses));
}

export interface ReplyRow { id: string; outcome: string; attempts: number; next_attempt_at: number | null; turn_number: number | null; detail: string | null }
export const replyRows = (): ReplyRow[] => testDb().prepare(
  'SELECT id, outcome, attempts, next_attempt_at, turn_number, detail FROM deliveries WHERE payload_json IS NOT NULL ORDER BY rowid',
).all() as ReplyRow[];

/** The finalize router's inputs for a person's turn on `meta.channel`, answered with `text`. */
export function personTurn(text: string, meta: Partial<InboundMeta> & { channel: 'imessage' | 'teams' }, turnNumber = 1, inboundContext: object | null = null) {
  const sender = meta.sender ?? PERSON;
  const counterparty = { kind: 'user', name: 'a person', relation: 'known_contact', channel: meta.channel, senderId: sender, threadId: null, senderIsAgent: false };
  const address = { kind: 'person', isOwner: false, boundChannel: meta.channel, autoRoutes: true, deliveryChannel: meta.channel, routed: true, inboundChannel: meta.channel, senderId: sender };
  const root = { kind: 'ask', id: `ask-${turnNumber}`, sourceMessageId: null, conversationId: `conv-${sender}` };
  const turnState = { lastAssistantTextForIM: text, explicitSendThisTurn: {}, repliedToCounterpartyThisTurn: {}, steerQueue: { pending: [], fired: [] }, inboundChannel: meta.channel, inboundContext: inboundContext ?? { chatType: 'dm', recipientAddress: sender } };
  const ctx = { agentId: AGENT, turnNumber, turnCtx: { address, root, replyFiles: [] }, counterparty, chosenConvKey: 'c', settledContextWakeTurn: false, isEngineTurn: false, persistRoutingMarker: () => {} };
  return [turnState, ctx] as [never, never];
}
