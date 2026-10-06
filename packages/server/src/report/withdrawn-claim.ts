// ════════════════════════════════════════════════════════════════════════════════
// IS THE REPORT BEHIND THIS ANSWER STILL STANDING? — one predicate, one home.
//
// ── WHY THIS IS ITS OWN MODULE (round 3) ────────────────────────────────────────────────
// It lived inside `agent/v2/answered-edge.ts` for two rounds, and that file's own header
// declares it the ONE place this tree answers *"has the person heard from us"*. This asks a
// DIFFERENT question — *"is the thing we told them about still there?"* — and it answers it out
// of `dojo_reports`, whose vocabulary lives next door in `store.ts`. Two questions, two homes:
// the edge owns answeredness and imports this; this owns artefact validity and knows nothing
// about stamps, deliveries, closeouts or the poke ladder. The split was taken rather than a
// third ceiling raise on the edge, which is what the second raise's own note said to do.
//
// ── WHAT IT IS FOR, IN ONE PARAGRAPH ────────────────────────────────────────────────────
// `dojo_report` is the only user-facing door in the engine that writes no `deliveries` row, so
// the "answered" stamp and the preview card it announced have no edge between them: cancel the
// card and every read that lists or quotes settled asks keeps serving the claim as an engine
// record, under *"do NOT re-execute this work"*. Reproduced three times on clean agents through
// real HTTP doors. The three carriers of that record ask this predicate first.
//
// ── THE BINDING IS THE PLATFORM'S OWN MINTED ID, AND THAT IS THE ROUND-3 FINDING ─────────
// Rounds 1-2 bound only `tool_use.input.report_id` — the id an agent PASSES BACK. Round 3's
// red is one generation later and permanent: a turn that calls no tool and merely RESTATES
// *"it's already filed — sitting on your dashboard (report 067df9fa)"* has no such input, so it
// bound nothing and its stamp was immune for ever. Measured on the live body, that shape is not
// exotic — it is 5 of the 8 known false-filed stamps, including all three of the harness bot's
// survivors, whose replies the round-3 record quotes verbatim.
//
// So the binding is the ID ITSELF, wherever a recorded row of this agent names it:
//   * the `tool_use` row of a `draft`/`submit` call (the id is in its JSON input);
//   * the `tool_result` row of a `gather` call — which ISSUES the id ("Report <uuid> opened"),
//     and is the only trace a gather-only turn leaves. Platform-authored text;
//   * the agent's own reply restating the claim and naming the report, at any generation.
//
// ⚠ AND YES, THIS MATCHES TEXT — DELIBERATELY, AND NARROWLY. The neighbouring edge's rule is
// "no prose is read", and it is a good rule: a phrase list deciding what an answer MEANS is the
// shape the deliverable-claim floor was removed for twice. This is not that. The needle is a
// UUID THE PLATFORM MINTED ITSELF (`createReport`'s `uuidv4`), looked up from
// `dojo_reports` rows this agent owns — never a word, never a phrase, never a judgement about
// meaning, and with no report row there is no needle at all. The precedent is in the tree:
// `agent/v2/classifiers/output.ts`'s `LEADING_TIME_STAMP_RE` recognises the assembler's OWN
// bracket-stamp in model output (pinned by `stamp-strip.test.ts`), for the same reason —
// recognising what we minted is reading our own record, not classifying somebody's prose.
// 8 hex characters is the match width (32 bits, and the model writes the short form: "report
// 067df9fa"); a full id contains its own prefix, so one condition covers both. Measured over
// 39,005 rows of the 7 gate-armed agents: 3 sites matched by the short form, 0 by accident.
//
// ── THE MEASUREMENTS THE SHAPE WAS CHOSEN ON (readonly, the owner's box, 2026-09-26) ─────
// Corpus: 4,242 answered asks on the 7 agents holding a non-standing report row.
//
//   binding                                              voids the 8 known bad stamps | corpus
//   rounds 1-2 (tool_use input only)                      3/8   |  8/4242 = 1.9/1000
//   + tool_result (gather's issued id)                    5/8   | 10/4242 = 2.4/1000
//   + the answer naming the id                            7/8   | 12/4242 = 2.8/1000
//   + one turn back  ← THIS                               8/8   | 13/4242 = 3.1/1000
//   report LIFETIME window [created, cancelled]           6/8   | 10/4242 = 2.4/1000
//   report lifetime, open-ended (REFUSED)                 8/8   | 17/4242 = 4.0/1000
//
// **Every one of the 13 this voids is a genuine report ask** — enumerated, ask text and answer
// text read by hand, zero non-report collateral. The open-ended lifetime rule also reaches 8/8
// and was REFUSED on its collateral: it voids *"How many centimetres are there in one metre?"*,
// *"…does water boil…"* and *"What is the capital city of Portugal?"* on one repro agent, i.e.
// it strips anti-repetition from ordinary asks that merely happened after a dead report — which
// the owner forbids just as firmly as the false claim (his 2026-08-09 incident).
// ════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import type { ReportStatus } from './store.js';

