// The call-off world, on top of the relay world (`text-relay.ts`, same mocks): a request delegated to a helper with
// its job task, the agent's own cards for it, a second helper, and the doors the owner and the agents call work off by.
import { vi, expect } from 'vitest';
import { executeTool, toolResultOf } from '../../tools/index.js';
import { insertMessage } from '../../../memory/message-store.js';
import { inboundIMessageText } from '../../../tools/inbound-fences.js';
import { clearPlatformConfigCache } from '../../../config/platform.js';
import { claimAsk, openDelegationJoin } from '../../../work/store.js';
import { trackerRouter } from '../../../gateway/routes/tracker.js';
import { deliverA2AMessage } from '../../a2a-transport.js';
import { endTurnContext } from '../../turn-context.js';
import { activeRuns, stoppedAgents, stopFencedRuns, isStopFenced } from '../../shared-state.js';
import { liveTurn } from '../../v2/__tests__/helpers/live-turn.js';
import { computeTurnAddress } from '../../v2/turn-address.js';
import { testDb, AGENT, PERSON } from '../../v2/__tests__/helpers/reply-sender.js';
import { delegatedTextRequest, helperTask, ASK, CONV, HELPER, THREAD } from './text-relay.js';

export const SECOND = 'agent-second';
export const T2 = 'thread-second-0002';   // its short token differs from THREAD's
const now = (): number => Date.now();

export const settled = async (): Promise<void> => { for (let i = 0; i < 6; i++) { await vi.dynamicImportSettled(); await new Promise((r) => setImmediate(r)); } };
export const call = async (agent: string, name: string, args: Record<string, unknown>) => toolResultOf(await executeTool(agent, { id: `tc-${name}-${now()}`, name, arguments: args }));

/** A row's state and who ended it (`by` of its newest move into that state). */
export const endedBy = (id: string): { state: string; by: string | null } | undefined => testDb().prepare(`SELECT w.state,
    (SELECT json_extract(e.payload, '$.by') FROM work_events e WHERE e.work_id = w.id AND e.kind = 'transition'
      AND json_extract(e.payload, '$.to') = w.state ORDER BY e.id DESC LIMIT 1) AS by FROM work w WHERE w.id = ?`).get(id) as never;
export const stateOf = (id: string): string | undefined => (testDb().prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string } | undefined)?.state;
export const pieceOf = (thread = THREAD): string => (testDb().prepare("SELECT id FROM work WHERE root_kind = 'a2a_thread' AND root_id = ?").get(thread) as { id: string }).id;

/** A person's request (the owner's unless `relation` says a contact) delegated to the helper, with its job task; the
 *  helper is mid-turn on it. `threads` adds a second helper per extra thread. The agent is the main agent. */
export function delegated(relation: 'owner' | 'known_contact' = 'owner', threads: string[] = [THREAD]): void {
  for (const id of [AGENT, HELPER, SECOND]) endTurnContext(id);
  activeRuns.clear(); stoppedAgents.clear(); stopFencedRuns.clear();
  delegatedTextRequest({ relation }, threads);
  testDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(AGENT);
  clearPlatformConfigCache();
  helperTask();
  if (threads.length > 1) {
    testDb().prepare("INSERT INTO agents (id, name, status, classification) VALUES (?, 'Second', 'idle', 'standard')").run(SECOND);
    testDb().prepare("UPDATE work SET assignee_agent = ? WHERE root_kind = 'a2a_thread' AND root_id = ?").run(SECOND, T2);
    task('task-second-1', { holder: SECOND, thread: T2, card: false });
    helperBusy(SECOND);
  }
  helperBusy(HELPER);
}

