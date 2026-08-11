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
import { queueSelfWake } from '../../../shared-state.js';
import type { FinalizeContext } from './index.js';

const logger = createLogger('v2-loop');

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
  if (isA2ATurn) {
    try {
      const justCompleted = db.prepare(`
        SELECT w.id AS id, w.title AS title, w.result AS result FROM work w
        WHERE ${taskScope('w')} AND w.agent_id = ?
          AND w.state = 'done'
          AND w.closed_at >= ?
          AND w.repeat_interval IS NULL
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
