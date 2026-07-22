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
// task's assignee whose identity ties to the task's OWN origin (same
// originating ask row, or the same origin conversation key), started at or
// after the task existed. Artifact/delivery rows from that turn strengthen
// the copy but are not required (a plain answered reply is a delivery too).
// A conversation merely mentioning the task never matches: the join is on
// origin identity, not content.
// ════════════════════════════════════════
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

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
      `SELECT assigned_to, source_message_id, origin_conv_key, created_at FROM tasks WHERE id = ?`,
    ).get(taskId) as { assigned_to: string | null; source_message_id: string | null; origin_conv_key: string | null; created_at: string } | undefined;
    if (!task?.assigned_to) return null;
    if (!task.source_message_id && !task.origin_conv_key) return null;

    const turn = db.prepare(
      `SELECT turn_number, ended_at, answer_message_id FROM turns
        WHERE agent_id = ? AND outcome = 'answered'
          AND started_at >= ?
          AND (
            (source_message_id IS NOT NULL AND source_message_id = ?)
            OR (conv_key IS NOT NULL AND conv_key = ?)
          )
        ORDER BY turn_number DESC LIMIT 1`,
    ).get(
      task.assigned_to, task.created_at,
      task.source_message_id ?? '', task.origin_conv_key ?? '',
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
      const rows = db.prepare(
        `SELECT path, payload_json FROM turn_artifacts
          WHERE agent_id = ? AND turn_number = ? AND delivered_at IS NOT NULL`,
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

/** One-line human rendering for steer/gate copy. */
export function renderDeliveryEvidence(e: TaskDeliveryEvidence): string {
  const parts = [`an answered reply on this task's own conversation (turn ${e.turnNumber}, ${e.answeredAt} UTC)`];
  if (e.artifacts.length > 0) parts.push(`delivered file(s): ${e.artifacts.slice(0, 3).join(', ')}`);
  if (e.deliveredVia.length > 0) parts.push(`sent via ${e.deliveredVia.join('/')}`);
  return parts.join('; ');
}
