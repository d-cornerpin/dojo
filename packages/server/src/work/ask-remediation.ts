// ════════════════════════════════════════════════════════════════════════════════
// THE REMEDIATION PASS — SWEEP-A TB3 (`DESIGN-2BUGS/DESIGN.md` §5).
//
// TB1 and TB2 stopped the ask ledger telling lies. This pass corrects the ones already
// written down. It runs ONCE per box, armed by migration `158` and disarmed by its own
// completion row, so a lived-in database crossing this build gets the same correction the
// dev box got (roadmap non-negotiable #5; `STABLE-BRIDGE.md` Entry 39).
//
// ── IT OWNS NO RULE ──
// Every settlement decision here is `settleAsk`'s and every evidence read is the authority's
// own exported predicate (`askAnswerEvidence`). This file supplies SCOPE — which rows to ask
// about — and nothing else. A remediation with its own predicate would be a second decider,
// and then the past and the future could disagree about the same ask.
//
// ── THE GOVERNING PRIORITY (owner ruling, 2026-08-05) ──
// "The user asks the agent to do something and it does it. Period." Ambiguous evidence errs
// toward SERVING THE ASK AGAIN. Worst case the owner hears an answer twice; it never errs
// toward silence, a parked ticket or a quiet close. That is why a stuck `claimed` ask with no
// receipt is handed BACK rather than tidied away, and why a `done` that turns out to point at
// a tool-call chip and nothing else is re-opened rather than left looking finished.
//
// ── THE RECORD IS NEVER FALSIFIED ──
// Every correction is a recorded move with its reason. The write-off transitions stay in the
// history; the chip receipts stay on the delivery ledger; nothing is deleted or back-dated.
// A reader of `work_events` can always see what the row said before this pass ran and why it
// says something else now.
//
// ── INTERACTION WITH THE REBOOT-SWARM GUARD (DESIGN §5, and it is handled rather than
//    discovered) ──
// Every ask this pass hands back is by definition older than thirty minutes, so a later boot
// would meet `work-reaper.ts`'s staleness sweep. The guard is UNTOUCHED. The pass is invoked
// AFTER that sweep has already run for this boot and BEFORE the re-drain, so (a) this boot's
// guard never sees the rows the pass creates, and (b) the re-drain that follows is what
// drives them to settlement in the same sitting. The caller records what did not settle;
// nothing is left for a reboot to meet by accident.
// ════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { askAnswerEvidence, settleAsk, NON_ANSWERING_DELIVERY_TOOLS, NON_ANSWERING_DISPLAY_KINDS } from './ask-settlement.js';
import { appendWorkEvent, clearJoinCompilePending, transition } from './store.js';

const logger = createLogger('ask-remediation');

/** The actor recorded on every row this pass moves, so the corrections are findable as a set
 *  and can never be mistaken for a turn's own work. */
export const REMEDIATION_ACTOR = 'ask-remediation-tb3';

/** The `config` key migration `158` writes to arm the pass, and this module clears when it
 *  has run. One row, so a restart cannot run the pass twice and a half-finished pass is
 *  simply re-run (every branch below is idempotent by predicate, not by bookkeeping). */
export const REMEDIATION_ARMED_KEY = 'ask_ledger_remediation_158';

export interface AskRemediationReport {
  stuckClaimed: { candidates: number; closed: number; held: number; reopened: number; unchanged: number };
  answeredThenAbandoned: { candidates: number; corrected: number; refused: number };
  compilePendingOrphans: { candidates: number; cleared: number };
  chipReceipts: { candidates: number; repointed: number; reopened: number; handedUp: number };
  /** Rows handed back `open` by this pass — the set the caller must drive to settlement in
   *  the same sitting (DESIGN §5). */
  reopenedIds: string[];
}

const emptyReport = (): AskRemediationReport => ({
  stuckClaimed: { candidates: 0, closed: 0, held: 0, reopened: 0, unchanged: 0 },
  answeredThenAbandoned: { candidates: 0, corrected: 0, refused: 0 },
  compilePendingOrphans: { candidates: 0, cleared: 0 },
  chipReceipts: { candidates: 0, repointed: 0, reopened: 0, handedUp: 0 },
  reopenedIds: [],
});

/** The turn that picked the ask up, from the row's own event — `work.claimed_by_turn` is
 *  CLEARED by any terminal move, so a row that was closed or written off no longer carries
 *  it, and the evidence read needs it. */
