// ════════════════════════════════════════
// A2A reply tracking — durable per-ASSIGN reply persistence.
// ════════════════════════════════════════
//
// Backs migration 044_a2a_replies.sql. Two callers:
//
//   1. send_to_agent dispatcher: after a successful delivery, calls
//      `recordA2AReply` if the calling agent has an open ASSIGN/QUESTION/
//      BLOCK on the same thread. This locks in "this ASSIGN has been
//      replied to" so subsequent handleMessage invocations don't re-trigger
//      the missed-reply enforcer for it.
//
//   2. v2 loop preflight: calls `findUnrepliedAssignForAgent` to determine
//      whether the agent's most recent inbound A2A trigger is still
//      outstanding. If it's already in the a2a_replies table, the loop
//      treats it as "no A2A reply owed" and the enforcer is a no-op.
//
// Together these close the loop captured in loop.txt on 2026-05-13 — the
// 30-nudge spiral where every fresh handleMessage call re-derived "you
// owe a reply" from "most recent user message is an ASSIGN" without any
// memory of the agent already having replied.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('a2a-replies');

/** Inbound A2A intents that put the receiver on the hook for a reply. */
const REPLY_NEEDED_INTENTS = new Set(['QUESTION', 'ASSIGN', 'BLOCK']);

export interface UnrepliedAssign {
  messageId: string;
  threadShort: string;   // 8-char prefix from the [A2A:... thread:XXXXXXXX ...] tag
  // FA-C2: the FULL thread id when it is known (structural a2a_thread_id column),
  // null for legacy prose-parsed rows that only carry the 8-char short token. Callers
  // that need to disambiguate colliding-prefix threads (hasPriorReplyOnThread) use this
  // full id for an authoritative match and fall back to the short token only when null.
  threadId: string | null;
  intent: string;
  fromName: string;
  content: string;
  createdAt: string;
}

/**
 * Find the most recent inbound A2A reply-needed message (ASSIGN, QUESTION,
 * BLOCK) for this agent that does NOT yet have a recorded reply in
 * a2a_replies. Returns null if the agent has no outstanding ASSIGN.
 *
 * Scans the most recent N user-role messages and checks each one's
 * `[A2A:...]` header. Stops at the first one that's not in the replies
 * table — that's the open ASSIGN.
 *
 * v2.11.0 — Scoped to the current session. Before this fix the
 * lookback walked across session boundaries, so a QUESTION from a
 * prior session (or weeks ago) would resurface as "unreplied" forever,
 * firing the missed-reply nudge on every turn. The session-reset code
 * already stamps agents.session_started_at when the user resets; we
 * use that as the lower bound. Threads that genuinely span sessions
 * (rare — most A2A questions resolve within a single session) get a
 * graceful "no longer owed" outcome from the user's perspective, which
 * matches the user expectation of "session reset = clean slate."
 */
