// The old per-ASSIGN reply record: the send door still writes it and the missed-reply floor reads it; nothing in
// the product reads its two finders (the owed items in `v2/owed.ts` answer what is owed).
import {
  A2A_ENVELOPE_RE, A2A_THREAD_SHORT_LENGTH,
  a2aThreadShortLegacy, a2aThreadTokenMatches, a2aThreadTokenMatchesSql,
} from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { REPLY_NEEDED_INTENTS } from '@dojo/shared';

const logger = createLogger('a2a-replies');

export interface UnrepliedAssign {
  messageId: string;
  threadShort: string;   // 8-char prefix from the [A2A:... thread:XXXXXXXX ...] tag
  // The full thread id when the structural column is known; null for legacy prose-parsed rows.
  // Use the full id for an authoritative match and fall back to the short token only when null.
  threadId: string | null;
  intent: string;
  fromName: string;
  content: string;
  createdAt: string;
}

// The newest inbound QUESTION/ASSIGN/BLOCK with no entry in `a2a_replies`; null if none is owed.
// Lower bound `agents.session_started_at`: a pre-reset request never resurfaces as owed.
// Optional `maxAgeMinutes`: a boot cutoff so a weeks-old assign cannot force-wake an agent on restart.
export function findUnrepliedAssignForAgent(agentId: string, lookback: number = 20, maxAgeMinutes?: number): UnrepliedAssign | null {
  const db = getDb();

  const sessionRow = db
    .prepare('SELECT session_started_at FROM agents WHERE id = ?')
    .get(agentId) as { session_started_at: string | null } | undefined;
  const sessionStartedAt = sessionRow?.session_started_at ?? null;

  // One table: "most recent" is the insertion key (rowid), causally correct by construction.
  const clauses: string[] = [`agent_id = @agentId`, `role = 'user'`];
  const params: Record<string, unknown> = { agentId, lookback };
  if (sessionStartedAt) { clauses.push(`created_at >= (unixepoch(@boundary) * 1000)`); params.boundary = sessionStartedAt; }
  if (maxAgeMinutes != null) { clauses.push(`created_at >= (unixepoch('now', @maxAge) * 1000)`); params.maxAge = `-${maxAgeMinutes} minutes`; }
  const where = clauses.join(' AND ');
  const sql = `
    SELECT id, content, datetime(created_at/1000,'unixepoch') AS created_at, source_agent_id, a2a_thread_id, a2a_intent, lane
      FROM messages
     WHERE ${where}
     ORDER BY rowid DESC
     LIMIT @lookback`;

  const rows = db
    .prepare(sql)
    .all(params) as Array<{ id: string; content: string; created_at: string; source_agent_id: string | null; a2a_thread_id: string | null; a2a_intent: string | null; lane: string }>;

  for (const row of rows) {
    // Engine-origin rows (lane 'events') are directives, not peer A2A: the receiver acts on
    // them, never replies to a non-existent system agent, so they must not arm the enforcer.
    if (row.lane === 'events') continue;
    // The structural columns are the authoritative store; the prose regex is only for legacy
    // rows and demands an 8-hex thread id, so format drift silently drops an owed request.
    let intent: string;
    let threadShort: string;
    let threadIdFull: string | null;
    let fromName: string;
    if (row.a2a_intent && row.a2a_thread_id && row.source_agent_id) {
      intent = row.a2a_intent;
      threadShort = row.a2a_thread_id.slice(0, A2A_THREAD_SHORT_LENGTH);
      threadIdFull = row.a2a_thread_id;   // full id available from the structural column
      const senderRow = db.prepare('SELECT name FROM agents WHERE id = ?').get(row.source_agent_id) as { name?: string } | undefined;
      fromName = senderRow?.name ?? row.source_agent_id;
    } else {
      const match = row.content?.match(A2A_ENVELOPE_RE);
      if (!match) continue;
      intent = match[1];
      threadShort = match[2];
      threadIdFull = null;   // legacy prose row carries only the 8-char short token
      fromName = match[3].trim();
    }
    if (!REPLY_NEEDED_INTENTS.has(intent)) continue;
    const replied = db
      .prepare('SELECT 1 FROM a2a_replies WHERE assign_message_id = ?')
      .get(row.id);
    if (replied) {
      // The newest request is already replied: anything older is replied or past the lookback.
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

// All unreplied requests from ONE sender (newest first, one entry per thread), for routing a
// threadless reply. A thread is judged by its newest request, as the reply recorder does.
export function findUnrepliedRequestsFrom(agentId: string, fromAgentId: string): Array<{ messageId: string; threadId: string }> {
  const db = getDb();
  const floor = (db.prepare('SELECT session_started_at FROM agents WHERE id = ?')
    .get(agentId) as { session_started_at: string | null } | undefined)?.session_started_at ?? null;
  const rows = db.prepare(`
    SELECT m.id AS id, m.a2a_thread_id AS threadId,
           EXISTS (SELECT 1 FROM a2a_replies r WHERE r.assign_message_id = m.id) AS replied
      FROM messages m
     WHERE m.agent_id = @agentId AND m.role = 'user' AND m.lane != 'events'
       AND m.source_agent_id = @fromAgentId AND m.a2a_thread_id IS NOT NULL
       AND m.a2a_intent IN ('QUESTION','ASSIGN','BLOCK')
       ${floor ? `AND m.created_at >= (unixepoch(@floor) * 1000)` : ''}
     ORDER BY m.rowid DESC LIMIT 20`)
    .all({ agentId, fromAgentId, ...(floor ? { floor } : {}) }) as Array<{ id: string; threadId: string; replied: number }>;
  const seen = new Set<string>();
  const out: Array<{ messageId: string; threadId: string }> = [];
  for (const r of rows) {
    if (seen.has(r.threadId)) continue;
    seen.add(r.threadId);
    if (!r.replied) out.push({ messageId: r.id, threadId: r.threadId });
  }
  return out;
}

// The inbound reply-needed message id on this thread, so the dispatcher can mark it replied;
// null when there is no open inbound message on the thread for this agent.
export function findInboundAssignByThread(agentId: string, threadId: string): { messageId: string; intent: string } | null {
  if (!threadId || threadId.length < 8) return null;
  // `a2aThreadShortLegacy` is the legacy-era token the length-8 row query below matches.
  const threadShort = a2aThreadShortLegacy(threadId);
  const db = getDb();
  // Detection and recording must read the SAME store (one table, newest-first by the insertion
  // key) or the reply loop never closes. The EXACT full-id match is authoritative: for
  // `makeThreadId` ids the first 8 chars are nearly all the shared 'thread-' prefix, so a broad
  // prefix match collides across threads and can bind a reply to the WRONG thread.
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

  // Authoritative-then-short like parkThreadCondition: exact length-8 legacy row only, never a prefix.
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
    const match = row.content?.match(A2A_ENVELOPE_RE);
    if (!match) continue;
    // One matcher accepts EITHER era's spelling of the thread token; a bare front slice misfires.
    if (!a2aThreadTokenMatches(match[2], threadId)) continue;
    if (!REPLY_NEEDED_INTENTS.has(match[1])) continue;
    return { messageId: row.id, intent: match[1] };
  }
  return null;
}

// Records the reply; INSERT OR IGNORE, so a second send on the same thread is a no-op.
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

// For the missed-reply enforcer: did this agent ever send_to_agent here? Picks the nudge text.
export function hasPriorReplyOnThread(agentId: string, threadShort: string, fullThreadId: string | null = null): boolean {
  if (!threadShort || threadShort.length < 8) return false;
  const db = getDb();
  // Stored ids are FULL thread ids: exact match authoritative; leading-8 collides for `makeThreadId` ids.
  if (fullThreadId) {
    const exact = db
      .prepare('SELECT 1 FROM a2a_replies WHERE agent_id = ? AND thread_id = ? LIMIT 1')
      .get(agentId, fullThreadId);
    if (exact) return true;
    // No full-id row: accept a length-8 legacy row matched exactly, never a prefix over full ids.
    const legacy = db
      .prepare('SELECT 1 FROM a2a_replies WHERE agent_id = ? AND length(thread_id) = 8 AND thread_id = ? LIMIT 1')
      .get(agentId, threadShort);
    return !!legacy;
  }
  // Legacy caller path: only the 8-char token exists, so prefix match is the only resolution.
  // `a2aThreadTokenMatchesSql` (SQL twin of `a2aThreadTokenMatches`, clause-bound) covers both eras.
  const row = db
    .prepare(
      `SELECT 1 FROM a2a_replies
       WHERE agent_id = ? AND ${a2aThreadTokenMatchesSql('thread_id')}
       LIMIT 1`,
    )
    .get(agentId, threadShort, threadShort);
  return !!row;
}
