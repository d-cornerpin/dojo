// The engine-verified outbound ledger: what the agent actually sent, and to whom, read from engine-written
// receipts (receipts/store.ts) and deliveries rows, never from model text. It grounds the delivery-claim
// guards in both directions and feeds the RECENT OUTBOUND block. Reads only.

import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { channelOfSendTool, type ChannelKind } from '@dojo/shared';
import { recipientIdsMatch } from '../recipient-identity.js';
import type { ToolReceiptRow } from '../../receipts/store.js';
import { recordedInstant } from '../../memory/message-stamp.js';
import { pendingReplies } from './channel-sender.js';

const logger = createLogger('outbound-ledger');

// Calendar writes are receipted but are not sends to a person: both receipt-lane readers exclude them, or a
// calendar row would render as `agent -> unknown` and could ground a delivery-denial correction.
const NON_SEND_RECEIPT_TOOLS = ['calendar_create', 'calendar_update'] as const;

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
  /** A reply the sender holds queued: recorded, not gone out yet. */
  waiting?: true;
}

function rowToDelivery(r: ToolReceiptRow): OutboundDelivery {
  return {
    tool: r.tool,
    channel: channelOfSendTool(r.tool) ?? 'a2a',
    recipient: r.recipient,
    sentText: r.sent_text,
    convKey: r.conv_key,
    turnNumber: r.turn_number,
    verified: r.verified === 1,
    createdAt: r.created_at,
  };
}

/** The last `limit` deliveries in the window, newest first, any recipient, after the replies still queued: the
 *  RECENT OUTBOUND block. */
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
          AND tool NOT IN (${NON_SEND_RECEIPT_TOOLS.map(() => '?').join(', ')})
        ORDER BY created_at DESC
        LIMIT ?`,
    ).all(agentId, `-${hours} hours`, ...NON_SEND_RECEIPT_TOOLS, n) as ToolReceiptRow[];
    const waiting = pendingReplies(agentId).map((w): OutboundDelivery => ({
      tool: 'auto-route', channel: w.channel, recipient: w.recipient, sentText: null, convKey: null,
      turnNumber: null, verified: false, createdAt: w.createdAt, waiting: true,
    }));
    return [...waiting, ...rows.map(rowToDelivery)];
  } catch (err) {
    logger.warn('getRecentOutbound failed (non-fatal)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return [];
  }
}

/** One deliveries row joined to its receipt for the sent text. */
interface DeliveryJoinRow {
  tool: string;
  channel: string;
  recipient_id: string | null;
  recipient_display: string | null;
  turn_number: number | null;
  receipt_id: string | null;
  created_at: string;
}

interface ReceiptFacts { sent_text: string | null; conv_key: string | null; verified: number }

/** The receipt behind a delivery: its sent text is quoted back to the model and `verified` grounds the
 *  delivery-claim guard. A row with a `receipt_id` never falls back, even when that receipt is gone; only
 *  unlinked rows use the agent + turn + tool guess, which gives two same-tool sends in a turn the later text. */
function joinSentText(db: ReturnType<typeof getDb>, agentId: string, d: DeliveryJoinRow): { sentText: string | null; convKey: string | null; verified: boolean } {
  if (d.receipt_id !== null) {
    const r = db.prepare(
      `SELECT sent_text, conv_key, verified FROM tool_receipts WHERE id = ?`,
    ).get(d.receipt_id) as ReceiptFacts | undefined;
    return { sentText: r?.sent_text ?? null, convKey: r?.conv_key ?? null, verified: r?.verified === 1 };
  }
  if (d.turn_number === null) return { sentText: null, convKey: null, verified: false };
  const r = db.prepare(
    `SELECT sent_text, conv_key, verified FROM tool_receipts
      WHERE agent_id = ? AND turn_number = ? AND tool = ?
      ORDER BY created_at DESC LIMIT 1`,
  ).get(agentId, d.turn_number, d.tool) as ReceiptFacts | undefined;
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

/** The latest delivered outbounds into a conversation, newest first, from deliveries rows joined to their
 *  receipts; the conversation id is the identity, no recipient fuzz. `limit` is the deliveries lane's row cap
 *  (`LANE_LIMITS['lane.deliveries'].rows`). An empty result sends the caller to the hint path for older rows. */
export function recentDeliveriesToConversation(
  agentId: string,
  conversationId: string,
  windowHours: number,
  limit: number,
): OutboundDelivery[] {
  try {
    const db = getDb();
    const hours = Math.max(1, Math.floor(windowHours));
    const n = Math.max(1, Math.floor(limit));
    const rows = db.prepare(
      `SELECT tool, channel, recipient_id, recipient_display, turn_number, receipt_id, created_at
         FROM deliveries
        WHERE agent_id = ? AND conversation_id = ? AND outcome = 'delivered'
          AND channel NOT IN ('dashboard', 'voice')
          AND created_at >= datetime('now', ?)
        ORDER BY created_at DESC LIMIT ?`,
    ).all(agentId, conversationId, `-${hours} hours`, n) as DeliveryJoinRow[];
    return rows.map((d) => deliveryJoinToOutbound(db, agentId, d));
  } catch (err) {
    logger.warn('recentDeliveriesToConversation failed (non-fatal)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return [];
  }
}

/** Delivered sends to `recipientHint` in the window, newest first, read from deliveries rows and matched by
 *  canonical recipient identity (`recipientIdsMatch`); an empty hint returns every row (a bare "not yet"). */
export function findRecentDeliveriesKeyed(
  agentId: string,
  recipientHint: string | null | undefined,
  windowHours: number,
): OutboundDelivery[] {
  try {
    const db = getDb();
    const hours = Math.max(1, Math.floor(windowHours));
    const rows = db.prepare(
      `SELECT tool, channel, recipient_id, recipient_display, turn_number, receipt_id, created_at
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
export function relativeTimeAgo(at: string | number): string {
  const nowMs = Date.now();
  // Accepts both shapes: `messages.created_at` is epoch-ms while `deliveries.created_at` is still TEXT.
  // Its caller builds a one-shot engine receipt after the model call, outside any cached context.
  const ms = typeof at === 'number' ? at : Date.parse(at.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(ms)) return 'recently';
  const deltaSec = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (deltaSec < 60) return 'just now';
  const mins = Math.floor(deltaSec / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// The RECENT OUTBOUND block as a pure function of its rows: it states recorded instants, never ages, so identical
// rows render identical bytes and keep the prompt cache. Rows arrive newest-first from getRecentOutbound.
// The 24-hour window still scrolls: a row leaves once, when it passes the edge the block's header declares.

export const RECENT_OUTBOUND_HEAD = 'RECENT OUTBOUND (engine-verified):';

export function renderRecentOutboundBlock(rows: readonly OutboundDelivery[]): string | null {
  if (rows.length === 0) return null;
  const lines = rows.map(
    (d) => `${recordedInstant(d.createdAt)} ${channelLabel(d.channel)} -> ${d.recipient ?? 'unknown'}${
      d.waiting ? ': not gone out yet, the Dojo is still trying' : ''}`,
  );
  return `${RECENT_OUTBOUND_HEAD}\n${lines.join('\n')}`;
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
