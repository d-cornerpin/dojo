// ════════════════════════════════════════
// Task delivery evidence (2026-07-22 production incident).
//
// The incident: the primary finished a project, delivered the file, and never
// closed the task. Every downstream consumer (the drive ladder, the close-out
// gate, the next turn's context) trusted the lying status and re-drove the
// FULL work. The engine had the receipts the whole time: the turns table
// recorded an answered turn on the task's originating conversation, and the
// artifact/delivery rows recorded what was handed over. Nothing consulted
// them.
//
// This module is that consult: keyed evidence that a task's work looks
// DELIVERED even though its status still says in_progress. Consumers:
//   - the poke ladder: an evidence-carrying poke steers the agent to CLOSE
//     the task (complete, with the recorded result), not to redo the work;
//     on the SECOND strike (a prior poke was already sent after the evidence
//     existed and the status still lies) the engine closes the task itself
//     with the receipt basis recorded (owner precedent: correctness is
//     engine-enforced, not nudged; the nudge demonstrably failed live).
//   - the close-out gate: the gate copy leads with the evidence and the
//     recommended disposition instead of a neutral menu the floor model
//     picks wrongly from (it paused a delivered task, creating a new zombie).
//
// Evidence definition, deliberately conservative: an ANSWERED turn by the
// task's assignee whose trigger IS the task's originating ask row (t143 round 3: never the
// same conversation — an unrelated answer there is not this task's delivery), started at or
// after the task existed. Artifact/delivery rows from that turn strengthen
// the copy but are not required (a plain answered reply is a delivery too).
// A conversation merely mentioning the task never matches: the join is on
// origin identity, not content.
// ════════════════════════════════════════
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { taskScope, msToText } from '../work/tracker-view.js';
import { NON_ANSWERING_DISPLAY_KINDS, ENGINE_SENT_TOOLS } from '../work/ask-settlement.js';
import { START_ACK_ORIGIN_INTENT } from '../memory/origin-intents.js';
import { measureReadsZero } from '../work/measure-close-gate.js';

const logger = createLogger('delivery-evidence');

export interface TaskDeliveryEvidence {
  turnNumber: number;
  answeredAt: string;
  answerMessageId: string | null;
  /** Delivered artifact names/urls from that turn (may be empty). */
  artifacts: string[];
  /** Channel deliveries recorded for that turn (may be empty). */
  deliveredVia: string[];
}

