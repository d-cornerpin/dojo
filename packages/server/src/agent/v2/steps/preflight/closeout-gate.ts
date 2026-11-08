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
import { taskScope, handedInExpr } from '../../../../work/tracker-view.js';
import { taskMovedAtSql, jobCarriedIds } from '../../../../work/task-freshness.js';
import { readMeasureFacts, formatMeasureLine } from '../../../../work/measure-view.js';
import { advance } from '../../state.js';
import type { WaitingConversation } from '../../counterparty.js';
import type { TurnContext } from '../../../turn-context.js';
import type { PreflightContext } from './index.js';
import { userWords } from '../../turn-address.js';
import { heldExpr } from '../../../../work/done/hold.js';

/** The gate message's first words: the dedupe below finds a recent one by them. */
export const GATE_MSG_HEAD = '[System: tracker check before this turn.';
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
    // (1) Tasks the agent is in_progress on but did not touch during its last WHOLE turn. "Touched"
    // is the task's own movement (`work/task-freshness.ts`): a status, step or edit, a note naming it,
    // a turn whose trigger names it. Never another task's park (t143 r2).
    //
    // FIELD FIX 3 AUDIT ROUND (#8): this was "not touched in the last 10 minutes", a fixed clock (owner:
    // "I don't want to put hard limits on the dojo"; "we can't have the dojo panick every 15 minutes
    // because an agent isn't responding"). A slow model mid-call read as having abandoned its task. The
    // real signal is the agent's own record: it has had a whole turn since the task last moved, and the
    // task did not move in it. With no finished turn on record, nothing has been passed over.
    const lastTurn = db.prepare(
      `SELECT CAST(strftime('%s', started_at) AS INTEGER) * 1000 AS started_ms FROM turns
        WHERE agent_id = ? AND ended_at IS NOT NULL ORDER BY turn_number DESC LIMIT 1`,
    ).get(agentId) as { started_ms: number | null } | undefined;
    const passedOverBefore = lastTurn?.started_ms ?? null;
    // t143 r4 (C1): only the job in flight (the standing carry) is exempt, however busy the agent has been.
    const jobWork = jobCarriedIds(agentId);
    // v3.5 live check (preflight.4, row 5b): a close the worker has FILED waits on its verdict (the PM's,
    // or the owner's when escalated), and the filing told the worker nothing further is needed from it.
    // The ball is not the worker's, so neither arm names it: the PM ladder's own question
    // (`handedInExpr`, the one predicate), asked here too. A rejected close is open work again
    // (`claim_rejected` ends the request), so the gate sees it as before.
    const inProgressDanglers = (db.prepare(`
      SELECT w.id AS id, w.title AS title, 'in_progress' AS kind FROM work w
      WHERE ${taskScope('w')} AND w.agent_id = ?
        AND w.state = 'claimed'
        AND w.is_paused = 0 AND NOT ${heldExpr('w')}
        AND ${handedInExpr('w')} = 0
        AND ${taskMovedAtSql('w')} < ?
      ORDER BY ${taskMovedAtSql('w')} ASC
      LIMIT 10
    `).all(agentId, passedOverBefore ?? 0) as Array<{ id: string; title: string; kind: string }>)
      .filter((r) => !jobWork.includes(r.id));

    // (2) Stranded on_deck tasks. Catches the Presenton-shaped failure:
    // agent created a project, did some of it, then abandoned it (often
    // because compaction made them forget the project existed and they
    // spun up a duplicate). The orphans sit in on_deck forever because
    // the existing in_progress-only gate never sees them and the PM's
    // STALE check only chats, doesn't auto-resolve.
    //
    // Criteria: on_deck task assigned to this agent, in a project this
    // agent created, the project has zero in_progress tasks, and the
    // task was not touched during the agent's last whole turn (field fix 3
    // audit round: the same record-based signal, replacing a 30-minute
    // clock; it still never fires inside the turn that created the task).
    const strandedRows = (db.prepare(`
      SELECT t.id AS id, t.title AS title, 'stranded' AS kind FROM work t
      INNER JOIN work p ON p.id = t.parent_id
      WHERE ${taskScope('t')} AND t.agent_id = ?
        AND t.state = 'open'
        AND t.is_paused = 0 AND NOT ${heldExpr('t')}
        AND ${handedInExpr('t')} = 0
        AND (t.scheduled_start IS NULL OR t.scheduled_start <= ?)
        AND t.schedule_status != 'waiting'
        AND p.requester_id = ?
        AND p.state = 'open'
        AND ${taskMovedAtSql('t')} < ?
        AND NOT EXISTS (
          SELECT 1 FROM work sib
          WHERE sib.parent_id = p.id AND sib.kind = 'task' AND sib.state = 'claimed'
        )
      ORDER BY ${taskMovedAtSql('t')} ASC
      LIMIT 10
    `).all(agentId, Date.now(), agentId, passedOverBefore ?? 0) as Array<{ id: string; title: string; kind: string }>)
      .filter((r) => !jobWork.includes(r.id));

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
      const inProgressList = inProgressDanglers   // v3.5 text wave: each with what its record says was done and is left
        .map((r) => { const f = readMeasureFacts(r.id); return `  - "${r.title}" (${r.id.slice(0, 8)})${f ? ` — ${formatMeasureLine(f)}` : ''}`; })
        .join('\n');
      const strandedList = strandedRows
        .map((r) => `  - "${r.title}" (${r.id.slice(0, 8)})`)
        .join('\n');

      const sections: string[] = [];
      if (inProgressDanglers.length > 0) {
        sections.push(
          `${inProgressDanglers.length} in_progress task${inProgressDanglers.length === 1 ? '' : 's'} of yours that ha${inProgressDanglers.length === 1 ? 's' : 've'} not moved for a while:\n${inProgressList}`
        );
      }
      // 2026-07-22 production incident: the neutral menu let the floor model
      // pause a DELIVERED task (a new zombie) and redo finished work. When the
      // engine's own records show the work was answered/delivered, the gate
      // says so and names the right disposition instead of offering a menu.
      try {
        // Only what the engine can count (a file the worker wrote, a measure at 0): a bare reply is often
        // an ack on a task legitimately waiting, on every channel, so it is never evidence here.
        const { engineProofLine } = await import('../../../../work/done/proof.js');
        const evidenced: string[] = [];
        for (const r of inProgressDanglers) {
          const rec = engineProofLine(r.id);
          if (rec) evidenced.push(`  - "${r.title}" (${r.id.slice(0, 8)}): ${rec}`);
        }
        if (evidenced.length > 0) {
          sections.push(
            `The engine's records show work on record for these:\n${evidenced.join('\n')}\n` +
            `If something remains, say what in a work_note and continue. ` +
            `Do not redo or re-deliver what was already delivered.`
          );
        }
      } catch { /* evidence consult is best-effort; the gate still fires */ }
      if (strandedRows.length > 0) {
        sections.push(
          `${strandedRows.length} queued step${strandedRows.length === 1 ? '' : 's'} on a project of yours with no step in progress for more than 30 minutes:\n${strandedList}`
        );
      }

      const gateMsg = (
        `${GATE_MSG_HEAD} Your tracker shows work that has not moved for a while; nothing is closed for you, and the tracker should say where it stands.\n\n` +
        `${sections.join('\n\n')}\n\n` +
        `**Start this turn with one tracker call, before any reply.** For each item: work_note(task_id, notes="what is next") if you are continuing it (then carry on with the work in this same turn); ` +
        `work_update(action="status", status="paused" with resume_at, or "blocked") if you are waiting; work_update(action="hand_in") only for one that is done or cannot be done, with its proof (a measured task is finished when its measure reads 0); ` +
        `Until one tracker call lands the engine refuses other tool calls; after it, the rest of the turn is yours. ` +
        `Results already delivered to ${userWords(turnCtx.address)} must NOT be repeated; after your tracker call, reply [no-reply] unless ${userWords(turnCtx.address)} asked something new.]`
      );
      // F2.4: dedupe the gate message per wakeup batch. Queued wakeups re-arm this
      // gate on every attempt (three duplicate inserts were observed in 20s). The
      // enforcement state is already armed above (danglingTaskIds), so if the
      // dashboard already carries a close-out gate message from the last 5 minutes,
      // skip the redundant INSERT + broadcast while STILL arming enforcement.
      const recentGateMsg = db.prepare(`
        SELECT 1 FROM messages
        WHERE agent_id = ? AND role = 'system'
          AND content LIKE ?
          AND created_at >= (unixepoch('now', '-5 minutes') * 1000)
        LIMIT 1
      `).get(agentId, `${GATE_MSG_HEAD}%`);
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
