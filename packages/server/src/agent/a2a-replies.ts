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

  const clauses: string[] = [`agent_id = ?`, `role = 'user'`];
  const params: unknown[] = [agentId];
  if (sessionStartedAt) { clauses.push(`created_at >= ?`); params.push(sessionStartedAt); }
  if (maxAgeMinutes != null) { clauses.push(`created_at >= datetime('now', ?)`); params.push(`-${maxAgeMinutes} minutes`); }
  const sql = `SELECT id, content, created_at, source_agent_id, a2a_thread_id, a2a_intent FROM messages
                   WHERE ${clauses.join(' AND ')}
                   ORDER BY created_at DESC, rowid DESC LIMIT ?`;
  params.push(lookback);

  const rows = db
    .prepare(sql)
    .all(...params) as Array<{ id: string; content: string; created_at: string; source_agent_id: string | null; a2a_thread_id: string | null; a2a_intent: string | null }>;

  for (const row of rows) {
    // F7 (harness finding, wave 2): trust the STRUCTURAL columns first. The
    // prose regex required an 8-hex thread id, so any envelope/thread-format
    // drift made this return null and an unreplied QUESTION was silently
    // dropped (no dedicated A2A retry turn ever fired). The columns are the
    // authoritative store; the prose parse stays only for legacy rows that
    // predate them.
    let intent: string;
    let threadShort: string;
    let fromName: string;
    if (row.a2a_intent && row.a2a_thread_id && row.source_agent_id) {
      intent = row.a2a_intent;
      threadShort = row.a2a_thread_id.slice(0, 8);
      const senderRow = db.prepare('SELECT name FROM agents WHERE id = ?').get(row.source_agent_id) as { name?: string } | undefined;
      fromName = senderRow?.name ?? row.source_agent_id;
    } else {
      const match = row.content?.match(/^\[A2A:([A-Z]+)\s+thread:([0-9a-f]{8})\s+from:([^\]]+)\]/);
      if (!match) continue;
      intent = match[1];
      threadShort = match[2];
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
  const structural = db
    .prepare(
      `SELECT id, a2a_intent FROM messages
       WHERE agent_id = ? AND role = 'user'
         AND a2a_thread_id IS NOT NULL
         AND (a2a_thread_id = ? OR substr(a2a_thread_id, 1, 8) = ?)
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
    )
    .get(agentId, threadId, threadShort) as { id: string; a2a_intent: string | null } | undefined;
  if (structural && structural.a2a_intent && REPLY_NEEDED_INTENTS.has(structural.a2a_intent)) {
    return { messageId: structural.id, intent: structural.a2a_intent };
  }

  // Legacy prose fallback for rows predating the structural columns.
  const rows = db
    .prepare(
      `SELECT id, content FROM messages
       WHERE agent_id = ? AND role = 'user'
       ORDER BY created_at DESC, rowid DESC
       LIMIT 30`,
    )
    .all(agentId) as Array<{ id: string; content: string }>;

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
export function hasPriorReplyOnThread(agentId: string, threadShort: string): boolean {
  if (!threadShort || threadShort.length < 8) return false;
  const db = getDb();
  // Match by the leading 8 chars to align with the [A2A:... thread:XXXXXXXX]
  // wire format that's stored in the a2a_replies.thread_id column (which
  // is a full UUID — its first 8 chars are the threadShort).
  const row = db
    .prepare(
      `SELECT 1 FROM a2a_replies
       WHERE agent_id = ? AND substr(thread_id, 1, 8) = ?
       LIMIT 1`,
    )
    .get(agentId, threadShort);
  return !!row;
}