// `maxAgeMinutes` (optional): ignore assigns older than this. The boot re-drain passes 30
// so a weeks-old inter-agent assign can't force-wake an agent into stale backlog on restart
// (incident 2026-07-02) — the same staleness cutoff as the boot message sweep. Omitted by
// every other caller (in-turn A2A detection), which keeps the full-session behavior.
export function findUnrepliedAssignForAgent(agentId: string, lookback: number = 20, maxAgeMinutes?: number): UnrepliedAssign | null {
  const db = getDb();

  // Look up the session boundary. If null (never reset), there's no
  // floor and we fall back to the old all-time behavior.
  const sessionRow = db
    .prepare('SELECT session_started_at FROM agents WHERE id = ?')
    .get(agentId) as { session_started_at: string | null } | undefined;
  const sessionStartedAt = sessionRow?.session_started_at ?? null;

  // T6: one table, so "most recent" is the insertion key — causally correct by
  // construction rather than reconstructed from a second-granular clock plus a
  // cross-table tiebreak.
  const clauses: string[] = [`agent_id = @agentId`, `role = 'user'`];
  const params: Record<string, unknown> = { agentId, lookback };
  if (sessionStartedAt) { clauses.push(`created_at >= @boundary`); params.boundary = sessionStartedAt; }
  if (maxAgeMinutes != null) { clauses.push(`created_at >= datetime('now', @maxAge)`); params.maxAge = `-${maxAgeMinutes} minutes`; }
  const where = clauses.join(' AND ');
  const sql = `
    SELECT id, content, created_at, source_agent_id, a2a_thread_id, a2a_intent, lane
      FROM messages
     WHERE ${where}
     ORDER BY rowid DESC
     LIMIT @lookback`;

  const rows = db
    .prepare(sql)
    .all(params) as Array<{ id: string; content: string; created_at: string; source_agent_id: string | null; a2a_thread_id: string | null; a2a_intent: string | null; lane: string }>;

  for (const row of rows) {
    // Engine-origin rows (Healer/PM/gate/distillation via fromAgent='system') are
    // NOT peer A2A: the receiver responds by acting on the directive (the tool the
    // payload names), never by send_to_agent back to a non-existent "system" agent.
    // Excluding them here disarms the missed-reply enforcer for those messages (it
    // would otherwise nag the receiver to send_to_agent 'system') and lets them be
    // classified as an engine turn instead of a mis-framed peer A2A turn. A genuine
    // peer A2A row is on the a2a lane and is still detected.
    if (row.lane === 'events') continue;
    // F7 (harness finding, wave 2): trust the STRUCTURAL columns first. The
    // prose regex required an 8-hex thread id, so any envelope/thread-format
    // drift made this return null and an unreplied QUESTION was silently
    // dropped (no dedicated A2A retry turn ever fired). The columns are the
    // authoritative store; the prose parse stays only for legacy rows that
    // predate them.
    let intent: string;
    let threadShort: string;
    let threadIdFull: string | null;
    let fromName: string;
    if (row.a2a_intent && row.a2a_thread_id && row.source_agent_id) {
      intent = row.a2a_intent;
      threadShort = row.a2a_thread_id.slice(0, 8);
      threadIdFull = row.a2a_thread_id;   // FA-C2: full id available from the structural column
      const senderRow = db.prepare('SELECT name FROM agents WHERE id = ?').get(row.source_agent_id) as { name?: string } | undefined;
      fromName = senderRow?.name ?? row.source_agent_id;
    } else {
      const match = row.content?.match(/^\[A2A:([A-Z]+)\s+thread:([0-9a-f]{8})\s+from:([^\]]+)\]/);
      if (!match) continue;
      intent = match[1];
      threadShort = match[2];
      threadIdFull = null;   // FA-C2: legacy prose row carries only the 8-char short token
      fromName = match[3].trim();
    }
    if (!REPLY_NEEDED_INTENTS.has(intent)) continue;
    // Is it already replied to?
    const replied = db
      .prepare('SELECT 1 FROM a2a_replies WHERE assign_message_id = ?')
      .get(row.id);
    if (replied) {
      // Found a replied ASSIGN — anything older has either been replied
      // to or fell off our lookback window. Treat as "no open ASSIGN."
      return null;
    }
    return {
      messageId: row.id,
      threadShort,
      threadId: threadIdFull,
      intent,
      fromName,
      content: row.content,
      createdAt: row.created_at,
    };
  }
  return null;
}

/**
 * Find the inbound A2A message id that corresponds to a thread the agent
 * is now sending on. Used by the send_to_agent dispatcher to mark the
 * inbound ASSIGN as replied. Returns null if there's no open inbound
 * message on this thread for this agent.
 */
export function findInboundAssignByThread(agentId: string, threadId: string): { messageId: string; intent: string } | null {
  if (!threadId || threadId.length < 8) return null;
  const threadShort = threadId.slice(0, 8);
  const db = getDb();
  // F13 (harness finding, wave 2): STRUCTURAL columns first, matching the F7
  // fix on the detection side. This was the other prose-bound end of the pipe:
  // the reply was SENT but never recorded (the hex-only regex missed the
  // thread), so the engine thought the reply was still owed, fired retry turns,
  // and the send-dedup guard refused each one (observed: 26 "already sent"
  // refusals in one scenario run). Detection and recording must read the SAME
  // store or the loop never closes.
  //
  // FA-C2: the EXACT full-id match is AUTHORITATIVE. The prior single query OR'd in
  // `substr(a2a_thread_id, 1, 8) = ?`, but for makeThreadId ids ('thread-<base36>-<seed>')
  // the first 8 chars are almost all the shared 'thread-' prefix (plus one hash char), so
  // that broad prefix match collides across unrelated threads, and under ORDER BY
  // created_at DESC a NEWER colliding-prefix row could beat the exact match and bind the
  // reply to the WRONG thread. Same collision class already fixed in conversationKey (C-2).
  // The wire footer and send_to_agent both carry the full id, so a modern reply always has
  // the full thread id in hand and hits this exact match.
  // T6: one table, so detection and recording read the same rows by construction —
  // the F13 defect (detection reading one store while recording read the other, so the
  // reply loop never closed) cannot recur. Newest-first by the insertion key.
  const exact = db
    .prepare(
      `SELECT id, a2a_intent FROM messages
       WHERE agent_id = @agentId AND role = 'user' AND a2a_thread_id = @threadId
       ORDER BY rowid DESC
       LIMIT 1`,
    )
    .get({ agentId, threadId }) as { id: string; a2a_intent: string | null } | undefined;
  if (exact && exact.a2a_intent && REPLY_NEEDED_INTENTS.has(exact.a2a_intent)) {
    return { messageId: exact.id, intent: exact.a2a_intent };
  }

  // Fall back to a legacy short-token row ONLY when no full-id row exists. Legacy
  // predicate: a stored a2a_thread_id that is itself a pre-makeThreadId 8-char token
  // (length = 8), matched EXACTLY to the thread's 8-char short form, never a prefix over
  // modern full ids (which are all longer than 8 chars and start with 'thread-'). This is
  // the same authoritative-then-short shape as parkThreadCondition; it preserves resolution
  // for genuinely-short legacy rows (the reason the substr existed) without the collision.
  const legacyShort = db
    .prepare(
      `SELECT id, a2a_intent FROM messages
       WHERE agent_id = @agentId AND role = 'user'
         AND a2a_thread_id IS NOT NULL AND length(a2a_thread_id) = 8 AND a2a_thread_id = @threadShort
       ORDER BY rowid DESC
       LIMIT 1`,
    )
    .get({ agentId, threadShort }) as { id: string; a2a_intent: string | null } | undefined;
  if (legacyShort && legacyShort.a2a_intent && REPLY_NEEDED_INTENTS.has(legacyShort.a2a_intent)) {
    return { messageId: legacyShort.id, intent: legacyShort.a2a_intent };
  }

  // Legacy prose fallback for rows predating the structural columns.
  const rows = db
    .prepare(
      `SELECT id, content FROM messages
       WHERE agent_id = @agentId AND role = 'user'
       ORDER BY rowid DESC
       LIMIT 30`,
    )
    .all({ agentId }) as Array<{ id: string; content: string }>;

  for (const row of rows) {
    const match = row.content?.match(/^\[A2A:([A-Z]+)\s+thread:([0-9a-f]{8})\s+from:([^\]]+)\]/);
    if (!match) continue;
    if (match[2] !== threadShort) continue;
    if (!REPLY_NEEDED_INTENTS.has(match[1])) continue;
    return { messageId: row.id, intent: match[1] };
  }
  return null;
}

