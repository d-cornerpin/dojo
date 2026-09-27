// ════════════════════════════════════════════════════════════════════════════════════════
// THE SESSION BOUNDARY, AS A TIME AXIS THE SUPPRESSION READS CAN ASK FOR.
//
// ── THE DEFECT THIS MODULE EXISTS FOR (measured, `conversation-identity-investigation.md`) ──
// A "session reset" is only a `WHERE` predicate move: it writes `agents.session_started_at`,
// archives, and inserts a divider. `conversations` identity is
// `UNIQUE(agent_id, channel, provider, counterparty_id, thread_root)` with NO session dimension
// (`memory/conversations.ts:58-93`), so THE SAME `conversation_id` SURVIVES EVERY RESET FOREVER.
// Every read that believed itself session-bounded *because* it was conversation-scoped was
// therefore unbounded. Measured on the owner's body: 3,930 of 3,931 session dividers have a prior
// answer-stamped ask in the same conversation — 99.97% of resets were reached across — and one
// such reach was byte-verified from a receipt (`engine.recently-answered`, 557 chars,
// sha256 `6a74962c238b9c92`, the FIRST turn after a reset, naming three asks that all predate it).
//
// ── WHY A SHARED MODULE AND NOT FOUR LOCAL CLAUSES ──
// Because of the type trap, which is recorded in `memory/store.ts:77-81` and has already cost
// this codebase a silent whole-context failure: `messages.created_at` is epoch-ms INTEGER since
// migration 131, and `agents.session_started_at` is TEXT. `<integer> >= '<datetime>'` does not
// error in SQLite — IT IS SIMPLY FALSE FOR EVERY ROW. A clause written the obvious way turns its
// read into a permanent empty list, and no SQL-literal scan can see it because the fragment never
// names a table. `store.ts` records what that cost when it happened to the fresh-tail loader:
// *"the whole tail comes back EMPTY, the model is handed nothing, and the turn ends without a
// reply."* So the conversion lives HERE, once, wrapped, with a test that plants the unwrapped
// form and proves it goes red.
//
// ── WHICH READS BIND, AND WHICH MUST NOT — THE DOCTRINE, NOT A PREFERENCE ──
// The axis is TIME, and it belongs on the reads that SUPPRESS, never on the reads that REMEMBER.
//
//   BOUND (a reset is a DECISION to forget, `tools/tool-docs.ts:279-285`; and the door's own
//   promise, `gateway/routes/chat.ts:423-424`: *"so a fresh session doesn't treat pre-reset
//   conversations as already answered"*):
//     · `engine.recently-answered`'s read — the engine naming settled asks.
//     · the recorded-answer rung — the engine quoting an answer as a reason not to work.
//     · the ask-titling read — prior owner context that titles a NEW ticket.
//     · the recall lane's ALREADY-ANSWERED imperative (demoted, not deleted — see below).
//
//   NOT BOUND, each for a cited reason:
//     · `memory/retrieval.ts` (`history_search` / `history_get` / `history_expand`) — agent-scoped,
//       no session clause and no conversation clause. THIS is the recovery path the owner's own
//       2026-09-24 incident ended on ("finally running history_get and answering correctly"), and
//       `SWEEP-C.md:17(d)` is why it may reach: pre-reset rows stay searchable, *"which is what
//       makes cross-session recall possible at all."*
//     · `memory/recall-lane.ts` retrieval — cross-session recall is its charter.
//     · `agent/v2/outbound-ledger.ts` — the duplicate-send guard must not forget at a reset, or a
//       reset becomes a licence to send the same message twice.
//     · the fresh tail — already bounded, by this very column.
//
// ⚠ ONE CORRECTION TO THE INVESTIGATION THAT COMMISSIONED THIS MODULE, since it is the kind of
// inherited claim that gets re-copied: it lists `memory/recall.ts:287` as a read that must NOT
// bind, on the grounds that it is the recovery path. `memory/recall.ts` IS ALREADY SESSION-BOUNDED
// at HEAD — `:241-244` carries `created_at >= (unixepoch(?) * 1000)` under its own comment,
// *"Respect session boundary so a recent reset doesn't bleed pre-reset content into the recall"* —
// so nothing was left undone there, and the module named for the reason given was the wrong one.
// That the platform had ALREADY chosen this bound for a recall read is corroboration, not a
// conflict: the answered-edge reads were the outliers, not the precedent.
//
// ⚠ THE DISTINCTION THAT DECIDED THE RECALL LANE, and it is the one judgement in this module.
// An answered pair reaching across a reset carries TWO things: a CONCLUSION (memory, legitimate,
// and the recall lane's charter) and an IMPERATIVE (*"Do NOT re-run the work"* — the pair block's
// own words). A reset is the owner's explicit instruction to forget; the owner's own word for an
// unwanted one is "amnesia" (`overhaul-plans/ANSWER-ANYWAY.md:5`). Keeping the conclusion honours
// recall; keeping the imperative overrides the instruction. So pre-boundary pairs KEEP THEIR
// CONCLUSION AND LOSE THEIR IMPERATIVE. Deleting them instead would have been the cheaper edit
// and the wrong one — `recall-lane.test.ts` has asserted since it was written that a conclusion
// from the previous session is still recallable, and that clause is correct.
//
// This also settles the promotion hazard the investigation flagged (§4.4): carrier 1 shortening
// at a boundary frees carrier 2 to promote the same asks from a 90-char question excerpt to a
// verbatim ANSWER quote. Under the demotion the promotion still happens — the conclusion is still
// quoted — but it arrives as memory under a head that says to answer again, not as an instruction
// not to. The alternative (bind the dedup set so the pairs vanish) was rejected: it makes a reset
// delete memory, which is a bigger change than the defect, and it fails the clause above.
//
// ── OWNER RULING THAT BREAKS EVERY REMAINING TIE (2026-08-05, governing) ──
// Ambiguity resolves toward ANSWERING AGAIN. Both directions of this change point the same way:
// a settled ask stops being listed after a reset, and a recalled conclusion stops carrying an
// order. Nothing here makes the engine quieter about work it has NOT done.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';

