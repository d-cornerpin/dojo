// ════════════════════════════════════════
// Ticket stamps (owner design 2026-07-22; DOJO-TICKET-STAMPS-PLAN).
//
// The engine stamps each task ticket with what it OBSERVED as work happens,
// at ONE point: turn finalize, where the turns/deliveries/artifacts records
// for the ending turn already exist. The model then reads the stamps on
// every surface where it meets the ticket, so "what has been done" comes
// from engine records, never from conversation memory (which compaction
// eats) and never from guessing.
//
// HARD RULES (conformance-locked):
//   - stamp writes NEVER touch updated_at (the drive ladder's idle clock;
//     touching it would silence pokes forever),
//   - stamp writes NEVER touch status or any *_validated column (two-key
//     contract),
//   - one atomic UPDATE per ticket per finalize (per-agent turn
//     serialization makes this race-free for the agent's own tickets).
// ════════════════════════════════════════
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('task-stamps');

function relAgo(sqliteUtc: string | null): string {
  if (!sqliteUtc) return '';
  const ms = Date.parse(sqliteUtc.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Compose the compact delivery summary for a turn from its delivery and
 *  artifact records. Empty string when the turn delivered nothing. */
export function composeTurnDeliverySummary(agentId: string, turnNumber: number): string {
  try {
    const db = getDb();
    const parts: string[] = [];
    const arts = db.prepare(
      `SELECT path, payload_json FROM turn_artifacts
        WHERE agent_id = ? AND turn_number = ? AND delivered_at IS NOT NULL AND kind != 'screen'
        LIMIT 3`,
    ).all(agentId, turnNumber) as Array<{ path: string | null; payload_json: string | null }>;
    const names: string[] = [];
    for (const a of arts) {
      let n = a.path ? a.path.split('/').pop() ?? a.path : null;
      if (a.payload_json) {
        try {
          const p = JSON.parse(a.payload_json) as { filename?: string; url?: string };
          n = p.filename ?? n ?? p.url ?? null;
        } catch { /* keep path basename */ }
      }
      if (n) names.push(n);
    }
    // One file often has several artifact rows (canvas doc + download link);
    // the summary names it once.
    const unique = [...new Set(names)];
    if (unique.length > 0) parts.push(`file ${unique.join(', ')}`);
    const chans = db.prepare(
      `SELECT DISTINCT channel FROM deliveries
        WHERE agent_id = ? AND turn_number = ? AND outcome = 'delivered' AND channel NOT IN ('dashboard', 'voice')`,
    ).all(agentId, turnNumber) as Array<{ channel: string }>;
    if (chans.length > 0) parts.push(`via ${chans.map((c) => c.channel).join('/')}`);
    return parts.join('; ').slice(0, 120);
  } catch {
    return '';
  }
}

/**
 * The single stamping point, called from the loop's turn-finalize block.
 * Stamps every ticket of THIS agent whose origin ties to the ending turn.
 * Best-effort: never throws into a live finalize.
 */
export function stampTasksAtTurnFinalize(input: {
  agentId: string;
  turnNumber: number;
  outcome: string;
  answerMessageId: string | null;
  rootSourceMessageId: string | null;
  convKey: string | null;
  servedTaskId: string | null;
}): void {
  try {
    const db = getDb();
    const tied = db.prepare(
      `SELECT id FROM legacy_tasks
        WHERE assigned_to = ?
          AND status IN ('in_progress', 'on_deck', 'blocked')
          AND (
            (source_message_id IS NOT NULL AND source_message_id = ?)
            OR (origin_conv_key IS NOT NULL AND origin_conv_key = ?)
            OR origin_turn = ?
            OR id = ?
          )
        LIMIT 20`,
    ).all(
      input.agentId,
      input.rootSourceMessageId ?? '',
      input.convKey ?? '',
      input.turnNumber,
      input.servedTaskId ?? '',
    ) as Array<{ id: string }>;
    if (tied.length === 0) return;

    const answered = input.outcome === 'answered';
    const deliverySummary = composeTurnDeliverySummary(input.agentId, input.turnNumber);
    const hasDelivery = deliverySummary.length > 0;

    // One atomic UPDATE per ticket. COALESCE keeps prior answered/delivery
    // stamps when THIS turn did not answer/deliver. Deliberately no
    // updated_at, no status, no validation columns (conformance-locked).
    const stamp = db.prepare(`
      UPDATE legacy_tasks SET
        last_activity_turn = ?,
        last_activity_at = datetime('now'),
        last_activity_outcome = ?,
        last_answered_turn = COALESCE(?, last_answered_turn),
        last_answered_at = COALESCE(?, last_answered_at),
        last_answer_message_id = COALESCE(?, last_answer_message_id),
        last_delivery_at = COALESCE(?, last_delivery_at),
        last_delivery_summary = COALESCE(?, last_delivery_summary)
      WHERE id = ?
    `);
    for (const t of tied) {
      stamp.run(
        input.turnNumber,
        input.outcome,
        answered ? input.turnNumber : null,
        answered ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null,
        answered ? input.answerMessageId : null,
        hasDelivery ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null,
        hasDelivery ? deliverySummary : null,
        t.id,
      );
    }
    logger.info('ticket stamps written at turn finalize', {
      agentId: input.agentId, turnNumber: input.turnNumber, outcome: input.outcome,
      tickets: tied.length, delivered: hasDelivery,
    }, input.agentId);
  } catch (err) {
    logger.warn('stampTasksAtTurnFinalize failed (non-fatal)', {
      agentId: input.agentId, turnNumber: input.turnNumber,
      error: err instanceof Error ? err.message : String(err),
    }, input.agentId);
  }
}

export interface TaskStampFields {
  last_activity_turn: number | null;
  last_activity_at: string | null;
  last_activity_outcome: string | null;
  last_answered_turn: number | null;
  last_answered_at: string | null;
  last_delivery_summary: string | null;
  step_number?: number | null;
  total_steps?: number | null;
  project_id?: string | null;
  id?: string;
}

/** The one compact stamp line the model reads (<=~90 chars typical).
 *  Owner ruling: facts PLUS instruction on answered tickets. */
export function renderTaskStamps(t: TaskStampFields): string {
  if (t.last_answered_turn !== null && t.last_answered_at) {
    // The CLOSE instruction requires a TANGIBLE handover on record, the same
    // standard as the strike-2 engine close. A reply without a recorded
    // delivery is often just an ack ("back with you soon"); nudging CLOSE on
    // it strangled a delegation synthesis task mid-wait (battery catch,
    // 2026-07-22). Facts only in that case.
    if (t.last_delivery_summary) {
      return `answered T${t.last_answered_turn} ${relAgo(t.last_answered_at)}; ${t.last_delivery_summary}; CLOSE if done`;
    }
    return `replied T${t.last_answered_turn} ${relAgo(t.last_answered_at)} (no delivery recorded)`;
  }
  if (t.last_activity_turn !== null && t.last_activity_at) {
    return `last activity T${t.last_activity_turn} ${relAgo(t.last_activity_at)} (${t.last_activity_outcome ?? 'unknown'})`;
  }
  return 'no engine activity yet';
}

/** Live sequence facts for a step task (owner ruling: sequence by VISIBILITY,
 *  never by gating; derived from siblings at read time, no stored state).
 *  Empty string for non-step tasks or when no earlier step is open. */
export function renderStepFacts(t: TaskStampFields): string {
  if (!t.project_id || t.step_number === null || t.step_number === undefined || !t.total_steps) return '';
  try {
    const db = getDb();
    const openEarlier = db.prepare(
      `SELECT step_number, title FROM legacy_tasks
        WHERE project_id = ? AND step_number IS NOT NULL AND step_number < ?
          AND status NOT IN ('complete', 'fallen')
        ORDER BY step_number ASC LIMIT 1`,
    ).get(t.project_id, t.step_number) as { step_number: number; title: string } | undefined;
    if (!openEarlier) return `step ${t.step_number} of ${t.total_steps}`;
    return `step ${t.step_number} of ${t.total_steps}; step ${openEarlier.step_number} '${openEarlier.title.slice(0, 40)}' still open`;
  } catch {
    return '';
  }
}