/**
 * Record that an agent has replied to a specific inbound ASSIGN. Idempotent —
 * uses INSERT OR IGNORE so duplicate calls (e.g. agent sends two messages
 * on the same thread) are no-ops on the schema.
 */
export function recordA2AReply(params: {
  assignMessageId: string;
  agentId: string;
  threadId: string;
  replyIntent: string;
}): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT OR IGNORE INTO a2a_replies (assign_message_id, agent_id, thread_id, reply_intent, replied_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    ).run(params.assignMessageId, params.agentId, params.threadId, params.replyIntent);
  } catch (err) {
    logger.warn('Failed to record A2A reply', {
      assignMessageId: params.assignMessageId,
      agentId: params.agentId,
      threadId: params.threadId,
      err: err instanceof Error ? err.message : String(err),
    }, params.agentId);
  }
}

/**
 * For the missed-reply enforcer: did this agent ever send_to_agent on the
 * given thread? Used to decide which nudge text to show — "you replied
 * earlier, just end your turn" vs. "the receiver got nothing, retry now."
 */
export function hasPriorReplyOnThread(agentId: string, threadShort: string, fullThreadId: string | null = null): boolean {
  if (!threadShort || threadShort.length < 8) return false;
  const db = getDb();
  // FA-C2: a2a_replies.thread_id stores the FULL thread id (recordA2AReply writes the
  // send_to_agent thread id verbatim). When the caller knows that full id, an EXACT match
  // is AUTHORITATIVE, the leading-8 substr below is a broad collision magnet for
  // makeThreadId ids (first 8 chars are almost all the shared 'thread-' prefix), so a reply
  // on a DIFFERENT colliding thread would otherwise falsely soften THIS thread's nudge.
  if (fullThreadId) {
    const exact = db
      .prepare('SELECT 1 FROM a2a_replies WHERE agent_id = ? AND thread_id = ? LIMIT 1')
      .get(agentId, fullThreadId);
    if (exact) return true;
    // Only when no full-id row exists, accept a genuinely-short legacy row (thread_id
    // exactly 8 chars) matched exactly to the short form, never a prefix over full ids.
    const legacy = db
      .prepare('SELECT 1 FROM a2a_replies WHERE agent_id = ? AND length(thread_id) = 8 AND thread_id = ? LIMIT 1')
      .get(agentId, threadShort);
    return !!legacy;
  }
  // Legacy caller path: only the 8-char short token is available (prose-parsed wire
  // header, no structural full id). Prefix match against the stored full id is the only
  // resolution possible here; accepted residual, same as parkThreadCondition's short case.
  const row = db
    .prepare(
      `SELECT 1 FROM a2a_replies
       WHERE agent_id = ? AND substr(thread_id, 1, 8) = ?
       LIMIT 1`,
    )
    .get(agentId, threadShort);
  return !!row;
}
