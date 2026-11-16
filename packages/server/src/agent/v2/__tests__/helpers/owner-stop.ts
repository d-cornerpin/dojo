// The owner's Stop button, pressed through the real route, and a request claimed by a turn. Use with the
// mocks of `reply-sender.ts`, plus `gateway/ws.js` faked.
import { agentsRouter } from '../../../../gateway/routes/agents.js';
import { openAsk, claimAsk, stampClaimingTurn } from '../../../../work/store.js';
import { AGENT, testDb } from './reply-sender.js';

export async function pressStop(): Promise<{ status: number; body: { ok: boolean; data?: { repliesNotSent?: number }; error?: string } }> {
  const res = await agentsRouter.request(`/${AGENT}/stop`, { method: 'POST' });
  return { status: res.status, body: await res.json() as { ok: boolean; data?: { repliesNotSent?: number } } };
}

/** A request in `conversationId`, picked up by `turnNumber`; returns its id. */
export function claimedAsk(messageId: string, conversationId: string, turnNumber: number): string {
  testDb().prepare("INSERT OR IGNORE INTO conversations (id, agent_id, channel, provider, counterparty_id) VALUES (?, ?, 'imessage', 'imessage', ?)")
    .run(conversationId, AGENT, conversationId);
  const id = openAsk({ agentId: AGENT, messageId, conversationId, requesterId: null, openedAt: Date.now(), title: null });
  claimAsk(id, AGENT);
  stampClaimingTurn(id, turnNumber);
  return id;
}

export const askState = (id: string): string => (testDb().prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;

export const pills = (): string[] => (testDb().prepare(
  "SELECT content FROM messages WHERE agent_id = ? AND role = 'system' ORDER BY rowid",
).all(AGENT) as Array<{ content: string }>).map((r) => r.content);
