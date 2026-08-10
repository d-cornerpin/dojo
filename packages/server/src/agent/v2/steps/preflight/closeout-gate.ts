// ════════════════════════════════════════
// PHASE-6 T2 (CUT 9) — `preflight` §7: THE PRE-TURN CLOSE-OUT GATE.
//
// Tracker hygiene as a hard precondition: in_progress work the agent has not touched
// in ten minutes, and on_deck steps stranded on a project it created and walked away
// from. The gate ARMS enforcement (the engine refuses non-tracker tool calls until a
// tracker call lands) and, unless an identical gate row landed in the last five
// minutes, posts the guidance row that says so.
//
// ⚠ BUG-2 IS IN THIS FILE AND IT IS A LANE SEPARATION, NOT A THRESHOLD. The gate is
// NEVER armed on a turn a human is waiting on. Armed on a conversation turn it
// "(a) DELETED the agent's just-streamed reply and (b) REFUSED the tool calls the
// agent needed to answer" — inv 2 and inv 6 on the weak-model floor. It had NO test
// anywhere in either repo until this tranche wrote one (`integration.test.ts`, four
// clauses, driving the ENFORCEMENT rather than the arming flag).
//
// The section OUTPUTS NOTHING. It only advances the state, which is why it is one of
// the two cheapest files in the package.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';
import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { taskScope, stampColumns } from '../../../../work/tracker-view.js';
import { advance } from '../../state.js';
import type { WaitingConversation } from '../../counterparty.js';
import type { TurnContext } from '../../../turn-context.js';
import type { PreflightContext } from './index.js';

const logger = createLogger('v2-loop');

/** What the sections before this one produced that it reads. */
export interface CloseoutGateInputs {
  readonly db: Database;
  readonly triggerRow: WaitingConversation['latest'];
}

