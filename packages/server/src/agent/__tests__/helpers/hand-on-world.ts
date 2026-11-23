// A request handed on through the real doors: the owner texts the main agent, and each agent's response runs through
// the real execute step (the gates, the real tool, the turn end). Same mocks as the relay world (`text-relay.ts`).
import { vi } from 'vitest';
import { runMigrations } from '../../../db/migrations.js';
import { insertMessage } from '../../../memory/message-store.js';
import { claimAsk } from '../../../work/store.js';
import { clearPlatformConfigCache } from '../../../config/platform.js';
import { agentRequests } from '../../v2/owed.js';
import { advance, initState } from '../../v2/state.js';
import { runExecute, type ExecuteContext, type ExecuteOutcome } from '../../v2/steps/execute/index.js';
import { endTurnContext, turnContext } from '../../turn-context.js';
import { activeRuns, stoppedAgents, stopFencedRuns } from '../../shared-state.js';
import { untrackedWorkAcrossTurns } from '../../turn-state.js';
import { liveTurn } from '../../v2/__tests__/helpers/live-turn.js';
import { computeTurnAddress } from '../../v2/turn-address.js';
import { freshReplyDb, testDb, AGENT, OWNER } from '../../v2/__tests__/helpers/reply-sender.js';

export const CORA = 'agent-cora';
export const BOT = 'agent-bot';
export const THIRD = 'agent-third';
export const CONV = 'conv-owner-text';
export const ASK = 'ask:m-owner';
const NAMES: Record<string, string> = { [AGENT]: 'Kevin', [CORA]: 'Cora', [BOT]: 'BehaviorBot', [THIRD]: 'Packer' };

export function world(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  freshReplyDb(runMigrations);
  for (const id of [CORA, BOT, THIRD]) testDb().prepare("INSERT INTO agents (id, name, status, classification) VALUES (?, ?, 'idle', 'standard')").run(id, NAMES[id]);
  testDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(AGENT);
  clearPlatformConfigCache();
  testDb().prepare("INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at) VALUES (?, ?, 'imessage', 'imessage', ?, datetime('now'))")
    .run(CONV, AGENT, OWNER);
  for (const id of Object.keys(NAMES)) endTurnContext(id);
  activeRuns.clear(); stoppedAgents.clear(); stopFencedRuns.clear(); untrackedWorkAcrossTurns.clear();
}

/** The owner's text to the main agent, and the main agent's turn `n` on it, as the bridge and turn start write them. */
export function ownerAsks(text: string, n = 1): void {
  insertMessage({ id: 'm-owner', agentId: AGENT, role: 'user', content: text, channel: 'imessage', senderId: OWNER, conversationId: CONV,
    inboundMeta: JSON.stringify({ channel: 'imessage', sender: OWNER, relation: 'owner' }) });
  claimAsk(ASK, AGENT);
  liveTurn(AGENT, { turnNumber: n, convKey: `imessage:${OWNER}`, root: { kind: 'ask', id: 'm-owner', sourceMessageId: 'm-owner', conversationId: CONV },
    address: computeTurnAddress({ counterparty: { kind: 'user', relation: 'owner' } as never, isEngineTurn: false, inboundChannel: 'imessage', autoRoutes: true } as never) });
  activeRuns.add(AGENT);
}

/** `agent`'s turn `n` on the request another agent sent it, as the turn start picks it (the oldest one owed). */
export function agentTurnOnItsRequest(agent: string, n = 1): string {
  const request = agentRequests(agent, Date.now() + 1)[0];
  if (!request) throw new Error(`${agent} has no request to serve`);
  liveTurn(agent, { turnNumber: n, kind: 'a2a', servedRequest: request, root: { kind: 'a2a', id: request.threadId, sourceMessageId: null } });
  activeRuns.add(agent);
  return request.threadId;
}

/** One model response of `agent`'s live turn, run through the real execute step. */
export async function respond(agent: string, calls: Array<[string, Record<string, unknown>]>, o: { reply?: string } = {}): Promise<ExecuteOutcome> {
  const turnCtx = turnContext(agent)!;
  const turnNumber = turnCtx.turnNumber!;
  const main = agent === AGENT;
  const thread = turnCtx.root?.kind === 'a2a' ? turnCtx.root.id : null;
  const toolCalls = calls.map(([name, args], i) => ({ id: `tc-${agent}-${turnNumber}-${i}`, name, arguments: args }));
  const state = advance(initState({
    agentId: agent, contextWindow: 100_000, isAutoRouted: false, configuredModelId: 'm', turnNumber, triggeredByIMessage: main,
    triggeredByA2AReplyIntent: null, lastUserMessageContent: null, lastUserMessageId: main ? 'm-owner' : null,
    inboundChannel: main ? 'imessage' : 'a2a', inboundContext: null,
  } as never), { phase: 'execute', loopCount: 1 });
  const triggerRow = main ? testDb().prepare("SELECT seq AS rowid FROM messages WHERE id = 'm-owner'").get() as { rowid: number } : null;
  return runExecute(state, {
    agentId: agent, turnCtx, turnNumber, db: testDb(), agent: { name: NAMES[agent] },
    counterparty: main
      ? { kind: 'user', name: 'Owner', relation: 'owner', channel: 'imessage', senderId: OWNER, threadId: null, senderIsAgent: false }
      : { kind: 'agent', name: 'Kevin', relation: 'agent', channel: 'a2a', senderId: 'Kevin', threadId: thread, senderIsAgent: false },
    counterpartyIsAgentSender: false, chosenConvKey: turnCtx.convKey ?? null, hasUnansweredUser: main,
    triggerRow, triggerWorkId: main ? ASK : null, triggerConversationId: main ? CONV : null,
    turnStartedAt: new Date().toISOString(), persistRoutingMarker: () => undefined,
    engineStartAckDeliveredThisTurn: false, deferredDeliveredByAck: false, refusedOnceSigs: new Set<string>(),
    startAckArmed: false, startAckArmedAtMs: 0, fireStartAckIfOwed: async () => undefined,
    result: { content: o.reply ?? '', toolCalls, inputTokens: 1, outputTokens: 1, stopReason: 'tool_use' } as unknown as ExecuteContext['result'],
    messageId: `resp-${agent}-${turnNumber}`, persistedContent: o.reply ?? null, interAgentTurn: !main, hasXmlFallbackTools: false,
    effectiveModelIdForPersist: 'm', staleTaskWindowMinutes: 30, engineStartAckAfterMs: 30_000,
  });
}

/** The turn is over: its bag closes and it no longer runs. */
export function turnEnds(agent: string): void { endTurnContext(agent); activeRuns.delete(agent); }

export const assign = (to: string, payload: string): [string, Record<string, unknown>] => ['send_to_agent', { agent: NAMES[to], intent: 'ASSIGN', payload }];
export const piecesUnder = (parent: string): Array<{ id: string; state: string; assignee_agent: string }> =>
  testDb().prepare('SELECT id, state, assignee_agent FROM work WHERE parent_id = ? ORDER BY rowid').all(parent) as never;
export const jobOf = (agent: string): { id: string; state: string } =>
  testDb().prepare("SELECT id, state FROM work WHERE kind = 'task' AND root_kind <> 'a2a_thread' AND agent_id = ? ORDER BY rowid DESC LIMIT 1").get(agent) as never;
export const engineCards = (): number => (testDb().prepare("SELECT COUNT(*) AS n FROM work WHERE root_kind = 'engine_scaffold'").get() as { n: number }).n;
export { AGENT };
