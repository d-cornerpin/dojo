// An agent over its spending limit, and messages that reach it on iMessage. Each file mocks the reply-sender fakes
// (`./reply-sender.ts`) and `sendAlert`. `stopOn` runs the turn loop's recovery step for the turn that hit the limit.
import { insertMessage } from '../../../../memory/message-store.js';
import { AgentError } from '../../../errors.js';
import { BUDGET_STOP_CODE } from '../../honest-stop-lock.js';
import { tryHonestStopRecovery } from '../../honest-stop.js';
import { initState, advance, type AgentTurnState } from '../../state.js';
import { testDb, AGENT } from './reply-sender.js';

/** Today's limit is $1.00 and $2.00 is spent. */
export function overBudget(): void {
  testDb().prepare("INSERT OR REPLACE INTO budgets (id, scope, limit_usd, period) VALUES ('global_daily', 'global', 1, 'daily')").run();
  testDb().prepare("INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens, cost_usd) VALUES ('spent', ?, 'm', 'p', 1, 1, 2)").run(AGENT);
}

/** A message from `sender` on `channel` (iMessage unless named); `extra` lands in its inbound record. */
export function textFrom(id: string, sender: string, extra: Record<string, unknown> = {}, channel: 'imessage' | 'email' = 'imessage'): void {
  const conversationId = `conv-${sender}`;
  testDb().prepare("INSERT OR IGNORE INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
    .run(conversationId, AGENT, channel, channel, sender);
  insertMessage({
    id, agentId: AGENT, role: 'user', content: 'Is the north dock open today?', turnNumber: 1, channel, senderId: sender,
    conversationId, inboundMeta: JSON.stringify({ channel, sender, recipientAddress: sender, authorized: true, ...extra }),
  });
}

export function stopOn(messageId: string): Promise<boolean> {
  const state: AgentTurnState = advance(initState({ agentId: AGENT, turnNumber: 1 } as Parameters<typeof initState>[0]), { lastUserMessageId: messageId } as Partial<AgentTurnState>);
  return tryHonestStopRecovery(state, new AgentError('over the limit', AGENT, { code: BUDGET_STOP_CODE }));
}

export const sentRows = () => testDb().prepare('SELECT tool, outcome, payload_json FROM deliveries WHERE payload_json IS NOT NULL ORDER BY rowid')
  .all() as Array<{ tool: string; outcome: string; payload_json: string }>;
export const parkNotes = () => testDb().prepare("SELECT id, content FROM messages WHERE id LIKE 'park-note:%' ORDER BY rowid")
  .all() as Array<{ id: string; content: string }>;