const logger = createLogger('withdrawn-claim');

/**
 * The report states in which the artefact — or its delivery — STILL STANDS, so an answer that
 * announced it is still true and is listed and quoted exactly as before.
 *
 * Reasoned per state rather than as a list, because the direction of each is the whole ruling:
 *   * `awaiting_approval` — the preview card is on the owner's dashboard. The claim is true;
 *   * `approved`          — decided, waiting on the transport. Still standing;
 *   * `posted`            — delivered, by `markPosted` OR by `markExported` (the export door
 *                           writes `status='posted'` with `export_path`, so "exported" is this
 *                           state and needs no entry of its own);
 *   * `cancelled`         — WITHDRAWN. Nothing is on the dashboard; the claim is false;
 *   * `drafting`          — the claim was PREMATURE. This is round 1's false-filed shape: a
 *                           brief attached, nobody ever asked, and the agent announcing a card
 *                           that was never submitted. Void.
 * Anything this release does not recognise falls outside the set and is therefore treated as
 * withdrawn — the same safe direction `store.ts`'s rule 4 takes for an unknown status.
 */
const STANDING_REPORT_STATUSES: readonly ReportStatus[] = ['awaiting_approval', 'approved', 'posted'];

// ── THE TWO ARMS OF THE WINDOW, AS TWO STATEMENTS, BECAUSE AN `OR` GETS NEITHER INDEX ─────
// Round-2 review F1: these were one statement with `(turn_number = ? OR (seq BETWEEN ? AND ?))`
// and the plan collapsed to a scan of every message row of the agent — 18.7 ms, and 52.4 ms for
// one `recentlyAnsweredAsks(3)`, on EVERY model call. Split, each arm keeps its index. Measured
// again after round 3's rule change (the harness bot, 38,872 messages):
//   turn arm  `SEARCH m USING INDEX ix_msg_turn (agent_id=? AND turn_number>? AND <?)`  0.148 ms
//   span arm  `SEARCH m USING INDEX idx_messages_agent_id (agent_id=? AND rowid>? …)`   0.022 ms
//   the whole read, three asks, per model call                                          1.007 ms
// The outer `SCAN r` is the 17-row report table, which is what makes one LIKE per report row
// affordable. Written out in full rather than built from a shared fragment: the SQL gate
// prepares literal statements against the migrated schema, and a `${…}` builder hides both.
const REPORTS_NAMED_IN_TURNS = `SELECT DISTINCT r.id AS id, r.status AS status
         FROM messages m
         JOIN dojo_reports r ON r.agent_id = ?
                            AND m.content LIKE '%' || substr(r.id, 1, 8) || '%'
        WHERE m.agent_id = ? AND m.turn_number BETWEEN ? AND ?
          AND m.role IN ('assistant', 'tool')`;
