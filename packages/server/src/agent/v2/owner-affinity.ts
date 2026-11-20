// Owner-channel affinity: an owner-addressed dashboard-default reply follows the owner to iMessage when their
// newest authorized inbound in the window was iMessage and the bridge is configured. Never for non-owners or
// voice/phone; promotions are rate-limited per conversation so background wakes cannot become a text storm.

import { deriveOrigin, legacyOriginInputs } from '@dojo/shared';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('owner-affinity');

/** Rows deriveOrigin needs to classify an inbound message. */
interface OwnerAffinityRow {
  content: string | null;
  source: string | null;
  source_agent_id: string | null;
  a2a_thread_id: string | null;
  a2a_intent: string | null;
  a2a_requires_response: number | null;
  inbound_meta: string | null;
  lane: string;
  channel: string | null;
  origin_intent: string | null;
  created_at: string;
}

export interface OwnerAffinityOpts {
  imessageBridgeConfigured: boolean;
  windowHours?: number;
}

/** 'imessage' when the newest authorized owner inbound in the window was iMessage and the bridge is configured,
 *  else null. iMessage is the only bridge the engine sends on proactively. */
export function resolveOwnerAffinityChannel(agentId: string, opts: OwnerAffinityOpts): 'imessage' | null {
  if (!opts.imessageBridgeConfigured) return null;
  const windowHours = Math.max(1, Math.floor(opts.windowHours ?? 48));
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT content, lane, channel, source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response,
              inbound_meta, origin_intent, datetime(created_at/1000,'unixepoch') AS created_at
         FROM messages
        WHERE agent_id = ? AND role = 'user'
          AND created_at >= (unixepoch('now', ?) * 1000)
        ORDER BY created_at DESC, rowid DESC
        LIMIT 100`,
    ).all(agentId, `-${windowHours} hours`) as OwnerAffinityRow[];
    for (const r of rows) {
      const o = deriveOrigin({
        role: 'user', content: r.content,
        ...legacyOriginInputs(r.lane, r.channel),
        sourceAgentId: r.source_agent_id,
        a2aThreadId: r.a2a_thread_id, a2aIntent: r.a2a_intent, a2aRequiresResponse: r.a2a_requires_response,
        inboundMeta: r.inbound_meta, originIntent: r.origin_intent,
      });
      // The newest authorized owner inbound defines where the owner is; skip notices, A2A and contacts.
      if (o.kind !== 'user' || o.relation !== 'owner' || !o.authorized) continue;
      // A last touch on the dashboard or voice means the owner is reachable there: no promotion.
      return o.channel === 'imessage' ? 'imessage' : null;
    }
  } catch (err) {
    logger.warn('resolveOwnerAffinityChannel failed (non-fatal)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
  return null;
}

// The cooldown lives on the conversation row (last_affinity_promo_at), so it survives a restart.

const DEFAULT_AFFINITY_COOLDOWN_HOURS = 4;

/** True when no promotion fired for this conversation within the cooldown. A null id allows it: reaching
 *  the owner comes first; the rate limit is a politeness bound, not a correctness gate. */
export function affinityPromotionAllowed(
  agentId: string,
  conversationId: string | null,
  cooldownHours: number = DEFAULT_AFFINITY_COOLDOWN_HOURS,
): boolean {
  if (!conversationId) return true;
  try {
    const db = getDb();
    const row = db.prepare('SELECT last_affinity_promo_at FROM conversations WHERE id = ?').get(conversationId) as
      | { last_affinity_promo_at: string | null }
      | undefined;
    if (!row?.last_affinity_promo_at) return true;
    const lastMs = Date.parse(row.last_affinity_promo_at.replace(' ', 'T') + 'Z');
    if (!Number.isFinite(lastMs)) return true;
    return Date.now() - lastMs >= Math.max(1, cooldownHours) * 60 * 60 * 1000;
  } catch {
    // On a read failure, allow the promotion (same politeness-bound reasoning).
    return true;
  }
}

// Affinity is convenience, not consent: refuse an iMessage promotion resting on affinity alone (no inbound this
// turn, owner not away). An iMessage counterparty lives in resolveReplyDestination.
export function affinityPromotionRefusedNoBasis(params: {
  ownerAffinityChannel: 'imessage' | null;
  inboundChannel: string | null;
  presence: 'in_dojo' | 'away';
  /** The turn is a person's ask (turn address kind 'person'), not an engine or notification turn. */
  personAskedHere?: boolean;
}): boolean {
  if (params.ownerAffinityChannel !== 'imessage') return false;
  // The owner asked on the dashboard this turn, so the dashboard is where they are: affinity never moves it.
  if (params.inboundChannel === 'dashboard' && params.personAskedHere === true) return true;
  return params.inboundChannel === null && params.presence !== 'away';
}

/** Record that an affinity promotion just fired for this conversation (starts the cooldown). */
export function recordAffinityPromotion(agentId: string, conversationId: string | null): void {
  if (!conversationId) return;
  try {
    const db = getDb();
    db.prepare(
      "UPDATE conversations SET last_affinity_promo_at = datetime('now') WHERE id = ?",
    ).run(conversationId);
  } catch (err) {
    logger.warn('recordAffinityPromotion failed (non-fatal)', {
      agentId, conversationId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}
