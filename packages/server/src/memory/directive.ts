// ════════════════════════════════════════
// Active User Directive — the agent's "what was I asked to do" pin
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
export function getActiveUserDirective(agentId: string): { content: string; messageId: string; createdAt: string } | null {
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

  // Nothing substantive in this session — fall back to the most recent user
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
 * Caps the body at DIRECTIVE_MAX_CHARS with a memory_describe pointer for the
 * agent to fetch the full body if needed.
 */
export function formatDirectiveBlock(directive: { content: string; messageId: string }): string {
  let body = directive.content;
  let truncationNote = '';
  if (body.length > DIRECTIVE_MAX_CHARS) {
    truncationNote = `\n\n[directive truncated to ${DIRECTIVE_MAX_CHARS} chars — call memory_describe(id="${directive.messageId}") for the full body]`;
    body = body.slice(0, DIRECTIVE_MAX_CHARS);
  }
  return (
    `═══ ACTIVE USER DIRECTIVE (the user's most recent substantive ask — still in force unless explicitly superseded by a newer user message in the live conversation below) ═══\n` +
    `${body}${truncationNote}\n` +
    `═══ END ACTIVE USER DIRECTIVE ═══`
  );
}
