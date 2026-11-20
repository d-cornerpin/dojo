// Shared setup for the relay tests: a request that came by iMessage, delegated to a helper whose answer comes back
// through the real transport door. Each file mocks, besides the reply-sender fakes (`v2/__tests__/helpers/reply-sender.ts`):
//
//   vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));
//   vi.mock('../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
//   vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
//   vi.mock('../../memory/embeddings.js', () => ({ generateEmbedding: async () => new Float32Array(8), queueEmbedding: () => {} }));
import { vi } from 'vitest';
import { runMigrations } from '../../../db/migrations.js';
import { insertMessage } from '../../../memory/message-store.js';
import { claimAsk, stampClaimingTurn, openDelegationJoin } from '../../../work/store.js';
import { newestPutBack, recordPiecesShown, settleAsksAtTurnFinalize } from '../../../work/ask-settlement.js';
import { deliverA2AMessage } from '../../a2a-transport.js';
import { freshReplyDb, imessage, testDb, AGENT, PERSON } from '../../v2/__tests__/helpers/reply-sender.js';

export const HELPER = 'agent-helper';
export const ASK = 'ask:m-ask';
export const CONV = 'conv-text';
export const THREAD = 'thread-relay-0001';

/** A person asked by iMessage (`meta` adds to the request's inbound record); the agent delegated it on `threads`
 *  and its turn ended, holding the request on the delegation. */
export function delegatedTextRequest(meta: Record<string, unknown> = {}, threads: string[] = [THREAD]): void {
  // The sender's own timer never fires and the clock stands still: each test drives the sender itself.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  freshReplyDb(runMigrations);
  testDb().prepare("INSERT INTO agents (id, name, status, classification) VALUES (?, 'Helper', 'idle', 'standard')").run(HELPER);
  testDb().prepare("INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at) VALUES (?, ?, 'imessage', 'imessage', ?, datetime('now'))")
    .run(CONV, AGENT, PERSON);
  insertMessage({
    id: 'm-ask', agentId: AGENT, role: 'user', content: 'Ask the helper when the venue is free', channel: 'imessage',
    senderId: PERSON, conversationId: CONV, inboundMeta: JSON.stringify({ channel: 'imessage', sender: PERSON, relation: 'known_contact', ...meta }),
  });
  claimAsk(ASK, AGENT);
  stampClaimingTurn(ASK, 1);
  openDelegationJoin({
    parentWorkId: ASK, agentId: AGENT, replyConversationId: CONV, ttlAt: Date.now() + 3_600_000,
    threads: threads.map((threadId) => ({ threadId, assigneeAgent: HELPER, intent: 'QUESTION', hopCount: 0 })),
  });
  settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: 1 });
}

/** The helper's answer, through the real transport door; `attachments` are files it hands back. */
export async function helperAnswers(payload: string, thread = THREAD, attachments?: string[]): Promise<void> {
  const r = await deliverA2AMessage({
    intent: 'ANSWER', threadId: thread, requiresResponse: false, payload, toAgent: AGENT, fromAgent: HELPER,
    ...(attachments ? { attachPaths: attachments } : {}),
  } as never);
  if (!r.delivered) throw new Error('the helper\'s answer was not delivered');
}

/** A turn serves the request once its answer is back, is shown the pieces, and says nothing, its required reply
 *  empty too: A stands the request down and the Dojo relays the pieces (after commit, so this waits for it). */
export async function agentStaysSilent(turn = 2): Promise<void> {
  claimAsk(ASK, AGENT);
  stampClaimingTurn(ASK, turn);
  const putBack = newestPutBack(ASK);
  if (putBack) recordPiecesShown(ASK, AGENT, turn, putBack.id);
  settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber: turn, forcedEmpty: true });
  await vi.dynamicImportSettled();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

/** The relayed text a person receives for a one-piece answer. */
export const relayed = (answer: string): string => `Dojo: The helper's answer, as it was delivered:\n\n${answer}`;

export interface RelayRow { id: string; tool: string; outcome: string; root_kind: string | null; root_id: string | null; turn_number: number | null; payload_json: string }
export const relayRows = (): RelayRow[] => testDb().prepare(
  `SELECT id, tool, outcome, root_kind, root_id, turn_number, payload_json FROM deliveries
    WHERE json_extract(payload_json, '$.joinId') IS NOT NULL ORDER BY rowid`,
).all() as RelayRow[];

/** Every iMessage send's text, in order. */
export const textsSent = (): string[] => imessage.send.mock.calls.map((c) => c[1]);

export const requestState = (): string => (testDb().prepare('SELECT state FROM work WHERE id = ?').get(ASK) as { state: string }).state;
