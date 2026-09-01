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
     * On a HUMAN turn, the `conversations.id` of the conversation this turn is addressing.
     * When set, the directive is scoped to THIS conversation only (comms-audit T-1):
     * the most-recent substantive ask is picked from the current counterparty's
     * conversation, never from a DIFFERENT human's. Without this, talking to a contact
     * could pin the owner's task as the ACTIVE USER DIRECTIVE (cross-conversation leak).
     * Leave undefined on engine/A2A turns (the engine event / A2A thread drives those).
     */
    conversationId?: string | null;
  },
): { content: string; messageId: string; createdAt: string } | null {
  // C16: the '__none__' sentinel means "this turn has no user directive", used on A2A
  // and engine turns, whose directive comes from the A2A payload / engine event (rendered
  // by the counterparty/engine header), NOT from the newest user row. Returning null here
  // stops an A2A inbound from being pinned as the ACTIVE USER DIRECTIVE. (Distinct from
  // conversationId undefined = "unscoped, pick newest" and a real key = "scope to it".)
  if (opts?.conversationId === '__none__') return null;
  const db = getDb();

  const sessionRow = db
    .prepare('SELECT session_started_at FROM agents WHERE id = ?')
    .get(agentId) as { session_started_at: string | null } | undefined;
  const sessionStart = sessionRow?.session_started_at ?? null;

  const baseClauses = ["agent_id = ?", "role = 'user'"];
  const baseParams: unknown[] = [agentId];
  if (sessionStart) {
    baseClauses.push("created_at >= (unixepoch(?) * 1000)");
    baseParams.push(sessionStart);
  }
  if (opts?.excludeEngine) {
    baseClauses.push("lane <> 'events'");
  }
  // ── T68b (2026-09-01) — C16'S OWN SENTENCE, FINALLY IMPLEMENTED. ────────────────────────
  //
  // The sentinel branch above says it "stops an A2A inbound from being pinned as the ACTIVE
  // USER DIRECTIVE", and it only ever did so on turns that carried `'__none__'`. On a wake
  // whose counterparty never resolved — `turns.kind` NULL, `conv_key` NULL, which is what
  // BehaviorBot's turns 5121 and 5122 were — the pin ran UNSCOPED, and the newest
  // substantive unanswered row in a fan-out is whichever helper answered LAST.
  //
  // What that produced, measured (W61 §2b, and the store's seqs 70613 / 70633 / 70654 /
  // 70662): the pin OSCILLATED. Healer answers, the block holds Healer's piece; Ticky
  // delivers, it holds Ticky's and Healer's is gone; the agent re-asks Healer, it flips
  // back. Every recovery attempt destroyed the piece the previous attempt recovered, so the
  // agent could never hold both, so it could never compile, so the engine redrove and it
  // ground again. The model's own recorded words for the state: "I keep going in circles."
  //
  // The clause is one line because the fact is one fact: `lane='a2a'` is stamped at ingest
  // and means AGENT TRAFFIC ("agent traffic must be declared, never assumed",
  // `message-store.ts`). A row on that lane is by construction not the user, and this block
  // is the ACTIVE **USER** DIRECTIVE — its header tells the model it holds "the user's most
  // recent substantive ask". Pinning a helper's deliverable there was the block lying about
  // its own contents.
  //
  // UNCONDITIONAL, not gated on `excludeEngine`, and that is deliberate: on an ENGINE turn
  // the directive is the engine event (OPEN-11) and a newer A2A deliverable out-competing it
  // is the same lie from the other side. There is no turn kind on which an A2A inbound is
  // the user's directive.
  //
  // WHAT THIS DOES **NOT** DO, stated so no one reads it as the whole fix: it does not
  // deliver the pieces. The pieces ride the fan-out compile order, which reaches the model
  // whole through the fresh tail (`memory/assembler.ts`, `isFanoutJoinImperative`). This
  // clause stops the oscillation and stops the block misdescribing what it holds.
  baseClauses.push("lane <> 'a2a'");
  // T-1: scope to the current conversation. The current ask carries its `conversation_id`
  // from ingest (and the turn re-stamps it at pickup if no producer did), so it matches; a
  // DIFFERENT human's ask carries a different conversation and is excluded from the pin.
  // PHASE-2 T10I: rekeyed off `conv_key`. The `'__none__'` sentinel above is UNCHANGED and
  // stays a sentinel on purpose — it does not name a conversation, it means "this turn has
  // none", which is a different statement from `undefined` ("unscoped, pick newest").
  if (opts?.conversationId && opts.conversationId !== '__none__') {
    baseClauses.push('conversation_id = ?');
    baseParams.push(opts.conversationId);
  }

  // Exclude asks already ANSWERED. An answered request must never be re-pinned as the
  // active directive: that is the OPEN-11 bug where an unrelated later turn (a scheduler
  // tick, an inbound email) re-runs a stale answered ask and the agent re-replies out of
  // nowhere.
  //
  // ── PHASE-2 T6 (C5) — R-2 IS CLOSED HERE. ──
  //
  // The clause this replaces asked "does a later assistant row on the same conv_key carry
  // USER-FACING TEXT", and it decided that by SNIFFING THE CONTENT:
  //     AND (a.content NOT LIKE '[%' OR a.content LIKE '%"type":"text"%')
  // — a JSON-shape probe standing in for "this was a reply". Research 21 records it as R-2
  // ("the directive gate keys on content shape, no origin_intent filter") and the fix it
  // asks for is exactly this: ONE reader of answeredness, and a ban on shape-sniffing.
  //
  // The replacement is the ANSWERED EDGE itself — `answer_message_id`, stamped at turn
  // finalize by the truthful-answer key and by nothing else (migration 113). It is the same
  // column `agent/v2/answered-edge.ts` reads for every other consumer, so "answered" means
  // one thing across the tree.
  //
  // requirement preserved, clause by clause, because each was load-bearing:
  //   * "can NEVER drop the ask currently being answered" — the stamp is written at turn
  //     FINALIZE, and this query runs during assembly, before the reply exists. Strictly
  //     safer than the old probe, which only needed a later text row to exist;
  //   * "never touches a still-waiting ask" — an unanswered row has a NULL stamp and is
  //     always kept;
  //   * "a half-finished ask (tools fired, no text yet) stays in force" — tool rows never
  //     produce an answer stamp, so no shape test is needed to exclude them;
  //   * it only ever REMOVES a row from the headline pin; the live tail is untouched.
  baseClauses.push('answer_message_id IS NULL');

  // Prefer the most recent substantive ask.
  const substantive = db
    .prepare(
      `SELECT id, content, datetime(created_at/1000,'unixepoch') AS created_at FROM messages
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
      `SELECT id, content, datetime(created_at/1000,'unixepoch') AS created_at FROM messages
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
