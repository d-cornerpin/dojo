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
import { turnRow } from '../../v2/__tests__/helpers/live-turn.js';

export const HELPER = 'agent-helper';
export const ASK = 'ask:m-ask';
export const CONV = 'conv-text';
export const THREAD = 'thread-relay-0001';

/** A person asked by iMessage (`meta` adds to the request's inbound record); the agent asked the helper on `threads`,
 *  delegated it there and its turn ended, holding the request on the delegation. */
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
  turnRow(AGENT, 1, { kind: 'ask', id: 'm-ask' });   // the delegating turn
  claimAsk(ASK, AGENT);
  stampClaimingTurn(ASK, 1);
  // The agent's request on each thread reaches the helper first, as the transport writes it; the join is opened from it.
  for (const t of threads) {
    insertMessage({ id: `req-${t}`, agentId: HELPER, role: 'user', lane: 'a2a', sourceAgentId: AGENT, a2aThreadId: t, a2aIntent: 'QUESTION',
      a2aRequiresResponse: true, content: `[A2A:QUESTION thread:${t.slice(0, 8)} from:Agent] When is the venue free?` } as never);
  }
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
  turnRow(AGENT, turn, null);
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

/** The helper's own task for the request, on its thread, under `parent` when given. */
export function helperTask(parent: string | null = null): string {
  testDb().prepare(`INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, a2a_thread_id, parent_id, opened_at, updated_at)
    VALUES ('task-helper-1', 'task', ?, 'agent', 'tracker', 'task-helper-1', 'claimed', 'ASSIGN', 0, 0, 'Check the venue', ?, ?, ?, ?)`).run(HELPER, THREAD, parent, Date.now(), Date.now());
  return 'task-helper-1';
}

/** The "no answer" notices queued for the person, and the engine lines the agent was given about it. */
export const failedNotices = (): number => relayRows().filter((r) => r.tool === 'a2a-join-failed').length;
export const agentLines = (): number => (testDb().prepare("SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND origin_intent = 'fanout_join'").get(AGENT) as { n: number }).n;

/** Every engine pass an event started has run. */
export async function passesRun(): Promise<void> {
  await vi.dynamicImportSettled();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

/** The helper's turn `n` took its request on `thread` (every thread when none) and ended as `exit` (null: still running). */
export function served(exit: string | null = 'answered', n = 1, thread: string | null = null): void {
  testDb().prepare(`INSERT INTO turns (agent_id, turn_number, started_at, ended_at, answered, exit_reason)
    VALUES (?, ?, datetime('now', '-60 seconds'), CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END, 0, ?)`).run(HELPER, n, exit, exit);
  testDb().prepare("UPDATE messages SET served_by_turn = ? WHERE agent_id = ? AND a2a_intent = 'QUESTION' AND (? IS NULL OR a2a_thread_id = ?)").run(n, HELPER, thread, thread);
}
