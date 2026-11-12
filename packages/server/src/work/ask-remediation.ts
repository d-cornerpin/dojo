// Remediation pass: corrects old ask-ledger rows. It owns no rule: `settleAsk` decides and
// `askAnswerEvidence` reads evidence. Ambiguous evidence errs toward serving the ask again.
// Every correction is a recorded move with its reason; nothing is deleted or back-dated.
// Run after the boot staleness sweep (work-reaper.ts) and before the re-drain that serves its rows.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { askAnswerEvidence, settleAsk, NON_ANSWERING_DISPLAY_KINDS, realAnswerInConversationSince } from './ask-settlement.js';
import { appendWorkEvent, claimingTurnOf, clearJoinCompilePending, transition } from './store.js';

const logger = createLogger('ask-remediation');

/** The actor recorded on every row this pass moves, so the corrections are findable as a set. */
export const REMEDIATION_ACTOR = 'ask-remediation-tb3';

/** The `config` key that arms the pass; overwritten with the report only after it ran, so a crash
 *  mid-pass re-runs it: every branch must stay idempotent by its own predicate. */
export const REMEDIATION_ARMED_KEY = 'ask_ledger_remediation_158';

export interface AskRemediationReport {
  stuckClaimed: { candidates: number; closed: number; held: number; reopened: number; unchanged: number };
  answeredThenAbandoned: { candidates: number; corrected: number; refused: number };
  compilePendingOrphans: { candidates: number; cleared: number };
  chipReceipts: { candidates: number; repointed: number; reopened: number; handedUp: number };
  /** Rows handed back `open`; the caller must drive them to settlement in the same boot. */
  reopenedIds: string[];
}

const emptyReport = (): AskRemediationReport => ({
  stuckClaimed: { candidates: 0, closed: 0, held: 0, reopened: 0, unchanged: 0 },
  answeredThenAbandoned: { candidates: 0, corrected: 0, refused: 0 },
  compilePendingOrphans: { candidates: 0, cleared: 0 },
  chipReceipts: { candidates: 0, repointed: 0, reopened: 0, handedUp: 0 },
  reopenedIds: [],
});

/** The turn that picked the ask up, read from the row's claim event: a terminal move clears
 *  `work.claimed_by_turn`, so the column cannot be used for a closed or written-off row. */
const claimingTurn = claimingTurnOf;

/**
 * Triage read, not a settlement rule: did a real answer go out after a tool-call chip receipt?
 *   * on the serving turn  -> the authority endorses it; re-point the receipt;
 *   * none at all          -> nothing was delivered; hand the ask back;
 *   * on a different turn  -> not endorsed for this ask and a re-open could re-serve it; left alone.
 */
function anyLaterRealDelivery(
  agentId: string, conversationId: string | null, notBefore: string,
): boolean {
  // The authority's own conversation-scoped read, never a private copy.
  return realAnswerInConversationSince(agentId, conversationId, notBefore) !== null;
}

/** Runs the pass; `dryRun` counts every branch without writing. */
export function remediateAskLedger(opts: { dryRun?: boolean } = {}): AskRemediationReport {
  const dry = opts.dryRun === true;
  const db = getDb();
  const r = emptyReport();

  // Class 1: asks still `claimed` whose claiming turn finalized or has no turn row; in-flight turns excluded.
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

  // Class 2: asks answered then written off `abandoned`. Two recorded moves: the engine re-opens
  // the row pointing at the answering delivery, then the authority closes it against it.
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

  // Class 3: `done` asks, all children settled, compile flag never cleared. Only the flag is
  // cleared; the join arm would re-point old rows at a much later delivery.
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

  // Classes 4/5: `done` asks whose receipt is a tool-call chip, which answers nobody.
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
      // The serving turn answered after the chip: move the receipt; the ask stays done.
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
      // Ambiguous: an answer went out on another turn; counted and handed up, not acted on.
      r.chipReceipts.handedUp++;
      continue;
    }
    // Nothing but a chip was ever delivered, so the ask is not answered: it goes back visible.
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

/** One-shot entry: `null` unless armed; a run leaves its counts in the `config` row for later reading. */
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