/**
 * The qualifier a RELEASED answered pair carries in the recall lane.
 *
 * When `engine.recently-answered` became session-bounded it stopped naming pre-reset asks — and
 * the recall lane dedups against that ledger, so at a boundary the same asks are RELEASED to it
 * and promoted from a 90-char question excerpt to a verbatim ANSWER quote (the investigation's
 * §4.4 promotion ladder, now firing at every reset instead of at every fourth ask). That promotion
 * is not a bug to suppress: the conclusion is memory and this lane's charter, and a clause has
 * asserted since it was written that a previous session's conclusion stays recallable.
 *
 * What may NOT survive the boundary is the lane's imperative — `PAIRS_HEAD`'s *"Do NOT re-run the
 * work"*. A reset is the owner asking to be forgotten (his own word for an unwanted one is
 * "amnesia"), so an engine record ordering the model not to redo the work overrides him. The row
 * therefore keeps its quote and loses its order, and this sentence is the difference.
 *
 * PER-ROW, on `work/obligations.ts`'s `[other conversation]` precedent, rather than a second
 * block under its own heading: the qualifier rides the row it qualifies, so no truncation ladder
 * can drop the heading and leave the quote reading as an instruction. REJECTED alternative:
 * binding the dedup SET so the pairs vanish at a reset — that makes a reset delete memory, which
 * is a larger change than the defect and fails the recallable-conclusion clause.
 */
export const PRE_RESET_PAIR_TAG =
  ' [before this session — memory, not an instruction: if asked again, answer again]';

/**
 * The agent's session boundary as the TEXT datetime the column holds, or `null`.
 *
 * `null` means "this agent has no boundary recorded" and every caller treats it the same way:
 * NO CLAUSE IS ADDED. That is deliberate and it is the safe direction — an agent that has never
 * been reset must read exactly as it does today, and a missing boundary must never be rendered as
 * `>= NULL` (which matches nothing and would empty the read).
 */
export function sessionBoundaryText(agentId: string): string | null {
  const row = getDb().prepare('SELECT session_started_at FROM agents WHERE id = ?')
    .get(agentId) as { session_started_at: string | null } | undefined;
  return row?.session_started_at ?? null;
}

/**
 * The same boundary as epoch ms, for comparisons made in TypeScript rather than in SQL.
 *
 * Used by the recall lane, which already holds `answerAtMs` on every pair and must decide the
 * demotion in the reader rather than the renderer — the renderer is a pure function of its
 * payload and stays that way.
 */
export function sessionBoundaryMs(agentId: string): number | null {
  const text = sessionBoundaryText(agentId);
  if (!text) return null;
  const ms = Date.parse(text.endsWith('Z') || text.includes('+') ? text : `${text}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The comparison, wrapped once, for a SQL statement that binds POSITIONAL parameters.
 *
 * `col` is a SQL identifier the CALLER supplies from its own literal — never user input, exactly
 * as `memory/store.ts`'s `createdAtText` takes one. The bound parameter is the TEXT boundary.
 *
 * ⚠ THE WHOLE POINT IS THE `unixepoch(...) * 1000`. Write `created_at >= ?` with a TEXT boundary
 * and SQLite compares an INTEGER to a STRING, which is FALSE for every row, silently, for ever.
 * `session-boundary.test.ts` plants that exact form and proves it returns nothing.
 */
export function sessionBoundaryClause(col = 'created_at'): string {
  return `${col} >= (unixepoch(?) * 1000)`;
}

/**
 * Apply the clause and the parameter together, so a caller cannot add one without the other.
 *
 * Returns the SQL to splice and the params to append, or the identity pair when the agent has no
 * boundary. Callers read as one line each, which is what makes this affordable in files that are
 * at their size pin — the argument lives here, the sites carry the call.
 */
export function withSessionBoundary(
  agentId: string, col = 'created_at',
): { sql: string; params: string[] } {
  const boundary = sessionBoundaryText(agentId);
  return boundary
    ? { sql: ` AND ${sessionBoundaryClause(col)}`, params: [boundary] }
    : { sql: '', params: [] };
}
