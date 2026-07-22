// ════════════════════════════════════════
// RC-12: engine-verified outbound ledger (delivery-claim grounding)
// ════════════════════════════════════════
//
// The delivery-claim guard used to read one turn's tool activity, only in the
// positive direction, and its correction never reached the model. This module is
// the durable, cross-turn fact source that fixes both directions:
//
//   findRecentDeliveries(agentId, recipientHint, windowHours)
//     "did I actually send anything to <recipient> in the last N hours?" Resolves
//     the hint name<->address via the contacts store, then matches tool_receipts
//     by recipient (any resolved handle OR a name substring). Used by BOTH guard
//     directions: the POSITIVE guard consults it before firing (a real prior send
//     grounds a "sent it" claim, so it does not false-fire into a duplicate send),
//     and the DENIAL guard consults it to catch "not yet / sending now" said after
//     a receipted send.
//
//   getRecentOutbound(agentId, windowHours, limit)
//     the last N sends, recipient-agnostic, for the RECENT OUTBOUND block the loop
//     injects on human turns (an engine fact that survives conversation scoping).
//
// Receipts are ENGINE-written (receipts/store.ts); nothing here trusts model text.
// Reads only, no side effects.

import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { channelOfSendTool, type ChannelKind } from '@dojo/shared';
import { findMatchingContact } from '../../contacts/store.js';
import { recipientIdsMatch } from '../recipient-identity.js';
import type { ToolReceiptRow } from '../../receipts/store.js';

const logger = createLogger('outbound-ledger');

export interface OutboundDelivery {
  tool: string;
  /** Human-facing channel label for the send tool, or 'a2a' for inter-agent. */
  channel: ChannelKind | 'a2a';
  recipient: string | null;
  sentText: string | null;
  convKey: string | null;
  turnNumber: number | null;
  verified: boolean;
  createdAt: string;
}

/** Map a receipt's tool to its channel (a2a for the inter-agent sends). */
function channelOfTool(tool: string): ChannelKind | 'a2a' {
  if (tool === 'send_to_agent' || tool === 'broadcast_to_group') return 'a2a';
  return channelOfSendTool(tool) ?? 'a2a';
}

function rowToDelivery(r: ToolReceiptRow): OutboundDelivery {
  return {
    tool: r.tool,
    channel: channelOfTool(r.tool),
    recipient: r.recipient,
    sentText: r.sent_text,
    convKey: r.conv_key,
    turnNumber: r.turn_number,
    verified: r.verified === 1,
    createdAt: r.created_at,
  };
}

/**
 * Every address / handle / name a recipient hint could match, lower-cased. Resolves
 * a bare name to its stored emails/phones/iMessage handles (and vice-versa) via the
 * contacts store so a receipt recorded under a phone number still matches a claim
 * that named the person, and the reverse. Always includes the raw hint itself.
 */
function resolveRecipientAliases(recipientHint: string): string[] {
  const hint = recipientHint.trim();
  const aliases = new Set<string>();
  if (hint) aliases.add(hint.toLowerCase());
  try {
    // The hint might be a name OR an address; try both directions.
    const byName = findMatchingContact({ displayName: hint });
    const byAddr = findMatchingContact({
      emails: [hint], phones: [hint], imessageHandles: [hint],
    });
    for (const c of [byName, byAddr]) {
      if (!c) continue;
      aliases.add(c.displayName.toLowerCase());
      if (c.preferredName) aliases.add(c.preferredName.toLowerCase());
      for (const a of [...c.emails, ...c.phones, ...c.imessageHandles]) {
        if (a.trim()) aliases.add(a.trim().toLowerCase());
      }
    }
  } catch {
    /* contacts read is best-effort; the raw hint alias still stands */
  }
  return [...aliases].filter(Boolean);
}

/** True when a receipt's recipient matches ANY of the resolved aliases. Substring
 *  both ways so "the owner" matches a recipient stored as "the owner <+1555…>" and a raw
 *  phone alias matches a receipt recipient that carries only the number. Exported for
 *  the RC-1 gate-(c) test: the pending-question header only ever quotes sends TO the
 *  current counterparty, which this recipient filter is what guarantees. */