const REPORTS_NAMED_IN_SPAN = `SELECT DISTINCT r.id AS id, r.status AS status
         FROM messages m
         JOIN dojo_reports r ON r.agent_id = ?
                            AND m.content LIKE '%' || substr(r.id, 1, 8) || '%'
        WHERE m.agent_id = ? AND m.seq >= ? AND m.seq <= ?
          AND m.role IN ('assistant', 'tool')`;

// ── THE DURABLE BINDING (migration 182) — ASKED FIRST, AND IT ENDS THE QUESTION ──────────
// The round-2 investigation named this and three rounds paid interest on it: the window below
// is RAW CONTAINMENT, and the durable fix is a column binding the report to the ask. 182 is
// that column, `report/store.ts`'s `askIdForNow` writes it at mint time, and this is the read.
//
// It is asked FIRST and it is CONCLUSIVE when it answers, because it is not evidence of the
// same kind. Containment asks "which reports are NEAR this answer" and accepts five measured
// over-void shapes to do it; this asks "which report was opened FOR this ask", which the
// platform knew at the moment it minted the id and now writes down. When a bound row exists
// there is nothing left to infer, so none of the three containment arms runs and none of their
// collateral applies — no sibling ask in the same turn, no span neighbour, no other
// conversation, no previous turn.
//
// `ask_id` is the ask's `messages.id`, so the lookup needs the ask's ID and this function is
// handed its `seq`. One indexed hop converts it, deliberately HERE rather than by widening
// `answerStillStands`'s signature: the three callers live in `agent/v2/answered-edge.ts`, whose
// own header declares it the one place this tree answers "has the person heard from us". This
// module owns artefact validity. Keeping the conversion inside the module that needs it leaves
// that seam where round 3 put it.
const REPORTS_BOUND_TO_ASK = `SELECT r.id AS id, r.status AS status
         FROM dojo_reports r
        WHERE r.agent_id = ? AND r.ask_id = ?`;

/** The ask's own row id, from the `seq` the answered edge hands us. `(agent_id, seq)` is the
 *  pair every arm here is already keyed on, and `idx_messages_agent_id` serves it. */
const ASK_ROW_ID = `SELECT id FROM messages WHERE agent_id = ? AND seq = ? LIMIT 1`;

/** How far back the turn arm reaches. ONE, and the number is measured rather than chosen: at 1
 *  it catches the no-id restatement (the harness bot's 83265, which called no tool and named no id
 *  one turn after the work) and adds nothing else; at 2 it starts voiding *"How many centimetres
 *  are there in one metre?"*. The cheapest honest reach, and the residual it leaves is stated at
 *  `answerStillStands`. */
const TURNS_BACK = 1;

/**
 * THE CHEAP GATE, and it is also the blast-radius statement: an agent with NO non-standing report
 * row cannot have a withdrawn-report answer, so every caller returns exactly what it returned
 * before this machinery existed and pays one tiny-table read to prove it. `drafting` is
 * non-standing, so an in-flight or abandoned draft arms the gate as well — deliberate (a
 * `drafting` row IS round 1's false-filed shape), and the reason this is not phrased as "never
 * withdrew a report".
 *
 * COST, measured readonly on the owner's box: the plan is `SCAN dojo_reports` — there is no index
 * on `agent_id`, only `(status, created_at)`, `signature` and the PK — at 0.010 ms over 17 rows.
 * Left as a scan deliberately: the index-using form is `status IN (<the non-standing values>)`,
 * and a closed IN-list cannot express "anything this release does not recognise", which is the
 * safe direction `store.ts`'s rule 4 takes. It grows with every report ever filed; when that
 * table stops being tiny, index `agent_id`.
 *
 * A database with no `dojo_reports` table (a hand-built test fixture) has no reports at all,
 * which is the same answer — this is not a swallowed failure, it is the truth on that box.
 */
function agentHasWithdrawnReport(agentId: string): boolean {
  const marks = STANDING_REPORT_STATUSES.map(() => '?').join(', ');
  try {
    return getDb().prepare(
      `SELECT 1 AS ok FROM dojo_reports
        WHERE agent_id = ? AND status NOT IN (${marks}) LIMIT 1`,
    ).get(agentId, ...STANDING_REPORT_STATUSES) !== undefined;
  } catch {
    return false;
  }
}