/** A task: by default one of the agent's own cards for the request (linked by requester and message). */
export function task(id: string, o: { holder?: string; thread?: string | null; card?: boolean; parent?: string | null; state?: string } = {}): string {
  testDb().prepare(`INSERT INTO work (id, kind, agent_id, requester, requester_id, source_message_id, root_kind, root_id, state, intent, wakes, closes_thread,
      title, a2a_thread_id, parent_id, opened_at, updated_at) VALUES (?, 'task', ?, 'agent', ?, ?, 'tracker', ?, ?, 'ASSIGN', 0, 0, ?, ?, ?, ?, ?)`)
    .run(id, o.holder ?? AGENT, o.card === false ? null : AGENT, o.card === false ? null : 'm-ask', id, o.state ?? 'claimed', `Step ${id}`,
      o.thread ?? null, o.parent ?? null, now() - 1000, now() - 1000);
  return id;
}

/** `agent` is in a turn on its job's thread, recorded as the product records it. */
export function helperBusy(agent: string, thread = agent === SECOND ? T2 : THREAD): void {
  liveTurn(agent, { turnNumber: 1, root: { kind: 'a2a', id: thread, sourceMessageId: null } });
  activeRuns.add(agent);
}
export const stopped = (agent: string): boolean => isStopFenced(agent);

/** The helper `under`'s job is handed on to `to` on `thread`: a piece under the job task, and `to`'s own job task. */
export function handedOn(underTask: string, from: string, to: string, thread: string, toTask: string): void {
  testDb().prepare("INSERT OR IGNORE INTO agents (id, name, status, classification) VALUES (?, ?, 'idle', 'standard')").run(to, to);
  openDelegationJoin({ parentWorkId: underTask, agentId: from, replyConversationId: null, ttlAt: now() + 3_600_000,
    threads: [{ threadId: thread, assigneeAgent: to, intent: 'ASSIGN', hopCount: 0 }] });
  task(toTask, { holder: to, thread, card: false });
  helperBusy(to, thread);
}

/** A message `id` from the person (the owner unless `relation` says a contact) by text, or the owner's on the dashboard,
 *  and the agent's turn on it, as the bridge and turn start write them. */
export function ownerTurn(id: string, text: string, relation: 'owner' | 'known_contact' | 'dashboard' = 'owner', turnNumber = 2): void {
  const dash = relation === 'dashboard';
  const conv = dash ? 'conv-dash' : CONV;
  if (dash) testDb().prepare("INSERT OR IGNORE INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at) VALUES (?, ?, 'dashboard', 'dashboard', 'owner', datetime('now'))").run(conv, AGENT);
  insertMessage({ id, agentId: AGENT, role: 'user', content: dash ? text : inboundIMessageText(relation === 'owner', PERSON, text), channel: dash ? 'dashboard' : 'imessage',
    senderId: dash ? 'owner' : PERSON, conversationId: conv, ...(dash ? {} : { inboundMeta: JSON.stringify({ channel: 'imessage', sender: PERSON, relation }) }) });
  claimAsk(`ask:${id}`, AGENT);
  liveTurn(AGENT, { turnNumber, root: { kind: 'ask', id, sourceMessageId: id, conversationId: conv },
    address: computeTurnAddress({ counterparty: { kind: 'user', relation: relation === 'known_contact' ? 'known_contact' : 'owner' } as never,
      isEngineTurn: false, inboundChannel: dash ? 'dashboard' : 'imessage', autoRoutes: true } as never) });
}

/** The board's own doors. */
const board = async (path: string, init: RequestInit): Promise<number> => (await trackerRouter.request(path, init)).status;
export const boardCancel = (id: string): Promise<number> => board(`/tasks/${id}/decision`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verdict: 'cancel', reason: 'Not needed any more' }) });
export const boardDelete = (id: string): Promise<number> => board(`/tasks/${id}`, { method: 'DELETE' });

/** A helper's final reply on its thread to the agent that asked it, through the transport: true when it reached it. */
export const lateReply = async (from = HELPER, thread = THREAD, to = AGENT): Promise<boolean> => (await deliverA2AMessage({
  intent: 'COMPLETE', threadId: thread, requiresResponse: true, payload: 'Done anyway.', toAgent: to, fromAgent: from } as never)).delivered;

export const expectEndedAsHis = (...ids: string[]): void => { for (const id of ids) expect(endedBy(id), id).toEqual({ state: 'abandoned', by: 'owner' }); };
export { ASK, HELPER, THREAD, AGENT };
