// A PERSON WHO MESSAGES AN AGENT THAT CANNOT RUN IS NOT MET WITH SILENCE: each waiting message is told once.

import { OWNER_ALERT_DOJO_PREFIX, OWNER_ALERT_HEADS_UP_PREFIX, type InboundMeta } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { broadcast } from '../../gateway/ws.js';
import { insertMessageIfAbsent } from '../../memory/message-store.js';
import { getMessagesByIds } from '../../memory/store.js';
import { createLogger } from '../../logger.js';
import { parkedCauseOf } from './honest-stop-lock.js';
import { queueReply } from './deliveries.js';
import { replyAddressFor } from './channel-sender.js';
import { engineAckReachesTheirChannel } from './counterparty.js';

const logger = createLogger('honest-stop');

/** What a person other than the owner hears on their own channel: no money figure, no provider detail. */
const CANNOT_RUN_LINE = `${OWNER_ALERT_DOJO_PREFIX} the agent cannot reply right now. The owner can see this.`;

/** A platform line in the agent's dashboard chat; false when a row with this id already exists. */
export function chatLine(agentId: string, id: string, content: string, conversationId?: string | null): boolean {
  if (!insertMessageIfAbsent({ id, agentId, role: 'system', content, conversationId })) return false;
  broadcast({ type: 'chat:message', agentId, message: { id, agentId, role: 'system', content, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() } });
  return true;
}

/** The agent cannot run: the open (or just-claimed) request on message `askRootId` is told ONCE (row id `park-note:<message>`), with
 *  `ownerWords` on the dashboard. A person other than the owner, on a channel the engine's own lines reach, also hears
 *  one neutral line there, once while any request of theirs that was told still waits.
 *  False when no open request waits on that message or it was already told. */
export async function tellCannotRun(agentId: string, askRootId: string, ownerWords: string): Promise<boolean> {
  const ask = getDb().prepare(`SELECT conversation_id AS conversationId FROM work WHERE kind = 'ask' AND agent_id = ? AND root_id = ? AND state IN ('open', 'claimed')`)
    .get(agentId, askRootId) as { conversationId: string | null } | undefined;
  if (!ask || !chatLine(agentId, `park-note:${askRootId}`, ownerWords, ask.conversationId)) return false;
  const [message] = getMessagesByIds([askRootId]);
  const o = message?.origin;
  // The owner is told on the dashboard only; the engine writes no line of its own by email.
  if (!message?.inboundMeta || !o || o.kind !== 'user' || o.relation === 'owner'
    || !engineAckReachesTheirChannel({ ...o, kind: 'user', channel: o.channel ?? 'dashboard', name: '', senderIsAgent: false })) return true;
  const toldInThisPark = getDb().prepare(`SELECT 1 FROM deliveries d JOIN work w ON w.kind = 'ask' AND w.agent_id = d.agent_id AND w.root_id = d.root_id
    WHERE d.agent_id = ? AND d.tool = 'cannot-run' AND d.conversation_id = ? AND w.state = 'open'`).get(agentId, ask.conversationId);
  if (toldInThisPark) return true;
  const meta = JSON.parse(message.inboundMeta) as Partial<InboundMeta>;
  const address = meta.channel ? replyAddressFor({ ...meta, channel: meta.channel }) : null;
  if (address) {
    const root = { kind: 'ask' as const, id: askRootId, sourceMessageId: askRootId, conversationId: ask.conversationId };
    await queueReply({ agentId, turnNumber: null, root, text: CANNOT_RUN_LINE, address, kind: 'cannot-run' });
  }
  return true;
}

/** The owner's dashboard line for a request that waits on its provider's reset at `retryAt`. */
export function providerWaitWords(agentId: string, retryAt: number): string {
  const name = (getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined)?.name ?? agentId;
  const at = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(retryAt);
  return `${OWNER_ALERT_DOJO_PREFIX} ${name}'s AI provider is limiting requests right now, so this message waits. It is answered when the limit clears, about ${at}.`;
}

/** Every still-open ask waiting on a parked agent is told (`tellCannotRun`) the plain cause; the message stays
 *  queued for release. `exceptRootId` is the message the park's own notice answered. */
export async function noteWaitingOfParked(agentId: string, exceptRootId?: string | null): Promise<void> {
  try {
    const db = getDb();
    const row = db.prepare('SELECT status, last_error FROM agents WHERE id = ?').get(agentId) as { status: string; last_error: string | null } | undefined;
    const cause = parkedCauseOf(row?.status, row?.last_error);
    if (!cause) return;
    const waiting = db.prepare(`SELECT root_id AS rootId FROM work
      WHERE kind = 'ask' AND agent_id = ? AND state = 'open' AND root_id IS NOT NULL ORDER BY opened_at`).all(agentId) as Array<{ rootId: string }>;
    for (const { rootId } of waiting) {
      if (rootId !== exceptRootId) await tellCannotRun(agentId, rootId, `${OWNER_ALERT_HEADS_UP_PREFIX} ${cause}`);
    }
  } catch (err) {
    logger.warn('honest stop: could not answer a waiting message', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
  }
}