/**
 * TOLERATE AND LOG, once per agent per process. An agent whose report rows carry no binding for
 * the ask being checked is answered by containment, which is correct and measured — but it is
 * the WEAKER instrument, and a box quietly running on it for ever is a thing an operator should
 * be able to see. `info` and not `warn`: this is not a failure, it is the pre-182 population
 * being served by the arm built for it, and a `warn` per model call would be noise that teaches
 * people to ignore the channel.
 */
const legacyReported = new Set<string>();
function tolerateLegacy(agentId: string): void {
  if (legacyReported.has(agentId)) return;
  legacyReported.add(agentId);
  logger.info(
    'withdrawn-claim: no report row names this ask, so the containment window decides it '
    + '(rows predating migration 182 carry no `ask_id`, and nothing backfills one)',
    { agentId },
  );
}

/**
 * Does the answer this stamp points at STILL STAND — i.e. may it be listed and quoted to the
 * model as something the person already has?
 *
 * `false` ONLY when report rows are named inside the window below and EVERY one of them has left
 * the standing set. A stamp that names no report, one whose report is still on the card, and one
 * that re-filed after a cancel (a withdrawn row AND a standing row — measured, and it is a real
 * agent's recovery) all still stand: this refuses one shape, an answer whose only artefacts are
 * gone.
 *
 * ── THE WINDOW, AND WHAT IT IS NOT ──
 * RAW CONTAINMENT, not a binding to the ask: rows in the stamp's own turn and the one before it,
 * plus rows whose `seq` falls between the ask and its answer. Agent-scoped — NOT
 * conversation-scoped, while the reads that filter through it are. Every arm is needed and each
 * was measured against a real shape:
 *   * the SPAN arm — Arm B records its `dojo_report` calls on turn N while the stamp points at
 *     turn N+1's reply, because the engine's "you have not spoken yet this turn" hint opens a
 *     new turn;
 *   * the TURN arm — the kit-driven agent writes its call rows AFTER the answer row inside one
 *     turn, which is why the window deliberately reaches past the answer;
 *   * ONE TURN BACK — the restatement that names no id at all (the harness bot 83265: no tool call,
 *     no id, one turn after the work that died).
 *
 * FIVE OVER-VOID SHAPES ARE MEASURED AND ACCEPTED: two asks batched into one turn void together
 * (`setAnswerMessageId` stamps every row it served); the span arm does the same for anything
 * answered between the pair; a report named in ANOTHER conversation inside the span voids a
 * dashboard ask; the turn arm reaches rows written before the ask; and the one-turn reach adds
 * the previous turn's rows. Over the live corpus that costs 13 of 4,242 answered asks and every
 * one of the 13 is a genuine report ask — zero non-report collateral, listed in the header. An
 * over-void costs one unrelated ask its anti-repetition (the owner may hear an answer twice,
 * which owner ruling 2026-08-05 chooses in those words); the under-void direction is the red.
 *
 * ── AND ALL OF IT IS THE SECOND ARM'S PRICE ONLY (migration 182) ──
 * Those shapes are what RECONSTRUCTING a binding from proximity costs, so they are paid only where
 * there IS none: a row naming this ask is answered at the top of this function and reaches none of
 * them, so the batch partner and the span neighbour keep their stamps on every report filed since
 * 182 (`the-report-remembers-which-ask-it-answers` §3). The old residual — a restatement naming no
 * id, two turns from any row that does, 0 of the 4,242 — is closed outright for bound rows; what
 * is left is the pre-182 population, where nothing backfills honestly.
 */