export function recipientMatchesAliases(recipient: string | null, aliases: string[]): boolean {
  if (!recipient) return false;
  const r = recipient.trim().toLowerCase();
  if (!r) return false;
  return aliases.some((a) => a.length >= 3 && (r.includes(a) || a.includes(r)));
}

/**
 * Recent engine-verified deliveries to `recipientHint` within the window, newest
 * first. `recipientHint` null/empty returns ALL recent deliveries (the
 * recipient-agnostic case the denial guard uses for a bare "not yet" with no name).
 */
export function findRecentDeliveries(
  agentId: string,
  recipientHint: string | null | undefined,
  windowHours: number,
): OutboundDelivery[] {
  try {
    const db = getDb();
    const hours = Math.max(1, Math.floor(windowHours));
    const rows = db.prepare(
      `SELECT * FROM tool_receipts
        WHERE agent_id = ?
          AND created_at >= datetime('now', ?)
        ORDER BY created_at DESC`,
    ).all(agentId, `-${hours} hours`) as ToolReceiptRow[];
    const hint = (recipientHint ?? '').trim();
    if (!hint) return rows.map(rowToDelivery);
    const aliases = resolveRecipientAliases(hint);
    return rows
      .filter((r) => recipientMatchesAliases(r.recipient, aliases))
      .map(rowToDelivery);
  } catch (err) {
    logger.warn('findRecentDeliveries failed (non-fatal)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return [];
  }
}

/**
 * The last `limit` engine-verified deliveries within the window, newest first,
 * recipient-agnostic. Used by the RECENT OUTBOUND volatile block.
 */
export function getRecentOutbound(
  agentId: string,
  windowHours: number,
  limit: number,
): OutboundDelivery[] {
  try {
    const db = getDb();
    const hours = Math.max(1, Math.floor(windowHours));
    const n = Math.max(1, Math.floor(limit));
    const rows = db.prepare(
      `SELECT * FROM tool_receipts
        WHERE agent_id = ?
          AND created_at >= datetime('now', ?)
        ORDER BY created_at DESC
        LIMIT ?`,
    ).all(agentId, `-${hours} hours`, n) as ToolReceiptRow[];
    return rows.map(rowToDelivery);
  } catch (err) {
    logger.warn('getRecentOutbound failed (non-fatal)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return [];
  }
}

/**
 * The most recent delivery TO `recipientHint` within the window (or null). Small
 * wrapper the pending-question header uses to quote the agent's own last message.
 */
export function mostRecentDeliveryTo(
  agentId: string,
  recipientHint: string,
  windowHours: number,
): OutboundDelivery | null {
  return findRecentDeliveries(agentId, recipientHint, windowHours)[0] ?? null;
}

/** One deliveries row joined to its receipt for the sent text. */
interface DeliveryJoinRow {
  tool: string;
  channel: string;
  recipient_id: string | null;
  recipient_display: string | null;
  turn_number: number | null;
  created_at: string;
}

function joinSentText(db: ReturnType<typeof getDb>, agentId: string, d: DeliveryJoinRow): { sentText: string | null; convKey: string | null; verified: boolean } {
  if (d.turn_number === null) return { sentText: null, convKey: null, verified: false };
  const r = db.prepare(
    `SELECT sent_text, conv_key, verified FROM tool_receipts
      WHERE agent_id = ? AND turn_number = ? AND tool = ?
      ORDER BY created_at DESC LIMIT 1`,
  ).get(agentId, d.turn_number, d.tool) as { sent_text: string | null; conv_key: string | null; verified: number } | undefined;
  return { sentText: r?.sent_text ?? null, convKey: r?.conv_key ?? null, verified: r?.verified === 1 };
}

function deliveryJoinToOutbound(db: ReturnType<typeof getDb>, agentId: string, d: DeliveryJoinRow): OutboundDelivery {
  const joined = joinSentText(db, agentId, d);
  return {
    tool: d.tool,
    // The row carries its channel directly (readers here only see channel
    // sends; dashboard/voice rows are excluded in the SQL below).
    channel: d.channel as ChannelKind,
    recipient: d.recipient_display ?? d.recipient_id,
    sentText: joined.sentText,
    convKey: joined.convKey,
    turnNumber: d.turn_number,
    verified: joined.verified,
    createdAt: d.created_at,
  };
}

/**
 * P6b-2: the ID-keyed selection for the pending-question header. The most
 * recent DELIVERED outbound INTO a conversation, from the deliveries rows
 * (mig 121), joined to its receipt for the verbatim sent text. No recipient
 * fuzz: the conversation id IS the identity. Returns null when the
 * conversation has no delivery rows (the caller falls back to the legacy
 * hint path while pre-121 history ages out).
 */
export function mostRecentDeliveryToConversation(
  agentId: string,
  conversationId: string,
  windowHours: number,
): OutboundDelivery | null {
  try {
    const db = getDb();
    const hours = Math.max(1, Math.floor(windowHours));
    const d = db.prepare(
      `SELECT tool, channel, recipient_id, recipient_display, turn_number, created_at
         FROM deliveries
        WHERE agent_id = ? AND conversation_id = ? AND outcome = 'delivered'
          AND channel NOT IN ('dashboard', 'voice')
          AND created_at >= datetime('now', ?)
        ORDER BY created_at DESC LIMIT 1`,
    ).get(agentId, conversationId, `-${hours} hours`) as DeliveryJoinRow | undefined;
    if (!d) return null;
    return deliveryJoinToOutbound(db, agentId, d);
  } catch (err) {
    logger.warn('mostRecentDeliveryToConversation failed (non-fatal)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return null;
  }
}

/**
 * P6b-2: ID-keyed variant of findRecentDeliveries for the grounding/denial
 * guards: matches the hint against deliveries rows via CANONICAL recipient
 * identity (contacts + safe-sender stores), not substring fuzz. Returns []
 * when no delivery rows match, letting callers fall back to the legacy
 * receipts-alias path while pre-121 history ages out.
 */
export function findRecentDeliveriesKeyed(
  agentId: string,
  recipientHint: string | null | undefined,
  windowHours: number,
): OutboundDelivery[] {
  try {
    const db = getDb();
    const hours = Math.max(1, Math.floor(windowHours));
    const rows = db.prepare(
      `SELECT tool, channel, recipient_id, recipient_display, turn_number, created_at
         FROM deliveries
        WHERE agent_id = ? AND outcome = 'delivered'
          AND channel NOT IN ('dashboard', 'voice')
          AND created_at >= datetime('now', ?)
        ORDER BY created_at DESC`,
    ).all(agentId, `-${hours} hours`) as DeliveryJoinRow[];
    const hint = (recipientHint ?? '').trim();
    const matched = hint
      ? rows.filter((d) =>
          (d.recipient_id !== null && recipientIdsMatch(hint, d.recipient_id)) ||
          (d.recipient_display !== null && recipientIdsMatch(hint, d.recipient_display)))
      : rows;
    return matched.map((d) => deliveryJoinToOutbound(db, agentId, d));
  } catch (err) {
    logger.warn('findRecentDeliveriesKeyed failed (non-fatal)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return [];
  }
}

/** Compact "N minutes/hours ago" for a SQLite UTC timestamp ("YYYY-MM-DD HH:MM:SS"). */
export function relativeTimeAgo(sqliteUtc: string): string {
  const ms = Date.parse(sqliteUtc.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(ms)) return 'recently';
  const deltaSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (deltaSec < 60) return 'just now';
  const mins = Math.floor(deltaSec / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Short channel label for the RECENT OUTBOUND block + steer copy. */
export function channelLabel(channel: ChannelKind | 'a2a'): string {
  switch (channel) {
    case 'imessage': return 'iMessage';
    case 'sms': return 'SMS';
    case 'email': return 'email';
    case 'teams': return 'Teams';
    case 'phone': return 'phone';
    case 'a2a': return 'agent';
  }
}
