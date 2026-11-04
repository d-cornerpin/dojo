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
// `task-stamps.ts` does not import this module, so this adds no cycle.
import { isTangibleDeliverySummary } from './task-stamps.js';
import { NON_ANSWERING_DISPLAY_KINDS } from '../work/ask-settlement.js';

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
// v3.5 field fix 3, review round (H1, M2): THE ONE DEFINITION OF "THE TASK'S ANSWER".
//
// Three readers disagreed: the close fallback, this pointer, and the filed close's delivery.
// This function is now the only one. The agent's own close doors fall back to it
// (`tracker/tools.ts`), G7's refusal text states it, the PM's validation request prints it,
// and every advisory reader that tells the agent "already delivered" or "CLOSE if done" asks
// it (`taskWorkOnRecord` below).
//
// ── AN ACK IS NEVER THE ANSWER (owner law: start ack AND completion are both required) ──
// An ask settles on the turn's final model line, and that line can be "On it, I've opened the
// steps and will work through them" (`work/ask-settlement.ts` qualifyingDelivery): a real
// receipt naming an acknowledgement. No prose test may decide which one it is. The structural
// fact is ORDER, set by the always-ack rule: tracked work is acknowledged when it starts, and
// the engine asks for that line as soon as the work is tracked (`start-ack-door.ts`, raised
// when the agent opens its own project and by the scaffold floor). So the FIRST line that
// reaches the asking thread after the task opened is that task's start acknowledgement, and
// only a LATER line on the same thread can be its completion. A candidate qualifies only when:
//   * it is delivered, by the task's own agent, not on the `engine-ack` lane, not a chip;
//   * it was recorded at or after the task opened;
//   * an EARLIER delivered line by that agent reached the same conversation since the task
//     opened (the start ack). The engine's own promoted start line counts as that ack.
// The cost of the rule falls on the safe side: a one-line job that never acknowledged reads as
// "no completion on record", and the agent writes one. Ruling 10(d): ambiguity resolves toward
// answering again, never toward closing.
//
// The candidates, in order of how directly each was recorded:
//   (a) the ask the task exists for (its `source_message_id`, else its project's): the ask's
//       own `result_delivery_id`, written by the settlement authority;
//   (b) the asks settled by the turn of the task's newest ANSWERED stamp
//       (`messages.served_by_turn`, written as part of the settlement);
//   (c) the task's own answered turn (`findDeliveryEvidenceForTask`).
// OR-FIELD3(b) is carried here: a dashboard answer to a dashboard ask qualifies like any
// other delivered line, under the same ack rule.
// ════════════════════════════════════════════════════════════════════════════════

export interface TaskAnswerPointer {
  deliveryId: string;
  messageId: string | null;
  /** How the pointer was established — recorded, never inferred prose. */
  basis: 'parent-ask-receipt' | 'task-turn-answer';
  /** The delivered words, trimmed (a fixed placeholder for a channel send with no message row). */
  excerpt: string;
  channel: string | null;
  at: string | null;
}

const ANSWER_EXCERPT_CHARS = 400;
// A chip is not a line the person read: the same declared set the settlement authority reads,
// rendered at call time (never at module scope, see `memory/origin-intents.ts` on import order).
const chipKindsSql = (): string => NON_ANSWERING_DISPLAY_KINDS.map((k) => `'${k}'`).join(', ');

/** The candidate, if it is this task's completion and not its start ack (rules above). */
function answerPointer(
  deliveryId: string, basis: TaskAnswerPointer['basis'],
  task: { agent_id: string; opened_at: number },
): TaskAnswerPointer | null {
  const db = getDb();
  const d = db.prepare(
    `SELECT d.rowid AS seq, d.id AS id, d.message_id AS message_id, d.channel AS channel,
            d.conversation_id AS conversation_id, d.created_at AS created_at, m.content AS content
       FROM deliveries d LEFT JOIN messages m ON m.id = d.message_id
      WHERE d.id = ? AND d.outcome = 'delivered' AND d.agent_id = ? AND d.tool <> 'engine-ack'
        AND (m.display_kind IS NULL OR m.display_kind NOT IN (${chipKindsSql()}))
        AND CAST(strftime('%s', d.created_at) AS INTEGER) >= ? / 1000`,
  ).get(deliveryId, task.agent_id, task.opened_at) as {
    seq: number; id: string; message_id: string | null; channel: string | null;
    conversation_id: string | null; created_at: string; content: string | null;
  } | undefined;
  if (!d) return null;
  const ackBefore = db.prepare(
    `SELECT 1 AS hit FROM deliveries e LEFT JOIN messages me ON me.id = e.message_id
      WHERE e.agent_id = ? AND e.outcome = 'delivered' AND e.rowid < ?
        AND e.conversation_id IS ?
        AND (me.display_kind IS NULL OR me.display_kind NOT IN (${chipKindsSql()}))
        AND CAST(strftime('%s', e.created_at) AS INTEGER) >= ? / 1000
      LIMIT 1`,
  ).get(task.agent_id, d.seq, d.conversation_id, task.opened_at);
  if (!ackBefore) return null;
  const raw = (d.content ?? '').replace(/^\[[^\]]*\]\s*/g, '').replace(/\s+/g, ' ').trim()
    || '(a channel send with no message row to quote)';
  return {
    deliveryId: d.id, messageId: d.message_id, basis, channel: d.channel, at: d.created_at,
    excerpt: raw.length > ANSWER_EXCERPT_CHARS ? `${raw.slice(0, ANSWER_EXCERPT_CHARS)}…` : raw,
  };
}

