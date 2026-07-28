// ════════════════════════════════════════
// RC-10: owner-channel affinity for proactive / notification-default replies
// ════════════════════════════════════════
//
// A follow-up about a conversation should reach the owner on the channel the
// conversation actually lives on. Notification / engine-triggered turns resolve to
// inboundChannel:'dashboard', and the reply-destination resolver only promoted to
// iMessage when presence === 'away' (a manual composer toggle nobody maintains). So
// the production "what did you text me?" nags about an iMessage thread went to the
// dashboard, where the owner was not, and the open loop could never close (H-1).
//
// resolveOwnerAffinityChannel answers "where does the owner actually converse right
// now?" from the durable message store: if the owner's most recent authorized inbound
// was iMessage within a 48h window and the bridge is configured, an owner-addressed
// dashboard-default reply routes to iMessage instead. The presence-away override
// remains the stronger promotion; this never applies to non-owner counterparties or
// to voice/phone (a live conversation is not a proactive text). Promotions are
// rate-limited (at most one per conversation per cooldown) so a flurry of background
// wakes can't turn into a flurry of texts.
//
// Reads only for the resolver; the rate-limit last-promotion timestamp lives ON
// the conversation row (conversations.last_affinity_promo_at, P5c) so the
// cooldown survives a restart and belongs to the identity it limits.

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
  /** Whether the iMessage bridge is configured (affinity to iMessage requires it). */
  imessageBridgeConfigured: boolean;
  /** Look-back window for "the owner's most recent contact"; default 48h. */
  windowHours?: number;
}

/**
 * The channel the owner most recently reached the agent on, when that is a routed
 * channel we can proactively reach them on. Today only iMessage qualifies (the away
 * override's only promotion target and the only bridge the engine sends on
 * proactively). Returns 'imessage' when the newest authorized owner inbound within
 * the window was iMessage and the bridge is configured, else null.
 */
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
      // The newest authorized OWNER inbound is the one that defines "where the owner
      // is." Skip engine notices, A2A, contacts, and unauthorized notifications.
      if (o.kind !== 'user' || o.relation !== 'owner' || !o.authorized) continue;
      // Found the newest owner inbound. Affinity applies only if that contact was on
      // iMessage; if the owner's last touch was the dashboard (or voice/phone), they
      // are reachable there and no promotion is warranted.
      return o.channel === 'imessage' ? 'imessage' : null;
    }
  } catch (err) {
    logger.warn('resolveOwnerAffinityChannel failed (non-fatal)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
  return null;
}

// ── Rate-limit: at most one affinity promotion per conversation per cooldown ──
//
// This fix makes proactive nags REACH the phone, so it ships with a rate limit: a
// background-wake storm (settled-context re-chases, mailbox chatter) must not become a
// text storm. P5c rekey: the last-promotion timestamp is a COLUMN on the conversation
// row (the identity being limited), not a per-convKey key in the config table.

const DEFAULT_AFFINITY_COOLDOWN_HOURS = 4;

/** True when no affinity promotion has fired for this conversation within the
 *  cooldown. A null conversation id (identity unresolvable) allows the
 *  promotion: reaching the owner is the priority; the rate limit is a
 *  politeness bound, not a correctness gate. */
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

// ── Turn-anchored auto-route basis (phantom-outreach fix, 2026-07-18) ──
//
// The 3:32 AM phantom incident: a background wake with NO inbound this turn produced
// user-facing text, and the v2.7.23 auto-route promoted it to the owner's phone on
// channel AFFINITY ALONE (the owner's most-recent channel), inboundChannel null,
// presence in_dojo. Affinity is a convenience, not consent: it must never be the SOLE
// basis for a proactive text. This predicate answers "must the affinity-driven
// iMessage promotion be refused this turn for lack of an affirmative basis?" It is
// refused exactly when affinity resolved to iMessage but there was NO inbound this
// turn AND the owner is NOT away. The two affirmative bases that KEEP an iMessage
// promotion live in resolveReplyDestination and are unaffected here: a human iMessage
// counterparty (inbound bound to iMessage, Layer 1) and the away-owner promotion
// (presence 'away', Layer 2). Pure + deterministic so the route-basis decision is
// unit-testable in isolation.
export function affinityPromotionRefusedNoBasis(params: {
  ownerAffinityChannel: 'imessage' | null;
  inboundChannel: string | null;
  presence: 'in_dojo' | 'away';
}): boolean {
  // Only meaningful when affinity actually resolved to a proactive channel this turn;
  // with no affinity there is nothing to refuse.
  if (params.ownerAffinityChannel !== 'imessage') return false;
  // Refused when the promotion would rest on affinity ALONE: no inbound this turn and
  // the owner is not away. (An away owner keeps the promotion via the away override;
  // a real inbound this turn is itself the affirmative basis.)
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