export function answerStillStands(
  agentId: string, askSeq: number, answerMessageId: string | null | undefined,
): boolean {
  if (!agentHasWithdrawnReport(agentId)) return true;
  if (!answerMessageId) return true;
  let named: Array<{ id: string; status: string }>;
  try {
    const db = getDb();
    const ans = db.prepare(
      'SELECT seq, turn_number AS turn FROM messages WHERE id = ? AND agent_id = ?',
    ).get(answerMessageId, agentId) as { seq: number; turn: number | null } | undefined;
    // A stamp whose answer row is gone (a cleared history) has no window to check, and it
    // counted as answered before this machinery existed — it still does.
    if (!ans) return true;
    const arm = (sql: string, params: unknown[]): Array<{ id: string; status: string }> =>
      db.prepare(sql).all(...params as never[]) as Array<{ id: string; status: string }>;

    // ── THE BOUND ARM FIRST, AND IT RETURNS (migration 182) ──
    // A report row that NAMES this ask settles the question by itself: the platform recorded
    // which ask it opened the report for, so there is nothing to infer from proximity and none
    // of containment's five accepted over-void shapes gets to apply. One standing bound row
    // keeps the answer, exactly as in the window below — an ask that lost one card and had
    // another filed for it is telling the truth about the one that exists.
    const askRow = db.prepare(ASK_ROW_ID).get(agentId, askSeq) as { id: string } | undefined;
    if (askRow !== undefined) {
      const bound = arm(REPORTS_BOUND_TO_ASK, [agentId, askRow.id]);
      if (bound.length > 0) {
        return bound.some((r) => (STANDING_REPORT_STATUSES as readonly string[]).includes(r.status));
      }
    }

    // ── AND THE CONTAINMENT ARMS FOR EVERYTHING ELSE, WHICH IS NOT A TEMPORARY STATE ──
    // Reached when no report row names this ask: either every one of this agent's rows predates
    // 182 (`ask_id IS NULL` — nothing is backfilled, because a historical row's ask is only
    // recoverable from the very proximity this replaces, and writing that guess into the
    // binding column would make the column untrustworthy for ever), or the rows are bound to
    // OTHER asks and this ask's claim is carried by a restatement. Both are real and permanent
    // populations, so the window below is the standing answer for them, not a migration-era
    // shim. `tolerateLegacy` records which it was, once per process per agent, so a box still
    // leaning on containment can be seen to be doing so.
    tolerateLegacy(agentId);
    named = ans.turn === null ? []
      : arm(REPORTS_NAMED_IN_TURNS, [agentId, agentId, ans.turn - TURNS_BACK, ans.turn]);
    named = named.concat(arm(REPORTS_NAMED_IN_SPAN, [agentId, agentId, askSeq, ans.seq]));
  } catch (err) {
    // ⚠ FAIL OPEN — ARGUED, NOT CONVENIENT, AND SAID OUT LOUD. A throw here is the INSTRUMENT
    // failing, not ambiguity about whether the person was answered, and the 2026-08-05 priority
    // governs the second question rather than the first. Failing CLOSED would void EVERY answered
    // ask on the agent — all three reads of the answered edge filter through this — so one
    // malformed row would re-open the owner's 2026-08-09 repeat-yourself incident across the
    // board; failing open loses only the withdrawal check, which is precisely the behaviour that
    // existed before this machinery. So it stays `true` and it SHOUTS, because a silent revert to
    // the behaviour this exists to remove is how the defect comes back. Pinned by "the instrument
    // failing is LOUD, and it fails OPEN" — deleting this log or flipping the direction is RED.
    logger.error(
      'withdrawn-claim: the withdrawn-report check could not run, so this answer stamp STANDS '
      + '(pre-fix behaviour) — until this is fixed a cancelled report card can be asserted as live',
      { askSeq, answerMessageId, error: err instanceof Error ? err.message : String(err) },
      agentId,
    );
    return true;
  }
  // One standing row anywhere in the window keeps the answer: a turn that lost one card and filed
  // another is telling the truth about the one that exists.
  if (named.length === 0) return true;
  return named.some((r) => (STANDING_REPORT_STATUSES as readonly string[]).includes(r.status));
}
