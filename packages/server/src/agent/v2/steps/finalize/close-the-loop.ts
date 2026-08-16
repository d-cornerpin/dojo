// ════════════════════════════════════════
// PHASE-6 T9 (CUT 4) — THE CLOSE-THE-LOOP COMPLETION REPORT
//
// Relocated verbatim from `agent/v2/loop.ts` (`:8664`–`:8729` at `0942fd9`). Bounds,
// wording, the engine prompt's exact text and its hard limits unchanged.
//
// The ack-and-ghost fix: work the owner asked for finished on an A2A turn, where the
// agent's text was suppressed because it was answering another agent — so the owner
// never heard "done". One bounded, engine-triggered follow-up turn is scheduled, and
// the four guarantees the block states about itself (A2A turns only, the scheduled
// turn cannot re-trigger, scoped to THIS turn's window, one-shot work only) are
// properties of the code below, not of this comment.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../../../logger.js';
import { insertEngineEventIfAbsent } from '../../../../memory/message-store.js';
import { taskScope, tsToMs } from '../../../../work/tracker-view.js';
// UX-REPAIR ROUND 11 T42: the DECLARED sets for "this delivery is not an answer to anybody".
// One owner (`work/ask-settlement.ts`), four readers now — `answered-edge.ts`,
// `work/occurrences.ts`, `work/ask-remediation.ts` and the guard below. IMPORTED, never
// retyped, so a fifth non-answering bubble kind reaches every reader at once.
import { NON_ANSWERING_DELIVERY_TOOLS, NON_ANSWERING_DISPLAY_KINDS } from '../../../../work/ask-settlement.js';
import { queueSelfWake } from '../../../shared-state.js';
import type { FinalizeContext } from './index.js';

const logger = createLogger('v2-loop');

// ════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 11 T42 — THE TRUTH GUARD: "has the owner already been shown this?"
// ════════════════════════════════════════════════════════════════════════════════
//
// THE INCIDENT (round-11 S5-C, read off the ledger). Compile task `34519aca` closed `done`
// at 01:28:33. Its own receipt — `result_delivery_id` = `1f03db51`, `channel='dashboard'`,
// `recipient_id='owner'`, `outcome='delivered'` — reached the owner at 01:25:51, and the
// compiled answer at 01:26:09. The selector below asked only "did a one-shot close in this
// turn's window" and never consulted deliveries, so the event fired and its FIRST SENTENCE
// — "they have not seen the result yet" — was false at the instant it was written. The turn
// it scheduled posted a third owner bubble re-announcing a 3.2-minute-old answer.
//
// THE SHAPE IS T12's, NOT A NEW MECHANISM. This is the round-2 escalation reality-check
// pattern: a truth guard bolted to a mechanism that stays where it is, with the same trigger,
// the same text and the same bounds. The ack-and-ghost fix is untouched — a one-shot that
// closed on an A2A turn with nothing owner-facing behind it still rides the event byte for
// byte. What the guard removes is the case where the event's own premise sentence is a lie,
// so the sentence is now true BY CONSTRUCTION rather than by hope. The skip is non-burning:
// no counter is spent and nothing is stamped, exactly as T12's skip behaves.
//
// "OWNER-EVIDENCED" IS THE NARROWING THIS TREE ALREADY USES, not a new definition. It is
// `answered-edge.ts:turnDeliveredToPerson`'s clause list, minus the turn scoping (the receipt
// is already keyed to the work) and minus the conversation scoping (measured: `work.
// conversation_id` is NULL on every task row on the dev body, so scoping by it would exclude
// nothing and claim a precision that does not exist):
//   * `outcome='delivered'`     — a suppressed/held/failed row reached nobody. Every reader of
//                                 this table filters this, by the ledger's own instruction.
//   * `channel NOT IN ('a2a','none')` — `a2a` is the PEER lane: a hand-back to another agent is
//                                 not the owner hearing anything, and that is the exact case
//                                 the ack-and-ghost fix exists for. `none` crossed no door.
//   * `tool NOT IN (engine-ack)` — a start-ack is not the result.
//   * not a chip bubble         — MEASURED, and load-bearing: on the dev body 125 `done`
//                                 one-shot rows point `result_delivery_id` at a `tool-turn`
//                                 row. Counting those as "the owner has seen it" would
//                                 suppress reports that really are owed, which is the
//                                 opposite defect. Same finding as T19 (D2).
//
// UNTOUCHED, deliberately: the four guarantees in the block header, the `[no-reply]` escape,
// the recurring-run silence, the 5-row bound and the event text itself.
// Proof, both directions: `__tests__/the-completion-report-does-not-re-announce.test.ts`.
const NOT_OWNER_FACING_CHANNELS = ["'a2a'", "'none'"];

