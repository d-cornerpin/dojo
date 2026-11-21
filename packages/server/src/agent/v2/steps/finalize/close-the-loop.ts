// Completion report: a one-shot task the owner asked for that finished on an A2A turn (the reply went
// to the other agent) gets one bounded, engine-triggered follow-up turn to the owner.

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../../../logger.js';
import { insertEngineEventIfAbsent } from '../../../../memory/message-store.js';
import { taskScope, tsToMs } from '../../../../work/tracker-view.js';
import { peerOriginSql } from '../../../../work/peer-origin.js';
import { handedInSinceExpr, handInNoteExpr, handInDeliveriesExpr } from '../../../../work/done/record.js';
// The declared non-answering delivery sets, owned by `work/ask-settlement.ts`: imported, never retyped.
import { NON_ANSWERING_DELIVERY_TOOLS, NON_ANSWERING_DISPLAY_KINDS } from '../../../../work/ask-settlement.js';
import { queueSelfWake } from '../../../shared-state.js';
import type { FinalizeContext } from './index.js';

const logger = createLogger('v2-loop');

// Truth guard: a close whose hand-in delivery the owner can already have read is not reported, so the
// event's "they have not seen the result yet" is true by construction. Owner-evidenced (the narrowing of
// `answered-edge.ts:turnDeliveredToPerson`): delivered, not on the a2a peer lane or `none`, not a
// non-answering tool, and not a chip bubble (counting chips would suppress reports really owed).
const NOT_OWNER_FACING_CHANNELS = ["'a2a'", "'none'"];

/** SQL: TRUE when a delivery this work row was handed in on is one the OWNER can already have read. */
const ownerEvidencedClose = (a: string): string => {
  const tools = [...NON_ANSWERING_DELIVERY_TOOLS].map((t) => `'${t}'`).join(', ');
  const chips = NON_ANSWERING_DISPLAY_KINDS.map((k) => `'${k}'`).join(', ');
  return `EXISTS (SELECT 1 FROM deliveries d
                   WHERE d.id IN ${handInDeliveriesExpr(a)}
                     AND d.outcome = 'delivered'
                     AND d.channel NOT IN (${NOT_OWNER_FACING_CHANNELS.join(', ')})
                     AND d.tool NOT IN (${tools})
                     AND NOT EXISTS (SELECT 1 FROM messages m
                                      WHERE m.id = d.message_id AND m.display_kind IN (${chips})))`;
};

/** Schedules the owner-facing completion report. Never touches the turn state. */
export async function scheduleCompletionReport(ctx: FinalizeContext): Promise<void> {
  const { agentId, turnNumber, db, isA2ATurn, turnStartedAt } = ctx;

  // A2A only (a user turn already reports); the engine-triggered report turn cannot re-trigger; work
  // handed in since turn start, so reported once; one-shot only; never what another agent asked of it; unreported.
  if (isA2ATurn) {
    try {
      const justCompleted = db.prepare(`
        SELECT w.id AS id, w.title AS title, ${handInNoteExpr('w')} AS result FROM work w
        WHERE ${taskScope('w')} AND w.agent_id = ?
          AND ${handedInSinceExpr('w')}
          AND w.repeat_interval IS NULL AND NOT (${peerOriginSql('w')} AND w.requester_id IS NOT ?)
          AND NOT ${ownerEvidencedClose('w')}
        ORDER BY w.updated_at ASC
        LIMIT 5
      `).all(agentId, tsToMs(turnStartedAt) ?? 0, agentId) as Array<{ id: string; title: string; result: string | null }>;
      if (justCompleted.length > 0) {
        const taskLines = justCompleted
          .map(t => `  - "${t.title}"${t.result ? `, ${t.result.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`)
          .join('\n');
        const reportMsg = (
          `[Engine event: completion report owed] You just finished work the owner asked for while you were talking to another agent, so they have not seen the result yet:\n` +
          `${taskLines}\n\n` +
          `Write the owner ONE short completion note as your reply (the engine delivers it to the owner): that the task(s) named ABOVE are done, plus a one-line note of what you did. Hard limits:\n` +
          `- Mention ONLY the task(s) listed above. Do NOT list, summarize, or mention ANY other tasks, blockers, projects, or your overall status, this is a completion note, not a status report or a "what needs you" rundown.\n` +
          `- One or two sentences. Do NOT redo the work or re-run tools.\n` +
          `If there is genuinely nothing worth telling them, reply with [no-reply].`
        );
        const reportId = uuidv4();
        // An engine event (never shown to a human), picked up by the report turn the self-wake starts.
        insertEngineEventIfAbsent({
          work: null,
          id: reportId,
          agentId,
          content: reportMsg,
          sourceAgentId: null,
          originIntent: 'completion_report',
          turnNumber,
        });
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
