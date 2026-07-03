// ════════════════════════════════════════
// Active User Directive, the agent's "what was I asked to do" pin
// ════════════════════════════════════════
//
// Returns the most recent substantive user message in the agent's current
// session, formatted as a high-salience scaffolding block. The assembler
// injects this on every turn so the agent's most recent ask is always
// visible, regardless of how compaction folds the rest of the thread.
//
// Without this, after compaction the user's prompt becomes one row in a
// summarized blob and the agent re-anchors on whatever was loudest in the
// summary (often the file contents it just read), drifting away from the
// actual command. The directive pin makes the user's most recent ask
// permanently first-class.

import { getDb } from '../db/connection.js';

/** Min chars for a user message to qualify as "substantive". */
const SUBSTANTIVE_USER_MSG_MIN_CHARS = 200;

/** Hard cap on injected directive length (chars). */
const DIRECTIVE_MAX_CHARS = 8000;

interface UserMessageRow {
  id: string;
  content: string;
  created_at: string;
}

/**
 * Returns the most recent user message in the agent's current session that
 * looks like a real directive (length ≥ 200 chars). Falls back to the most
 * recent user message of any length if none qualify. Returns null if the
 * agent has no user messages in the current session.
 */
export function getActiveUserDirective(
  agentId: string,
  opts?: {
    /**
     * On a HUMAN turn, exclude engine-origin rows (scheduler/reminder events)
     * so a task that just fired can't masquerade as the user's directive and
     * pull the agent off the human conversation it's actually in. On an ENGINE
     * turn, leave them IN, the engine event IS the directive (OPEN-11).
     */
    excludeEngine?: boolean;
    /**
     * On a HUMAN turn, the conv_key of the conversation this turn is addressing.
     * When set, the directive is scoped to THIS conversation only (comms-audit T-1):
     * the most-recent substantive ask is picked from the current counterparty's
     * conversation, never from a DIFFERENT human's. Without this, talking to a contact
     * could pin the owner's task as the ACTIVE USER DIRECTIVE (cross-conversation leak).
     * Leave undefined on engine/A2A turns (the engine event / A2A thread drives those).
     */
    conversationKey?: string | null;
  },
): { content: string; messageId: string; createdAt: string } | null {
  // C16: the '__none__' sentinel means "this turn has no user directive", used on A2A
  // and engine turns, whose directive comes from the A2A payload / engine event (rendered
  // by the counterparty/engine header), NOT from the newest user row. Returning null here
  // stops an A2A inbound from being pinned as the ACTIVE USER DIRECTIVE. (Distinct from
  // conversationKey undefined = "unscoped, pick newest" and a real key = "scope to it".)
  if (opts?.conversationKey === '__none__') return null;
  const db = getDb();

  const sessionRow = db
    .prepare('SELECT session_started_at FROM agents WHERE id = ?')
    .get(agentId) as { session_started_at: string | null } | undefined;
  const sessionStart = sessionRow?.session_started_at ?? null;

  const baseClauses = ["agent_id = ?", "role = 'user'"];
  const baseParams: unknown[] = [agentId];
  if (sessionStart) {
    baseClauses.push("created_at >= ?");
    baseParams.push(sessionStart);
  }
  if (opts?.excludeEngine) {
    baseClauses.push("(origin_kind IS NULL OR origin_kind != 'engine')");
  }
  // T-1: scope to the current conversation. The current ask is conv_key-stamped at
  // pickup (turn start, before assembly), so it matches; a DIFFERENT human's ask
  // carries a different conv_key and is excluded from the directive pin.
  if (opts?.conversationKey) {
    baseClauses.push('conv_key = ?');
    baseParams.push(opts.conversationKey);
  }

  // Exclude asks already ANSWERED on their own conversation. An answered request
  // must never be re-pinned as the active directive: that is the OPEN-11 bug
  // where an unrelated later turn (a scheduler tick, an inbound email) re-runs a
  // stale answered ask and the agent re-replies out of nowhere. A user row is
  // "answered" iff a later assistant message carrying USER-FACING TEXT exists on
  // the SAME conv_key. Keying on a real text reply (not on pickup) means this can
  // NEVER drop the ask currently being answered, at context-assembly time the
  // turn has not produced its reply yet, so no later text row exists, and never
  // touches a still-waiting ask (conv_key IS NULL can't match the correlation, so
  // those rows are always kept). Pure tool_use assistant turns are NOT a reply,
  // so a half-finished ask (tools fired, no text yet) also stays in force. This
  // only ever REMOVES an answered ask from the headline pin; it never blocks a
  // turn, the live conversation tail is unaffected.
  baseClauses.push(
    "NOT EXISTS (SELECT 1 FROM messages a " +
      "WHERE a.agent_id = messages.agent_id AND a.role = 'assistant' " +
      "AND a.conv_key IS NOT NULL AND a.conv_key = messages.conv_key AND a.rowid > messages.rowid " +
      "AND (a.content NOT LIKE '[%' OR a.content LIKE '%\"type\":\"text\"%'))",
  );

  // Prefer the most recent substantive ask.
  const substantive = db
    .prepare(
      `SELECT id, content, created_at FROM messages
       WHERE ${baseClauses.join(' AND ')} AND length(content) >= ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(...baseParams, SUBSTANTIVE_USER_MSG_MIN_CHARS) as UserMessageRow | undefined;

  if (substantive) {
    return {
      content: substantive.content,
      messageId: substantive.id,
      createdAt: substantive.created_at,
    };
  }

  // Nothing substantive in this session, fall back to the most recent user
  // message of any length so the agent at least sees "you're being talked
  // to by a person" rather than nothing.
  const fallback = db
    .prepare(
      `SELECT id, content, created_at FROM messages
       WHERE ${baseClauses.join(' AND ')}
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(...baseParams) as UserMessageRow | undefined;

  if (!fallback) return null;
  return { content: fallback.content, messageId: fallback.id, createdAt: fallback.created_at };
}

/**
 * Format the directive as the wrapped scaffolding block the assembler injects.
 * Caps the body at DIRECTIVE_MAX_CHARS with a history_get pointer for the
 * agent to fetch the full body if needed.
 */
export function formatDirectiveBlock(directive: { content: string; messageId: string }): string {
  let body = directive.content;
  let truncationNote = '';
  if (body.length > DIRECTIVE_MAX_CHARS) {
    truncationNote = `\n\n[directive truncated to ${DIRECTIVE_MAX_CHARS} chars, call history_get(id="${directive.messageId}") for the full body]`;
    body = body.slice(0, DIRECTIVE_MAX_CHARS);
  }
  return (
    `═══ ACTIVE USER DIRECTIVE (the user's most recent substantive ask, still in force unless explicitly superseded by a newer user message in the live conversation below) ═══\n` +
    `${body}${truncationNote}\n` +
    `═══ END ACTIVE USER DIRECTIVE ═══`
  );
}