export async function runCloseoutGate(
  turnCtx: TurnContext,
  ctx: PreflightContext,
  input: CloseoutGateInputs,
): Promise<void> {
  const { agentId } = ctx;
  const { db, triggerRow } = input;
  // ── v2.5.46: pre-turn close-out gate detection ──
  // Look up in_progress tasks the agent appears to have abandoned. Pre-
  // v2.7.17 this used `updated_at < turnStartedAt` (any task not touched
  // THIS turn), which made the gate fire every time the user interrupted
  // mid-conversation - even though the agent was actively working the task
  // a minute ago. Now uses a wall-clock threshold so genuinely abandoned
  // tasks are still caught but active mid-conversation work isn't.
  //
  // Per user spec ("if we default to agents creating tasks, they MUST
  // also close them out"): tracker hygiene is still a hard precondition,
  // just with a sane idle window before it kicks in.
  try {
    // (1) Tasks the agent is in_progress on but hasn't touched in the
    // last CLOSE_OUT_IDLE_MINUTES. Any tracker tool call (status update,
    // notes add/edit, complete_step) bumps updated_at, so an actively-
    // worked task naturally stays inside the window.
    const CLOSE_OUT_IDLE_MINUTES = 10;
    const inProgressDanglers = db.prepare(`
      SELECT w.id AS id, w.title AS title, 'in_progress' AS kind FROM work w
      WHERE ${taskScope('w')} AND w.agent_id = ?
        AND w.state = 'claimed'
        AND w.is_paused = 0
        AND w.updated_at < ?
      ORDER BY w.updated_at ASC
      LIMIT 10
    `).all(agentId, Date.now() - CLOSE_OUT_IDLE_MINUTES * 60_000) as Array<{ id: string; title: string; kind: string }>;

    // (2) Stranded on_deck tasks. Catches the Presenton-shaped failure:
    // agent created a project, did some of it, then abandoned it (often
    // because compaction made them forget the project existed and they
    // spun up a duplicate). The orphans sit in on_deck forever because
    // the existing in_progress-only gate never sees them and the PM's
    // STALE check only chats, doesn't auto-resolve.
    //
    // Criteria: on_deck task assigned to this agent, in a project this
    // agent created, the project has zero in_progress tasks, and the
    // task hasn't been touched in 30+ minutes. The 30-minute floor
    // prevents this from firing inside the same conversation as the
    // creation, only catches genuinely abandoned work between sessions.
    const strandedRows = db.prepare(`
      SELECT t.id AS id, t.title AS title, 'stranded' AS kind FROM work t
      INNER JOIN work p ON p.id = t.parent_id
      WHERE ${taskScope('t')} AND t.agent_id = ?
        AND t.state = 'on_deck'
        AND t.is_paused = 0
        AND (t.scheduled_start IS NULL OR t.scheduled_start <= ?)
        AND t.schedule_status != 'waiting'
        AND p.requester_id = ?
        AND p.state = 'open'
        AND t.updated_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM work sib
          WHERE sib.parent_id = p.id AND sib.kind = 'task' AND sib.state = 'claimed'
        )
      ORDER BY t.updated_at ASC
      LIMIT 10
    `).all(agentId, Date.now(), agentId, Date.now() - 30 * 60_000) as Array<{ id: string; title: string; kind: string }>;

    // BUG-2 (comms-audit convergence pass): NEVER arm the close-out gate on a turn a
    // human is waiting on (`triggerRow` set ⇒ this turn serves a waiting human, by the
    // user-always-wins rule). Task-closeout is Lane 2/3 machinery; per the lane-separation
    // law (see the nudge guard at "counterparty.kind !== 'user'" later in this file) it has
    // no business running in the middle of a Lane-1 conversation about something unrelated, 
    // the danglers are almost always pre-existing background leftovers, not this turn's work.
    // When armed on a conversation turn the gate (a) DELETED the agent's just-streamed reply
    // and (b) REFUSED the tool calls the agent needed to answer, both silent-drop / blocked-
    // turn failures (inv 2, inv 6) on the weak-model floor, where the model routinely answers
    // a fresh ask in plain text without first touching the tracker. Abandoned danglers are
    // still enforced off the conversation path: by this same gate on the next non-conversation
    // turn, and by the PM poke chain (where closeout enforcement belongs).
    const danglingRows = triggerRow ? [] : [...inProgressDanglers, ...strandedRows];
    if (danglingRows.length > 0) {
      turnCtx.state = advance(turnCtx.state!, {
        danglingTaskIds: danglingRows.map((r) => r.id),
        nudgedForCloseOutThisTurn: true,
      });
      const inProgressList = inProgressDanglers
        .map((r) => `  - "${r.title}" (${r.id.slice(0, 8)})`)
        .join('\n');
      const strandedList = strandedRows
        .map((r) => `  - "${r.title}" (${r.id.slice(0, 8)})`)
        .join('\n');

      const sections: string[] = [];
      if (inProgressDanglers.length > 0) {
        sections.push(
          `${inProgressDanglers.length} in_progress task${inProgressDanglers.length === 1 ? '' : 's'} from a previous turn you never closed:\n${inProgressList}`
        );
      }
      // 2026-07-22 production incident: the neutral menu let the floor model
      // pause a DELIVERED task (a new zombie) and redo finished work. When the
      // engine's own records show the work was answered/delivered, the gate
      // says so and names the right disposition instead of offering a menu.
      try {
        const { findDeliveryEvidenceForTask, renderDeliveryEvidence } = await import('../../../../tracker/delivery-evidence.js');
        const { renderTaskStamps, isTangibleDeliverySummary } = await import('../../../../tracker/task-stamps.js');
        const evidenced: string[] = [];
        for (const r of inProgressDanglers) {
          // Stamps first (mig 124), live join as backfill for pre-stamp rows.
          const st = db.prepare(
            `SELECT w.id AS id, ${stampColumns('w')} FROM work w WHERE w.id = ?`,
          ).get(r.id) as import('../../../../tracker/task-stamps.js').TaskStampFields | undefined;
          // Tangibility rule (battery catch 2026-07-22): only a recorded
          // HANDOVER (file or channel delivery) earns the close-this text; a
          // bare answered reply is often an ack on a task legitimately
          // waiting (delegation synthesis), and pushing CLOSE on it forged a
          // wrong close. Same standard as the strike-2 engine close.
          // T19 (D7): asked of the ONE helper, so a dashboard bubble named in the summary
          // cannot quietly become a handover here.
          if (st && st.last_answered_turn !== null && isTangibleDeliverySummary(st.last_delivery_summary)) {
            evidenced.push(`  - "${r.title}" (${r.id.slice(0, 8)}): ${renderTaskStamps(st)}`);
            continue;
          }
          const ev = findDeliveryEvidenceForTask(r.id);
          if (ev && (ev.artifacts.length > 0 || ev.deliveredVia.length > 0)) {
            evidenced.push(`  - "${r.title}" (${r.id.slice(0, 8)}): ${renderDeliveryEvidence(ev)}`);
          }
        }
        if (evidenced.length > 0) {
          sections.push(
            `ENGINE RECORDS show these were already ANSWERED/DELIVERED on their own conversations:\n${evidenced.join('\n')}\n` +
            `For each of these, the correct call is work_update(action="status", status="complete") with the result (or work_update(action="complete_step")). ` +
            `Do NOT pause them, do NOT add a "still working" note, and do NOT redo or re-deliver the work.`
          );
        }
      } catch { /* evidence consult is best-effort; the gate still fires */ }
      if (strandedRows.length > 0) {
        sections.push(
          `${strandedRows.length} stranded on_deck task${strandedRows.length === 1 ? '' : 's'} (queued steps on a project you created but stopped working on more than 30 minutes ago, with no in_progress sibling):\n${strandedList}`
        );
      }

      const gateMsg = (
        `[System: REQUIRED close-out, you have abandoned work on the tracker.\n\n` +
        `${sections.join('\n\n')}\n\n` +
        `**This turn must start with a tracker tool call, not a user-facing reply.** ` +
        `Resolve at least one item before doing anything else - call work_update(action="complete_step") (multi-step projects), ` +
        `work_update(action="status") (status="complete" | "blocked" | "paused" with resume_at), ` +
        `work_note (if you are STILL actively working it - then KEEP GOING on this same turn, do not stop after writing the note), ` +
        `or - if the whole project was abandoned/duplicated/superseded - work_update(action="close_project", project_id, status="cancelled", reason="..."). ` +
        `The engine will REFUSE every non-tracker tool call until one of those lands; after that the gate releases for the rest of the turn so you can keep resolving the others alongside other work. ` +
        `Do NOT generate a user-facing response on this turn until the gate is satisfied - the user does not expect a reply yet; they expect the tracker to come back in sync. ` +
        `Results already delivered to the user must NOT be repeated; after your tracker call, reply [no-reply] unless the user asked something new.]`
      );
      // F2.4: dedupe the gate message per wakeup batch. Queued wakeups re-arm this
      // gate on every attempt (three duplicate inserts were observed in 20s). The
      // enforcement state is already armed above (danglingTaskIds), so if the
      // dashboard already carries a close-out gate message from the last 5 minutes,
      // skip the redundant INSERT + broadcast while STILL arming enforcement.
      const recentGateMsg = db.prepare(`
        SELECT 1 FROM messages
        WHERE agent_id = ? AND role = 'system'
          AND content LIKE '[System: REQUIRED close-out%'
          AND created_at >= (unixepoch('now', '-5 minutes') * 1000)
        LIMIT 1
      `).get(agentId);
      const gateMsgId = uuidv4();
      if (!recentGateMsg) {
        try {
          // engine-steer-exempt (RC-19): the pre-turn close-out gate is ENFORCED at
          // the tool-execution layer (the engine REFUSES non-tracker tool calls until
          // a tracker call lands), so its behavior does not depend on the model seeing
          // this row. It also runs in the pre-turn setup, outside the loop's per-turn
          // steer-queue scope. Guidance-only text; not dashboard-only theater.
          insertMessageIfAbsent({ id: gateMsgId, agentId, role: 'system', content: gateMsg });
          broadcast({
            type: 'chat:message',
            agentId,
            message: {
              id: gateMsgId, agentId, role: 'system' as const,
              content: gateMsg,
              tokenCount: null, modelId: null, cost: null, latencyMs: null,
              createdAt: new Date().toISOString(),
            },
          });
        } catch (msgErr) {
          logger.warn('v2: close-out gate system message insert failed', {
            agentId, error: msgErr instanceof Error ? msgErr.message : String(msgErr),
          }, agentId);
        }
      }
      logger.info('v2: pre-turn close-out gate armed', {
        agentId, danglingCount: danglingRows.length,
        sample: danglingRows.slice(0, 3).map((r) => `${r.id.slice(0, 8)}:${r.title}`),
      }, agentId);
    }
  } catch (err) {
    logger.warn('v2: dangling-task lookup failed; close-out gate disarmed for this turn', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}