/** THE task's answer: its completion on record, never its start ack. Null when there is none.
 *  The one definition; see the block above. */
export function resolveTaskAnswerPointer(taskId: string): TaskAnswerPointer | null {
  try {
    const db = getDb();
    const task = db.prepare(
      `SELECT w.agent_id AS agent_id, w.opened_at AS opened_at, w.source_message_id AS source_message_id,
              p.source_message_id AS parent_source_message_id
         FROM work w LEFT JOIN work p ON p.id = w.parent_id
        WHERE ${taskScope('w')} AND w.id = ?`,
    ).get(taskId) as {
      agent_id: string; opened_at: number; source_message_id: string | null; parent_source_message_id: string | null;
    } | undefined;
    if (!task) return null;
    const askReceipt = (messageId: string): TaskAnswerPointer | null => {
      // `ask:<messageId>` is the spine's own derivation (`work/store.ts:askIdForMessage`).
      const ask = db.prepare(`SELECT result_delivery_id FROM work WHERE id = ? AND kind = 'ask'`)
        .get(`ask:${messageId}`) as { result_delivery_id: string | null } | undefined;
      return ask?.result_delivery_id ? answerPointer(ask.result_delivery_id, 'parent-ask-receipt', task) : null;
    };

    // (a) the ask this task (or its project) exists for.
    for (const m of [task.source_message_id, task.parent_source_message_id]) {
      const p = m ? askReceipt(m) : null;
      if (p) return p;
    }
    // (b) the asks the turn of its newest answered stamp settled.
    const stamp = db.prepare(
      `SELECT json_extract(payload, '$.turn') AS turn FROM work_events
        WHERE work_id = ? AND kind = 'activity' AND json_extract(payload, '$.answered') = 1
        ORDER BY id DESC LIMIT 1`,
    ).get(taskId) as { turn: number | null } | undefined;
    if (stamp?.turn != null) {
      const served = db.prepare(
        'SELECT id FROM messages WHERE agent_id = ? AND served_by_turn = ? ORDER BY created_at DESC',
      ).all(task.agent_id, stamp.turn) as Array<{ id: string }>;
      for (const m of served) {
        const p = askReceipt(m.id);
        if (p) return p;
      }
    }
    // (c) the task's own answered turn.
    const evidence = findDeliveryEvidenceForTask(taskId);
    if (evidence?.answerMessageId) {
      const d = db.prepare(
        `SELECT id FROM deliveries
          WHERE agent_id = ? AND message_id = ? AND outcome = 'delivered'
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      ).get(task.agent_id, evidence.answerMessageId) as { id: string } | undefined;
      if (d) {
        const p = answerPointer(d.id, 'task-turn-answer', task);
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
 * The advisory readers' one question: is this task's work on record as DELIVERED, and in what
 * words? A tangible stamp (a file, an out-of-band channel; the 2026-07-22 standard, unchanged),
 * a delivered file from its answered turn, or THE task's answer (`resolveTaskAnswerPointer`).
 * A dashboard or voice bubble alone is never enough: it may be the start ack.
 * Null when none, and the readers then say nothing about delivery.
 */
export function taskWorkOnRecord(
  taskId: string,
  stamp: { last_answered_turn: number | null; last_answered_at: string | null; last_delivery_summary: string | null } | null,
): string | null {
  if (stamp && stamp.last_answered_turn !== null && isTangibleDeliverySummary(stamp.last_delivery_summary)) {
    return `answered on turn ${stamp.last_answered_turn} (${stamp.last_answered_at} UTC); ${stamp.last_delivery_summary}`;
  }
  const ev = findDeliveryEvidenceForTask(taskId);
  if (ev && ev.artifacts.length > 0) return renderDeliveryEvidence(ev);
  const answer = resolveTaskAnswerPointer(taskId);
  if (answer) {
    return `its answer was delivered (delivery ${answer.deliveryId.slice(0, 8)}`
      + `${answer.channel ? `, via ${answer.channel}` : ''}${answer.at ? `, ${answer.at} UTC` : ''})`;
  }
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