export function findDeliveryEvidenceForTask(taskId: string): TaskDeliveryEvidence | null {
  try {
    const db = getDb();
    const task = db.prepare(
      `SELECT w.agent_id AS assigned_to, w.source_message_id AS source_message_id,
              ${msToText('w.opened_at')} AS created_at
         FROM work w WHERE ${taskScope('w')} AND w.id = ?`,
    ).get(taskId) as { assigned_to: string | null; source_message_id: string | null; created_at: string } | undefined;
    if (!task?.assigned_to) return null;
    // t143 round 3 (I1): a turn is tied to a task only STRUCTURALLY — the turn's trigger is the ask
    // that opened the task. Never by conversation: an unrelated answer in the same conversation is
    // not this task's delivery, and this consult can close a task.
    if (!task.source_message_id) return null;

    const turn = db.prepare(
      `SELECT turn_number, ended_at, answer_message_id FROM turns
        WHERE agent_id = ? AND answered = 1
          AND started_at >= ?
          AND source_message_id = ?
        ORDER BY turn_number DESC LIMIT 1`,
    ).get(
      task.assigned_to, task.created_at, task.source_message_id,
    ) as { turn_number: number; ended_at: string | null; answer_message_id: string | null } | undefined;
    if (!turn) return null;

    // Discriminator against the mid-work false positive: an agent that ACKED
    // the ask ("on it") also produces an answered turn on the origin
    // conversation. If the assignee has run tools on ANY later turn, the work
    // is (or was) still moving and this is NOT delivered-and-idle; no
    // evidence. The incident shape (deliver, then silence) passes: nothing
    // ran after the delivering turn.
    const laterActivity = db.prepare(
      `SELECT 1 FROM audit_log WHERE agent_id = ? AND turn_number > ? LIMIT 1`,
    ).get(task.assigned_to, turn.turn_number);
    if (laterActivity) return null;

    const artifacts: string[] = [];
    try {
      // PHASE-2 T5 — THE READER for `turn_artifacts.delivery_id` (Phase-1 §7 debt).
      //
      // `delivered_at IS NOT NULL` says the ENGINE drained its queue. It does not say a
      // person received anything, and this consult can CLOSE A TASK on its own strength
      // (second-strike, engine-enforced, owner precedent). An artifact whose delivery FAILED
      // is exactly the false evidence that must not close a task, so an artifact that names
      // its delivery is only evidence when that delivery succeeded.
      //
      // The `delivery_id IS NULL` arm is the 325 pre-T5 rows, which carry no link and are
      // read as they always were. It is a dated fallback, not a permanent second rule.
      const rows = db.prepare(
        `SELECT ta.path AS path, ta.payload_json AS payload_json
           FROM turn_artifacts ta
           LEFT JOIN deliveries d ON d.id = ta.delivery_id
          WHERE ta.agent_id = ? AND ta.turn_number = ? AND ta.delivered_at IS NOT NULL
            AND (ta.delivery_id IS NULL OR d.outcome = 'delivered')`,
      ).all(task.assigned_to, turn.turn_number) as Array<{ path: string | null; payload_json: string | null }>;
      for (const r of rows) {
        let name = r.path ?? null;
        if (r.payload_json) {
          try {
            const p = JSON.parse(r.payload_json) as { filename?: string; url?: string };
            name = p.filename ?? p.url ?? name;
          } catch { /* keep path */ }
        }
        if (name) artifacts.push(name);
      }
    } catch { /* artifact read is best-effort */ }

    const deliveredVia: string[] = [];
    try {
      const rows = db.prepare(
        `SELECT DISTINCT channel FROM deliveries
          WHERE agent_id = ? AND turn_number = ? AND outcome = 'delivered'`,
      ).all(task.assigned_to, turn.turn_number) as Array<{ channel: string }>;
      for (const r of rows) deliveredVia.push(r.channel);
    } catch { /* best-effort */ }

    return {
      turnNumber: turn.turn_number,
      answeredAt: turn.ended_at ?? task.created_at,
      answerMessageId: turn.answer_message_id,
      artifacts,
      deliveredVia,
    };
  } catch (err) {
    logger.warn('findDeliveryEvidenceForTask failed (treated as no evidence)', {
      taskId, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 2 T11 — THE POINTER THE VALIDATION REVIEW WAS MISSING.
//
// The Key-2 payload orders the PM to *"Read the file/audit log/output referenced in evidence
// BEFORE validating"* (`pm-agent.ts:1596`) and PM-SOUL forbids rejecting for non-dereference
// (*"NEVER reject because you didn't dereference"*, `PM-SOUL.md:61-66`) — while the payload
// itself selects only the work row's own prose. On S4 (2026-08-10) the PM wrote 7
// `validation_review_miss` rows over 383 s and made ~40 `history_search` calls that could not
// have worked: the rundown is an owner-lane row in the harness bot's conversation and the pieces
// are `lane='a2a'` rows. The rule and the payload were in direct contradiction.
//
// This resolves ONE dereferenceable pointer per row from records the engine already keeps, in
// the order of how directly each was RECORDED rather than inferred:
//   (a) the task→ask edge (T11's `work.source_message_id` stamp) → the ask's own
//       `result_delivery_id` — which is what `compile_resolved` wrote, i.e. the authority that
//       knew which delivery satisfied the request said so;
//   (b) failing that, `findDeliveryEvidenceForTask`'s turn-level answer for the task itself.
// Nothing is guessed: no pointer resolves to null, which is the honest answer and leaves the
// PM's existing behaviour unchanged for rows that genuinely have nothing behind them.
//
// Bounded by construction: at most three small indexed lookups, on a queue already capped at
// `LIMIT 10` (`pm-agent.ts:1475`).
// ════════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════════
// v3.5 field fix 3, review rounds 1-4: THE ONE DEFINITION OF "THE TASK'S ANSWER".
//
// WHO READS IT (round 4, binding ruling): only the WORKER's own close (it files Key 1 on it for the
// PM, OR-FIELD3(b), `tracker/tools.ts`), G7's refusal text, and the validation request that shows
// it to the PM. The ENGINE never closes on it and never calls a task "delivered" on it: done is
// measured, never declared, so the engine's own closes and its "already delivered" readings count
// only what the engine can count (`taskWorkOnRecord` below: a delivered file, or a measure at 0).
//
// THE ACK IS IDENTIFIED STRUCTURALLY, by the marking the engine already writes when it delivers
// the start line (`agent/v2/steps/post-call-classify/terminal-text.ts` -> `deliverEngineUserAck`):
// the row carries `origin_intent = engine_start_ack` (START_ACK_ORIGIN_INTENT), and its channel push
// is recorded on the `engine-ack` lane. Every other engine-written line is named by its delivery
// tool (`ENGINE_SENT_TOOLS`, the `<channel>-door` crossings). None of these is ever the answer.
// Order is never a test of "ack or answer" (the round-3 "any later line" rule was a prose-order
// guess, re-review R1/R2).
//
// THE ANSWER is a delivered line, by the task's own agent, on the ASK's conversation, written after
// the ask arrived (by `messages.seq`, never by a second-rounded clock), that is not a chip and not
// engine-written. Candidates, in order of how directly each was recorded:
//   (a) the ask the task exists for (its `source_message_id`, else its project's): the ask's own
//       `result_delivery_id`, written by the settlement authority;
//   (b) the asks settled by the turn of the task's newest ANSWERED stamp
//       (`messages.served_by_turn`, written as part of the settlement);
//   (c) the task's own answered turn (`findDeliveryEvidenceForTask`).
// ════════════════════════════════════════════════════════════════════════════════

export interface TaskAnswerPointer {
  deliveryId: string;
  messageId: string | null;
  /** How the pointer was established — recorded, never inferred prose. `run-delivery`: a scheduled
   *  task's current run settled on this delivery (the occurrence's own receipt). */
  basis: 'parent-ask-receipt' | 'task-turn-answer' | 'run-delivery';
  /** The delivered words, trimmed (a fixed placeholder for a channel send with no message row). */
  excerpt: string;
  channel: string | null;
  at: string | null;
}

const ANSWER_EXCERPT_CHARS = 400;
// Rendered at call time, never at module scope (see `memory/origin-intents.ts` on import order).
const sqlList = (xs: Iterable<string>): string => [...xs].map((k) => `'${k}'`).join(', ');

interface AskAnchor { conversationId: string | null; seq: number | null }

/** The ask's conversation and its arrival position on the message log. */
function askAnchor(messageId: string): AskAnchor {
  const r = getDb().prepare(
    `SELECT a.conversation_id AS conversation_id, m.seq AS seq
       FROM messages m LEFT JOIN work a ON a.id = ? AND a.kind = 'ask'
      WHERE m.id = ?`,
  ).get(`ask:${messageId}`, messageId) as { conversation_id: string | null; seq: number | null } | undefined;
  return { conversationId: r?.conversation_id ?? null, seq: r?.seq ?? null };
}

/** The candidate, if it is the agent's answer on the ask's thread and not an engine-marked line. */
function answerPointer(
  deliveryId: string, basis: TaskAnswerPointer['basis'], agentId: string, ask: AskAnchor,
  /** A scheduled task's run start (ms): a delivery from before the run is not the run's (C3). */
  notBeforeMs: number | null = null,
): TaskAnswerPointer | null {
  const d = getDb().prepare(
    `SELECT d.id AS id, d.message_id AS message_id, d.channel AS channel, d.conversation_id AS conversation_id,
            d.created_at AS created_at, m.content AS content, m.seq AS seq
       FROM deliveries d LEFT JOIN messages m ON m.id = d.message_id
      WHERE d.id = ? AND d.outcome = 'delivered' AND d.agent_id = ?
        AND d.tool NOT IN (${sqlList(ENGINE_SENT_TOOLS)}) AND d.tool NOT LIKE '%-door'
        AND (m.id IS NULL OR m.origin_intent IS NULL OR m.origin_intent <> '${START_ACK_ORIGIN_INTENT}')
        AND (m.display_kind IS NULL OR m.display_kind NOT IN (${sqlList(NON_ANSWERING_DISPLAY_KINDS)}))`,
  ).get(deliveryId, agentId) as {
    id: string; message_id: string | null; channel: string | null; conversation_id: string | null;
    created_at: string; content: string | null; seq: number | null;
  } | undefined;
  if (!d) return null;
  if (notBeforeMs !== null && Date.parse(`${d.created_at.replace(' ', 'T')}Z`) < Math.floor(notBeforeMs / 1000) * 1000) return null;
  if (ask.conversationId && d.conversation_id !== ask.conversationId) return null;
  // After the ask arrived, on the message log. A channel send with no message row has no position;
  // only an ask receipt (arms a and b, whose settlement already required it to postdate the ask)
  // may be one.
  if (d.seq !== null && ask.seq !== null && d.seq <= ask.seq) return null;
  if (d.seq === null && basis === 'task-turn-answer') return null;
  const raw = (d.content ?? '').replace(/^\[[^\]]*\]\s*/g, '').replace(/\s+/g, ' ').trim()
    || '(a channel send with no message row to quote)';
  return {
    deliveryId: d.id, messageId: d.message_id, basis, channel: d.channel, at: d.created_at,
    excerpt: raw.length > ANSWER_EXCERPT_CHARS ? `${raw.slice(0, ANSWER_EXCERPT_CHARS)}…` : raw,
  };
}

const NO_ANCHOR: AskAnchor = { conversationId: null, seq: null };

/**
 * C3 (v3.5 field fix 3 evidence round): THE RUN A SCHEDULED TASK'S CLOSE IS ABOUT.
 *
 * Measured on the owner's box: a daily reminder's review showed the setup confirmation
 * ("Reminder set ... every day at 9:30 AM", the receipt of the ask that CREATED the schedule) as
 * "DELIVERED ANSWER ON RECORD ... This IS the dereference", for a run whose own turns all hit
 * provider errors. A run points at its own delivery.
 *
 * Scheduled = the row carries a schedule (`repeat_interval` / `scheduled_start`) or the scheduler
 * has opened an occurrence for it. Its run is the newest occurrence opened at or before the close
 * was filed (now, when none is filed); a row from before occurrence rows existed falls back to the
 * scheduler's newest fire (`transition` to claimed, by the scheduler). `null`: not scheduled.
 * `'never-ran'`: scheduled, and no run has started, so nothing can be a run's delivery.
 */
function scheduledRunOf(taskId: string): { startMs: number; deliveryId: string | null } | 'never-ran' | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT w.repeat_interval AS repeat_interval, w.scheduled_start AS scheduled_start,
            EXISTS (SELECT 1 FROM work o WHERE o.parent_id = w.id AND o.kind = 'occurrence') AS has_runs
       FROM work w WHERE w.id = ?`,
  ).get(taskId) as { repeat_interval: number | null; scheduled_start: number | null; has_runs: number } | undefined;
  if (!row || (!row.repeat_interval && row.scheduled_start === null && !row.has_runs)) return null;
  const filed = db.prepare(
    `SELECT MAX(created_at) AS at FROM work_events WHERE work_id = ?
       AND ((kind = 'validation_requested' AND json_extract(payload, '$.requested_state') = 'done')
         OR (kind = 'transition' AND json_extract(payload, '$.to') = 'done'))`,
  ).get(taskId) as { at: number | null } | undefined;
  const ref = filed?.at ?? Date.now();
  const occ = db.prepare(
    `SELECT opened_at, result_delivery_id FROM work
      WHERE parent_id = ? AND kind = 'occurrence' AND opened_at <= ?
      ORDER BY opened_at DESC, rowid DESC LIMIT 1`,
  ).get(taskId, ref) as { opened_at: number; result_delivery_id: string | null } | undefined;
  if (occ) return { startMs: occ.opened_at, deliveryId: occ.result_delivery_id };
  const fired = db.prepare(
    `SELECT MAX(created_at) AS at FROM work_events WHERE work_id = ? AND kind = 'transition' AND actor = 'scheduler'
       AND json_extract(payload, '$.to') = 'claimed' AND created_at <= ?`,
  ).get(taskId, ref) as { at: number | null } | undefined;
  return fired?.at != null ? { startMs: fired.at, deliveryId: null } : 'never-ran';
}

/** THE task's answer (rules above). Null when there is none. Read by the worker's close, G7's
 *  text and the validation request only; never by an engine close. */
export function resolveTaskAnswerPointer(taskId: string): TaskAnswerPointer | null {
  try {
    const db = getDb();
    const task = db.prepare(
      `SELECT w.agent_id AS agent_id, w.source_message_id AS source_message_id,
              p.source_message_id AS parent_source_message_id
         FROM work w LEFT JOIN work p ON p.id = w.parent_id
        WHERE ${taskScope('w')} AND w.id = ?`,
    ).get(taskId) as {
      agent_id: string; source_message_id: string | null; parent_source_message_id: string | null;
    } | undefined;
    if (!task) return null;
    // C3: a SCHEDULED task's work is its runs. The ask that set the schedule was answered by the
    // setup confirmation ("Reminder set ... every day at 9:30 AM"), which is never a run's delivery,
    // so arm (a) is not read for it, and every other candidate must come from the current run.
    const run = scheduledRunOf(taskId);
    if (run === 'never-ran') return null;
    const notBefore = run ? run.startMs : null;
    const askReceipt = (messageId: string): TaskAnswerPointer | null => {
      // `ask:<messageId>` is the spine's own derivation (`work/store.ts:askIdForMessage`).
      const ask = db.prepare(`SELECT result_delivery_id FROM work WHERE id = ? AND kind = 'ask'`)
        .get(`ask:${messageId}`) as { result_delivery_id: string | null } | undefined;
      return ask?.result_delivery_id
        ? answerPointer(ask.result_delivery_id, 'parent-ask-receipt', task.agent_id, askAnchor(messageId), notBefore)
        : null;
    };

    if (run) {
      // (r) the run's own settlement receipt: the occurrence row the scheduler opened for it.
      if (run.deliveryId) {
        const p = answerPointer(run.deliveryId, 'run-delivery', task.agent_id, NO_ANCHOR, notBefore);
        if (p) return p;
      }
    } else {
      // (a) the ask this task (or its project) exists for.
      for (const m of [task.source_message_id, task.parent_source_message_id]) {
        const p = m ? askReceipt(m) : null;
        if (p) return p;
      }
    }
    // (b) the asks the turn of its newest answered stamp settled.
    const stamp = db.prepare(
      `SELECT json_extract(payload, '$.turn') AS turn FROM work_events
        WHERE work_id = ? AND kind = 'activity' AND json_extract(payload, '$.answered') = 1
        ORDER BY id DESC LIMIT 1`,
    ).get(taskId) as { turn: number | null } | undefined;
    if (stamp?.turn != null) {
      const served = db.prepare(
        'SELECT id FROM messages WHERE agent_id = ? AND served_by_turn = ? ORDER BY seq DESC',
      ).all(task.agent_id, stamp.turn) as Array<{ id: string }>;
      for (const m of served) {
        const p = askReceipt(m.id);
        if (p) return p;
      }
    }
    // (c) the task's own answered turn, on its own ask's thread.
    const evidence = findDeliveryEvidenceForTask(taskId);
    if (evidence?.answerMessageId && task.source_message_id) {
      const d = db.prepare(
        `SELECT id FROM deliveries
          WHERE agent_id = ? AND message_id = ? AND outcome = 'delivered'
          ORDER BY rowid DESC LIMIT 1`,
      ).get(task.agent_id, evidence.answerMessageId) as { id: string } | undefined;
      if (d) {
        const p = answerPointer(d.id, 'task-turn-answer', task.agent_id, run ? NO_ANCHOR : askAnchor(task.source_message_id), notBefore);
        if (p) return p;
      }
    }
    return null;
  } catch (err) {
    logger.warn('resolveTaskAnswerPointer failed (treated as no pointer)', {
      taskId, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * WHAT THE ENGINE CAN COUNT (round 4, binding ruling: done is measured, never declared). The one
 * question behind every engine close (strike-0, strike-2) and every engine "already delivered"
 * reading (the task view, the list, the close-out gate, the PM's first-strike steer): a delivered
 * FILE (stamped, or from the task's answered turn), or a measure whose last reading is 0. A line of
 * text, on any channel, is never counted here: it may be an ack, or progress, and only the worker
 * may file a close on it (`resolveTaskAnswerPointer`), which the PM then judges. An engine close
 * never names a remainder (that is the worker's, at its own door), so none is counted here.
 * Null when none, and the readers then say nothing about delivery.
 */
export function taskWorkOnRecord(
  taskId: string,
  stamp: { last_answered_turn: number | null; last_answered_at: string | null; last_delivery_summary: string | null } | null,
): string | null {
  if (stamp && stamp.last_answered_turn !== null && stamp.last_delivery_summary?.startsWith('file ')) {
    return `answered on turn ${stamp.last_answered_turn} (${stamp.last_answered_at} UTC); ${stamp.last_delivery_summary}`;
  }
  const ev = findDeliveryEvidenceForTask(taskId);
  if (ev && ev.artifacts.length > 0) return renderDeliveryEvidence(ev);
  const zero = measureReadsZero(taskId);
  if (zero) return `its measure reads 0 ${zero.unit}`;
  return null;
}

/** One-line human rendering for steer/gate copy. */
export function renderDeliveryEvidence(e: TaskDeliveryEvidence): string {
  const parts = [`an answered reply on this task's own conversation (turn ${e.turnNumber}, ${e.answeredAt} UTC)`];
  if (e.artifacts.length > 0) parts.push(`delivered file(s): ${e.artifacts.slice(0, 3).join(', ')}`);
  if (e.deliveredVia.length > 0) parts.push(`sent via ${e.deliveredVia.join('/')}`);
  return parts.join('; ');
}


// ── The origin chain, rendered for the AGENT (2026-07-22 owner ruling) ──
// The plan's stated goal was always that the AGENT can discern where a task
// came from: which conversation, which prompt, and what has answered it
// since. The identity columns existed from Phase 1; this renders them on
// every tracker read so the connection is in the agent's own view, not only
// in engine guards.

export interface TaskOriginChain {
  /** Where the ask came from (channel + counterparty of the origin conversation). */
  from: string | null;
  /** Excerpt of the originating prompt. */
  promptExcerpt: string | null;
  originAt: string | null;
}

export function findTaskOriginChain(taskId: string): TaskOriginChain | null {
  try {
    const db = getDb();
    const task = db.prepare(
      `SELECT w.source_message_id AS source_message_id, w.origin_conv_key AS origin_conv_key,
              w.origin_kind AS origin_kind, ${msToText('w.opened_at')} AS created_at
         FROM work w WHERE ${taskScope('w')} AND w.id = ?`,
    ).get(taskId) as { source_message_id: string | null; origin_conv_key: string | null; origin_kind: string | null; created_at: string } | undefined;
    if (!task) return null;
    if (!task.source_message_id && !task.origin_conv_key) return null;

    let from: string | null = null;
    let promptExcerpt: string | null = null;
    let originAt: string | null = null;
    if (task.source_message_id) {
      const msg = db.prepare(
        `SELECT m.content, datetime(m.created_at/1000,'unixepoch') AS created_at, c.channel, c.counterparty_name, c.counterparty_id
           FROM messages m LEFT JOIN conversations c ON c.id = m.conversation_id
          WHERE m.id = ?`,
      ).get(task.source_message_id) as { content: string | null; created_at: string; channel: string | null; counterparty_name: string | null; counterparty_id: string | null } | undefined;
      if (msg) {
        originAt = msg.created_at;
        if (msg.channel) {
          const who = msg.counterparty_name ?? msg.counterparty_id ?? 'unknown';
          from = who === 'owner' ? `the owner's ${msg.channel} conversation` : `${who} via ${msg.channel}`;
        }
        if (msg.content) {
          // Strip engine source markers so the agent sees the human ask.
          const cleaned = msg.content.replace(/^\[[^\]]*\]\s*/g, '').trim();
          promptExcerpt = cleaned.slice(0, 160) || null;
        }
      }
    }
    if (!from && task.origin_conv_key) from = `conversation ${task.origin_conv_key}`;
    if (!from && task.origin_kind) from = `origin: ${task.origin_kind}`;
    return { from, promptExcerpt, originAt: originAt ?? task.created_at };
  } catch (err) {
    logger.warn('findTaskOriginChain failed (non-fatal)', {
      taskId, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** One-line origin rendering for the agent's tracker view. */
export function renderTaskOriginChain(o: TaskOriginChain): string {
  const parts: string[] = [];
  if (o.from) parts.push(`created from ${o.from}`);
  if (o.originAt) parts.push(`at ${o.originAt} UTC`);
  const head = parts.join(' ');
  return o.promptExcerpt ? `${head}, asking: "${o.promptExcerpt}"` : head;
}