function claimingTurn(workId: string): number | null {
  const r = getDb().prepare(
    `SELECT json_extract(payload, '$.turn_number') AS t FROM work_events
      WHERE work_id = ? AND kind = 'claim_turn' ORDER BY id DESC LIMIT 1`,
  ).get(workId) as { t: number | null } | undefined;
  return r?.t ?? null;
}

/**
 * A TRIAGE READ, and it is deliberately NOT a settlement rule.
 *
 * It answers one question about a `done` ask whose receipt is a tool-call chip: did ANY real
 * answer ever go out in that conversation afterwards? It never closes, re-points or re-opens
 * anything on its own — `settleAsk` and `askAnswerEvidence` still own every decision. What it
 * decides is whether the row is unambiguous enough for this pass to act on at all:
 *
 *   * a real answer landed on the SERVING TURN      -> the authority endorses it; re-point;
 *   * no answer of any kind ever followed           -> nothing was ever delivered for this
 *                                                     ask, so it is handed back (priority one);
 *   * an answer landed, but on a DIFFERENT TURN     -> the authority cannot endorse it as this
 *                                                     ask's answer (that narrowing is exactly
 *                                                     what TB2 added to stop a status line
 *                                                     being read as a compiled report), and
 *                                                     re-opening it would re-serve a question
 *                                                     the person may well have had answered.
 *                                                     AMBIGUOUS: counted, handed up, untouched.
 */
function anyLaterRealDelivery(
  agentId: string, conversationId: string | null, notBefore: string,
): boolean {
  if (conversationId == null) return false;
  const excluded = [...NON_ANSWERING_DELIVERY_TOOLS];
  const chips = NON_ANSWERING_DISPLAY_KINDS.map((k) => `'${k}'`).join(', ');
  const hit = getDb().prepare(
    `SELECT 1 AS ok FROM deliveries d
      WHERE d.agent_id = ? AND d.conversation_id = ? AND d.outcome = 'delivered'
        AND d.tool NOT IN (${excluded.map(() => '?').join(', ')})
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = d.message_id AND m.display_kind IN (${chips}))
        AND d.created_at >= ?
      LIMIT 1`,
  ).get(agentId, conversationId, ...excluded, notBefore) as { ok: number } | undefined;
  return hit !== undefined;
}

/**
 * THE PASS.
 *
 * `dryRun` counts every branch without writing — the rehearsal mode #16 requires, and the
 * mode the Bridge entry's branch-coverage table is produced from. A branch that touches zero
 * rows in a rehearsal is untested, so the count is per BRANCH rather than per class.
 */