/** SQL: TRUE when this work row's receipt is a delivery the OWNER can already have read. */
const ownerEvidencedClose = (a: string): string => {
  const tools = [...NON_ANSWERING_DELIVERY_TOOLS].map((t) => `'${t}'`).join(', ');
  const chips = NON_ANSWERING_DISPLAY_KINDS.map((k) => `'${k}'`).join(', ');
  return `EXISTS (SELECT 1 FROM deliveries d
                   WHERE d.id = ${a}.result_delivery_id
                     AND d.outcome = 'delivered'
                     AND d.channel NOT IN (${NOT_OWNER_FACING_CHANNELS.join(', ')})
                     AND d.tool NOT IN (${tools})
                     AND NOT EXISTS (SELECT 1 FROM messages m
                                      WHERE m.id = d.message_id AND m.display_kind IN (${chips})))`;
};

/** Schedules the owner-facing completion report. Never touches the turn state. */
export async function scheduleCompletionReport(ctx: FinalizeContext): Promise<void> {
  const { agentId, turnNumber, db, isA2ATurn, turnStartedAt } = ctx;

  // ── Close-the-loop completion report (attribution redesign §4.5.3, Phase 3) ──
  // The ack-and-ghost fix. When a one-shot task the owner asked for finishes on
  // an A2A turn, the agent's text was suppressed (it was answering another agent
  // / the PM), so the owner never heard "done." Schedule ONE bounded, user-facing
  // follow-up turn so the agent reports what it did. Guarantees:
  //   • Fires ONLY on A2A turns. A normal user turn already wraps up to the user,
  //     so it never double-reports (§9).
  //   • The scheduled turn is engine-triggered (not A2A), so isA2ATurn is false on
  //     it → its reply is NOT suppressed and reaches the owner, and it cannot
  //     re-trigger another completion report (no infinite loop).
  //   • Scoped to completions in THIS turn's window (completed_at >= turnStartedAt),
  //     so each completion is reported at most once across turns.
  //   • One-shot only (repeat_interval IS NULL): recurring/scheduler runs stay
  //     silent per the silent-closeout rule.
  //   • Bounded: the engine prompt says summarize, do not redo.
  //   • T42: UNREPORTED only — a close whose own receipt is an owner-facing delivery is
  //     excluded, so the event's "they have not seen the result yet" is true by
  //     construction. See `ownerEvidencedClose` above for the incident and the clause list.
  if (isA2ATurn) {
    try {
      const justCompleted = db.prepare(`
        SELECT w.id AS id, w.title AS title, w.result AS result FROM work w
        WHERE ${taskScope('w')} AND w.agent_id = ?
          AND w.state = 'done'
          AND w.closed_at >= ?
          AND w.repeat_interval IS NULL
          AND NOT ${ownerEvidencedClose('w')}
        ORDER BY w.closed_at ASC
        LIMIT 5
      `).all(agentId, tsToMs(turnStartedAt) ?? 0) as Array<{ id: string; title: string; result: string | null }>;
      if (justCompleted.length > 0) {
        const taskLines = justCompleted
          .map(t => `  - "${t.title}"${t.result ? `, ${t.result.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`)
          .join('\n');
        const reportMsg = (
          `[Engine event: completion report owed] You just finished work the owner asked for while you were talking to another agent, so they have not seen the result yet:\n` +
          `${taskLines}\n\n` +
          `Send the owner ONE short completion note: that the task(s) named ABOVE are done, plus a one-line note of what you did. Hard limits:\n` +
          `- Mention ONLY the task(s) listed above. Do NOT list, summarize, or mention ANY other tasks, blockers, projects, or your overall status, this is a completion note, not a status report or a "what needs you" rundown.\n` +
          `- One or two sentences, on the owner's channel. Do NOT redo the work or re-run tools.\n` +
          `If there is genuinely nothing worth telling them, reply with [no-reply].`
        );
        const reportId = uuidv4();
        // D-A step 6 closeout: the LAST engine writer moved off `messages` into
        // the inter-agent store (the other five moved in step 4). conv_key NULL
        // keeps it a PENDING engine event: the merged getPendingEngineEvent finds
        // it in the store and the claim branches on its home table, exactly like
        // the scheduler/tracker/healer events. The universal NO_INTERAGENT_LEAK
        // battery invariant now holds absolutely (no by-design exceptions).
        insertEngineEventIfAbsent({
          work: null,
          id: reportId,
          agentId,
          content: reportMsg,
          sourceAgentId: null,
          originIntent: 'completion_report',
          turnNumber,
        });
        // Queue wakeup so handleMessage's finally fires the report turn.
        queueSelfWake(agentId, 'completion-report');
        logger.info('v2 close-the-loop: scheduled completion report after A2A turn', {
          agentId, taskCount: justCompleted.length, taskIds: justCompleted.map(t => t.id.slice(0, 8)),
        }, agentId);
      }
    } catch (err) {
      logger.warn('v2 close-the-loop completion-report scheduling failed (non-fatal)', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  }
}
