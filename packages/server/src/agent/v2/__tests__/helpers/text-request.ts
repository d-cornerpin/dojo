// A person's iMessage request and the records its turn leaves: the turn row, the dashboard copy of the reply, the
// reply itself queued by finalize's router, and the turn's settlement. Use with the mocks of `reply-sender.ts`.
import { asTurn } from '../../../turn-context.js';
import { recordDelivery } from '../../deliveries.js';
import { routeTerminalReply } from '../../steps/finalize/route-reply.js';
import { settleAsksAtTurnFinalize } from '../../../../work/ask-settlement.js';
import { AGENT, PERSON, personTurn, testDb } from './reply-sender.js';

export const CONV = `conv-${PERSON}`;

/** The turn's record: ended with an answer, or still open, as a process death leaves it. */
export function turnRow(turnNumber: number, ended = true): void {
  testDb().prepare(
    `INSERT INTO turns (agent_id, turn_number, kind, started_at, ended_at, exit_reason, answered)
     VALUES (?, ?, 'user', datetime('now'), ${ended ? "datetime('now'), 'answered', 1" : 'NULL, NULL, 0'})`,
  ).run(AGENT, turnNumber);
}

/** The dashboard copy of the turn's reply, filed under the request's conversation. */
export function dashboardCopy(turnNumber: number, conversationId = CONV): void {
  asTurn(AGENT, { turnNumber, root: { kind: 'ask', id: 'm', sourceMessageId: null, conversationId }, convKey: null },
    () => recordDelivery({ agentId: AGENT, tool: 'dashboard', channel: 'dashboard', conversationId, outcome: 'delivered' }));
}

/** The turn ends with `text` as its iMessage reply: routed (queued or held) inside its turn, then settled. */
export async function endTurn(turnNumber: number, text: string): Promise<void> {
  const root = { kind: 'ask' as const, id: `ask-${turnNumber}`, sourceMessageId: null, conversationId: CONV };
  await asTurn(AGENT, { turnNumber, root, convKey: null }, () => routeTerminalReply(...personTurn(text, { channel: 'imessage' }, turnNumber)));
  settleAsksAtTurnFinalize({ agentId: AGENT, turnNumber });
}

export const askRow = (id: string): { state: string; result_delivery_id: string | null } =>
  testDb().prepare('SELECT state, result_delivery_id FROM work WHERE id = ?').get(id) as { state: string; result_delivery_id: string | null };