export function remediateAskLedger(opts: { dryRun?: boolean } = {}): AskRemediationReport {
  const dry = opts.dryRun === true;
  const db = getDb();
  const r = emptyReport();

  // ══ CLASS 1 — STUCK `claimed` ═════════════════════════════════════════════════
  // An ask whose claiming turn has FINALIZED (or whose turn row never existed) and which is
  // still `claimed`. That is the fossil the finalize invariant now makes unrepresentable
  // going forward; these are the rows written before it existed. A turn still in flight is
  // deliberately excluded — the pass adjudicates fossils, never work in progress.
  const stuck = db.prepare(
    `SELECT w.id AS id, w.agent_id AS agent_id, w.claimed_by_turn AS turn_number
       FROM work w
       LEFT JOIN turns t ON t.agent_id = w.agent_id AND t.turn_number = w.claimed_by_turn
      WHERE w.kind = 'ask' AND w.state = 'claimed'
        AND (w.claimed_by_turn IS NULL OR t.turn_number IS NULL OR t.ended_at IS NOT NULL)
      ORDER BY w.opened_at`,
  ).all() as Array<{ id: string; agent_id: string; turn_number: number | null }>;
  r.stuckClaimed.candidates = stuck.length;
  for (const row of stuck) {
    if (dry) {
      const ev = askAnswerEvidence(row.id, row.turn_number);
      if (ev) r.stuckClaimed.closed++; else r.stuckClaimed.reopened++;
      continue;
    }
    const v = settleAsk(row.id, {
      agentId: row.agent_id, turnNumber: row.turn_number, at: 'finalize', actorId: REMEDIATION_ACTOR,
    });
    if (v.verdict === 'closed') r.stuckClaimed.closed++;
    else if (v.verdict === 'held') r.stuckClaimed.held++;
    else if (v.verdict === 'reopened') { r.stuckClaimed.reopened++; r.reopenedIds.push(row.id); }
    else r.stuckClaimed.unchanged++;
  }

  // ══ CLASS 2 — ANSWERED, THEN WRITTEN OFF `abandoned` ══════════════════════════
  // The write-off crew (unservable-ask reaper, conversation quarantine, the boot swarm guard)
  // is UNTOUCHED and stays untouched: it closes UNANSWERED asks for named structural reasons.
  // What is corrected is the subset it mislabelled — rows the ledger can prove were answered
  // before they were written off. Two recorded moves, never one silent overwrite: the row is
  // re-opened by the ENGINE pointing at the delivery it is acting on (G8's reopen-requires-
  // authority gate), and the authority then closes it against that same evidence.
  const abandoned = db.prepare(
    `SELECT id, agent_id FROM work WHERE kind = 'ask' AND state = 'abandoned' ORDER BY opened_at`,
  ).all() as Array<{ id: string; agent_id: string }>;
  for (const row of abandoned) {
    const turn = claimingTurn(row.id);
    const ev = askAnswerEvidence(row.id, turn);
    if (!ev) continue;
    r.answeredThenAbandoned.candidates++;
    if (dry) { r.answeredThenAbandoned.corrected++; continue; }
    const undo = transition(row.id, {
      to: 'open', by: 'engine', actorId: REMEDIATION_ACTOR, expectedState: 'abandoned',
      evidenceRef: ev.id,
      reason: 'remediation (SWEEP-A TB3): this ask was ANSWERED and then written off — the '
        + 'delivery that answered it is on the ledger, so the write-off label was wrong',
    });
    if (undo.kind !== 'applied') { r.answeredThenAbandoned.refused++; continue; }
    const v = settleAsk(row.id, {
      agentId: row.agent_id, turnNumber: turn, at: 'finalize', actorId: REMEDIATION_ACTOR,
    });
    if (v.verdict === 'closed') r.answeredThenAbandoned.corrected++;
    else { r.answeredThenAbandoned.refused++; if (v.verdict === 'reopened') r.reopenedIds.push(row.id); }
  }

  // ══ CLASS 3 — `compile_pending` ORPHANS ═══════════════════════════════════════
  // `done`, every child settled, and the compile flag never cleared: the flag's only writer of
  // record was an answered-edge gate that read TRUE the instant the delegating turn stamped
  // its answer, so the resolution was never recorded and `compile_resolved` had been written
  // ZERO times against seventy-odd flag rows.
  //
  // ⚠ THE BACKLOG IS CLEARED, NOT STORMED, AND THE JOIN ARM IS DELIBERATELY NOT INVOKED HERE.
  // The authority's join arm picks the LATEST qualifying delivery in the conversation after
  // `join_complete` — correct at compile time, when the relay has just delivered. Measured on
  // the dev body at TB3 Step 1, the newest such delivery for these rows is up to 643,988
  // SECONDS (7.5 days) after their `join_complete`, because the conversation carried on.
  // Re-opening seventy closed asks to re-point them at whatever was said in that conversation
  // a week later would be the forgery this spine exists to refuse, and driving seventy ancient
  // compiles would be the storm the swarm guard exists to prevent. So the row KEEPS its state
  // and its receipt, and only the stale flag is cleared — through `clearJoinCompilePending`,
  // the product's own function, which records `compile_resolved` with the reason.
  const orphans = db.prepare(
    `SELECT id FROM work
      WHERE kind = 'ask' AND state = 'done' AND compile_pending = 1 AND remaining_children = 0
      ORDER BY opened_at`,
  ).all() as Array<{ id: string }>;
  r.compilePendingOrphans.candidates = orphans.length;
  for (const row of orphans) {
    if (dry) { r.compilePendingOrphans.cleared++; continue; }
    if (clearJoinCompilePending(
      row.id,
      'remediation (SWEEP-A TB3): the delegated pieces all settled and the row is closed, but '
      + 'the compile-pending flag was never cleared — the gate that should have cleared it read '
      + "the delegating turn's own answer stamp. The flag is stale, not the work.",
    ) === 1) r.compilePendingOrphans.cleared++;
  }

  // ══ CLASS 4/5 — A RECEIPT THAT IS A TOOL-CALL CHIP ════════════════════════════
  // `messages.display_kind = 'tool-turn'` is the model's own `tool_use` block rendered as a
  // chip. It is not an answer to anybody, and TB2 made that a narrowing of the evidence going
  // forward. These are the rows closed on one before that landed.
  const chips = NON_ANSWERING_DISPLAY_KINDS.map((k) => `'${k}'`).join(', ');
  const chipRows = db.prepare(
    `SELECT w.id AS id, w.agent_id AS agent_id, w.conversation_id AS conversation_id,
            d.id AS chip_id, d.turn_number AS turn_number, d.created_at AS chip_at
       FROM work w
       -- The outcome filter is redundant on this join (G7 and the DDL's own CHECK mean a
       -- done row's receipt can only ever have come from a delivered row) and it is written
       -- anyway: owner-close-receipt.test.ts's enumeration guard requires EVERY production
       -- reader of this table to carry it, because a reader that is safe by ARGUMENT rather
       -- than by PREDICATE is the shape that guard exists to refuse.
       JOIN deliveries d ON d.id = w.result_delivery_id AND d.outcome = 'delivered'
       JOIN messages m ON m.id = d.message_id
      WHERE w.kind = 'ask' AND w.state = 'done' AND m.display_kind IN (${chips})
      ORDER BY w.opened_at`,
  ).all() as Array<{
    id: string; agent_id: string; conversation_id: string | null;
    chip_id: string; turn_number: number | null; chip_at: string;
  }>;
  r.chipReceipts.candidates = chipRows.length;
  for (const row of chipRows) {
    const ev = askAnswerEvidence(row.id, row.turn_number);
    if (ev) {
      // The serving turn DID answer — in prose, after the chip. The receipt moves to the
      // delivery that carried the answer. State is untouched: the ask really is done.
      r.chipReceipts.repointed++;
      if (dry) continue;
      db.prepare('UPDATE work SET result_delivery_id = ?, updated_at = ? WHERE id = ?')
        .run(ev.id, Date.now(), row.id);
      appendWorkEvent(row.id, 'audit', REMEDIATION_ACTOR, {
        marker: 'tb3_receipt_repointed',
        from_delivery_id: row.chip_id, to_delivery_id: ev.id, tool: ev.tool,
        turn_number: row.turn_number,
        reason: 'remediation (SWEEP-A TB3): this ask was closed pointing at a tool-call chip. '
          + 'The same turn delivered a real answer; the receipt now points at that instead. '
          + 'A chip is not an answer to anybody.',
      });
      continue;
    }
    if (anyLaterRealDelivery(row.agent_id, row.conversation_id, row.chip_at)) {
      // AMBIGUOUS — an answer went out, but not on the turn that closed this ask. Counted and
      // handed up rather than acted on: the authority will not endorse it, and re-serving a
      // question the person may have had answered is a decision above this pass's pay grade.
      r.chipReceipts.handedUp++;
      continue;
    }
    // Nothing was ever delivered for this ask but a chip. It is not answered, so it is not
    // done — priority one, and it goes back visible.
    r.chipReceipts.reopened++;
    if (dry) continue;
    const undo = transition(row.id, {
      to: 'open', by: 'engine', actorId: REMEDIATION_ACTOR, expectedState: 'done',
      evidenceRef: row.chip_id,
      reason: 'remediation (SWEEP-A TB3): this ask was closed on a tool-call CHIP and no real '
        + 'answer ever followed in its conversation — the person was never actually answered, '
        + 'so the ask is owed again rather than left looking finished',
    });
    if (undo.kind === 'applied') r.reopenedIds.push(row.id);
    else r.chipReceipts.reopened--;
  }

  if (!dry) {
    logger.warn('ask-ledger remediation pass complete (SWEEP-A TB3)', {
      stuckClaimed: r.stuckClaimed, answeredThenAbandoned: r.answeredThenAbandoned,
      compilePendingOrphans: r.compilePendingOrphans, chipReceipts: r.chipReceipts,
      reopened: r.reopenedIds.length,
    });
  }
  return r;
}

/**
 * THE ONE-SHOT DOOR — armed by migration `158`, disarmed by its own completion.
 *
 * Returns `null` when the pass is not armed, so a boot on a box that has already crossed this
 * build does nothing at all and says nothing. The armed row is the migration's; the completion
 * row is written here with the counts, so "did this box get the correction, and what did it
 * find?" is answerable from the database months later.
 */
export function runArmedAskRemediation(): AskRemediationReport | null {
  const db = getDb();
  const armed = db.prepare('SELECT value FROM config WHERE key = ?').get(REMEDIATION_ARMED_KEY) as
    { value: string } | undefined;
  if (!armed || armed.value !== 'armed') return null;
  const report = remediateAskLedger();
  db.prepare(
    `UPDATE config SET value = ?, updated_at = datetime('now') WHERE key = ?`,
  ).run(JSON.stringify({ ranAt: new Date().toISOString(), ...report }), REMEDIATION_ARMED_KEY);
  return report;
}
