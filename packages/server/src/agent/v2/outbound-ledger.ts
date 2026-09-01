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
import { recordedInstant } from '../../memory/message-stamp.js';

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

/**
 * ROUND-11 T46 — DID THIS AGENT ALREADY REPLY ON THIS A2A THREAD, per the receipt ledger?
 *
 * The missed-reply enforcer's "you already replied" evidence was `a2a_replies` alone, and
 * `recordA2AReply` writes a row ONLY when the reply BINDS to an inbound assign message
 * (`findInboundAssignByThread`) — a binding that needs a `thread_id` the sender may omit. On
 * 2026-08-15 kevin's ANSWER to BehaviorBot was DELIVERED and left no `a2a_replies` row, so the
 * enforcer told him the peer "got nothing" five seconds later and he re-sent the same answer.
 *
 * The fact was already here, in the ledger this module exists to read: a VERIFIED,
 * engine-written `send_to_agent` receipt carrying the thread id. Nothing about the predicate
 * changes — it is still "has this agent already replied on this thread" — only its evidence
 * widens to the source the platform already trusts on the other side of the same exchange
 * (`reply-floors.ts` floor 11 answers a denial from these very rows).
 *
 * FA-C2 discipline, carried over verbatim from `hasPriorReplyOnThread`: the EXACT full-id
 * match is authoritative, a genuinely-short legacy row (`length = 8`) is accepted exactly and
 * only when no full-id row exists, and the leading-8 prefix match is reachable ONLY on the
 * legacy caller path that has no full id — `makeThreadId` ids are almost all shared prefix, so
 * a prefix match over full ids would let an unrelated thread silence THIS thread's note.
 */
export function hasVerifiedA2ASendOnThread(
  agentId: string,
  threadShort: string,
  fullThreadId: string | null = null,
): boolean {
  if (!threadShort || threadShort.length < 8) return false;
  try {
    const db = getDb();
    // `verified = 1` and nothing else: an unverified receipt is the engine recording that it
    // TRIED, and a note about an undelivered reply is exactly the note that should still fire.
    if (fullThreadId) {
      const exact = db.prepare(
        `SELECT 1 FROM tool_receipts
          WHERE agent_id = ? AND tool = 'send_to_agent' AND verified = 1 AND thread_id = ?
          LIMIT 1`,
      ).get(agentId, fullThreadId);
      if (exact) return true;
      const legacy = db.prepare(
        `SELECT 1 FROM tool_receipts
          WHERE agent_id = ? AND tool = 'send_to_agent' AND verified = 1
            AND length(thread_id) = 8 AND thread_id = ?
          LIMIT 1`,
      ).get(agentId, threadShort);
      return !!legacy;
    }
    const row = db.prepare(
      `SELECT 1 FROM tool_receipts
        WHERE agent_id = ? AND tool = 'send_to_agent' AND verified = 1
          AND substr(thread_id, 1, 8) = ?
        LIMIT 1`,
    ).get(agentId, threadShort);
    return !!row;
  } catch (err) {
    // Best effort, and the failure direction is the SAFE one: with no evidence the enforcer
    // keeps today's behaviour and still nudges.
    logger.warn('hasVerifiedA2ASendOnThread failed (non-fatal)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return false;
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

/**
 * The receipt behind a delivery — THE READER for `deliveries.receipt_id` (PHASE-2 T5, the
 * Phase-1 §7 debt).
 *
 * This is load-bearing, not decorative: `sentText` is what the pending-question header quotes
 * back to the model as its own last message, and `verified` is what the delivery-claim guard
 * consults in BOTH directions before it fires. Reading the wrong receipt makes the engine
 * quote the wrong message at the owner.
 *
 * The link is now recorded when it is KNOWN — `writeToolReceipt` stamps it inside the send's
 * own outbound scope. What it replaces is a three-column guess: agent + turn + tool, newest
 * first. A turn that sent two emails to two people wrote two receipts under one tool name, and
 * the guess handed BOTH deliveries the later one's text.
 *
 * The guess survives ONLY as a fallback for rows written before T5 (44 of them on this box).
 * A row that HAS a link never falls back: if the receipt it names is gone, the honest answer
 * is "no text", not the next-best receipt.
 */
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

/**
 * P6b-2: the ID-keyed selection the DELIVERIES LANE reads. The most recent
 * DELIVERED outbounds INTO a conversation, newest first, from the deliveries
 * rows (mig 121), each joined to its receipt for the verbatim sent text. No
 * recipient fuzz: the conversation id IS the identity. Returns [] when the
 * conversation has no delivery rows (the caller falls back to the legacy hint
 * path while pre-121 history ages out).
 *
 * PHASE-3 T7: this was `mostRecentDeliveryToConversation`, LIMIT 1, because its
 * one consumer (the pending-question header) quoted a single message and the
 * cross-conversation ECHO ROW carried everything older. The lane that replaces
 * those duplicated rows has to cover what they covered — a recipient's
 * conversation accumulates every question the agent asked it — so the limit is
 * the lane's own declared row cap (`LANE_LIMITS['lane.deliveries'].rows`),
 * passed in rather than hardcoded here.
 */
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
  // ⚠ SWEEP CORE-2 item 4. This took a SQLite datetime STRING only, and `messages.created_at`
  // became an epoch-ms INTEGER at migration 131. Every caller that passed a `messages` row's
  // timestamp threw `sqliteUtc.replace is not a function` — `engine.recently-answered` did
  // exactly that, inside a swallowing catch, on every turn since 131 (see the note in
  // `answered-edge.ts`). `deliveries.created_at` is still TEXT, so BOTH shapes are real and
  // the conversion belongs here, once, rather than at each site guessing its column's type.
  //
  // T69b: `nowMs` WAS a parameter (T67b), and the HL5 snapshot was its only non-default
  // caller. That block no longer measures ages at all — it states recorded instants, like
  // every other time term in the tail — so the parameter went with the caller rather than
  // staying as a hook nothing pulls. The ONE surviving caller of this function is
  // `steps/post-call-classify/reply-floors.ts`, which builds a one-shot engine receipt AFTER
  // the model call: it is not in any assembled context, so no cache is behind it.
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

// ════════════════════════════════════════════════════════════════════════════════════════
// T69b — THE RECENT-OUTBOUND BLOCK, A PURE FUNCTION OF ITS ROWS.
//
// It was five lines of `.map()` inline in `steps/call-llm/pre-call-injections.ts`, which is
// why nothing could test it and why its clock read went unnoticed: `relativeTimeAgo(...)`
// off `Date.now()`, so an IDENTICAL set of receipts emitted different bytes once a minute
// and re-billed every token behind it in the tail. The render moves to the module that owns
// the read, states the RECORDED INSTANT instead of an age, and takes its rows as an
// argument — so the property "identical rows ⇒ identical bytes" is expressible.
//
// The rows arrive newest-first from `getRecentOutbound`'s own `ORDER BY created_at DESC`;
// the order is the query's, not this function's, and it is deterministic.
//
// ⚠ THE SCROLLING WINDOW STAYS, AND IT IS DECLARED RATHER THAN FIXED. `getRecentOutbound`
// selects `created_at >= datetime('now','-24 hours')`, so a receipt leaves this block when
// the wall clock passes its 24-hour mark with nothing having changed. That is a real change
// of CONTENT — the block's own header claims a 24-hour window — and pinning the window edge
// to a fixed instant would make the claim false. It is bounded, one-way and at most ONCE PER
// ROW, which is the same disposition T67b gave `lane.continuity`'s horizon; the defect this
// function removes fired every minute, for every row, forever.
// ════════════════════════════════════════════════════════════════════════════════════════

export const RECENT_OUTBOUND_HEAD = 'RECENT OUTBOUND (engine-verified):';

export function renderRecentOutboundBlock(rows: readonly OutboundDelivery[]): string | null {
  if (rows.length === 0) return null;
  const lines = rows.map(
    (d) => `${recordedInstant(d.createdAt)} ${channelLabel(d.channel)} -> ${d.recipient ?? 'unknown'}`,
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
