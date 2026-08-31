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
import { taskScope } from '../work/tracker-view.js';
import { stampTicket } from '../work/tracker-store.js';
// T19 (D7): the declared set of bubbles the platform has already ruled not-an-answer. Read,
// never retyped — same owner as `work/occurrences.ts` and `agent/v2/answered-edge.ts`.
import { NON_ANSWERING_DISPLAY_KINDS } from '../work/ask-settlement.js';

const logger = createLogger('task-stamps');

function relAgoFromNow(sqliteUtc: string | null): string {
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

/** The same fact with no clock in it: the recorded instant, minute precision, UTC. Pure in
 *  its argument, which is the whole point — see `renderTaskStamps`' header. */
function absInstant(sqliteUtc: string | null): string {
  if (!sqliteUtc) return '';
  const ms = Date.parse(sqliteUtc.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(ms)) return '';
  return `at ${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

/**
 * ⚠ UX-REPAIR ROUND 4 T19 (D7) — THE CHANNELS A SUMMARY MAY NAME WITHOUT LICENSING A CLOSE.
 *
 * The TANGIBILITY RULE has its own incident and it is not being narrowed here. Battery catch
 * 2026-07-22: *"A reply without a recorded delivery is often just an ack ('back with you
 * soon'); nudging CLOSE on it strangled a delegation synthesis task mid-wait."* Four consumers
 * read "is `last_delivery_summary` set" and every one of them MEANS "is there a tangible
 * handover" — the CLOSE-if-done nudge below, the ALREADY-DELIVERED block
 * (`tracker/tools.ts`), the close-out gate's evidence consult, and the strike-0 same-turn
 * close (`steps/teardown/finalize-record.ts`).
 *
 * The defect D7 fixes is a different one: the summary EXCLUDED the dashboard outright, so a
 * reminder the owner read in chat was stamped `(no delivery recorded)` for ever. On
 * 2026-08-10 13:45Z the model read ONE tool result carrying both that line and
 * `[ENGINE RECORD: this task's work appears ALREADY DELIVERED …]` (which does NOT exclude the
 * dashboard) and spent ~700 words of reasoning trying to reconcile them.
 *
 * So the summary becomes TRUE without becoming a licence: a dashboard-or-voice-only delivery
 * is NAMED, as one of these declared values, and `isTangibleDeliverySummary` reports it as not
 * a handover. One writer, one reader, exact strings, a closed set — never a prose test, and
 * never a second copy of the rule.
 */
export const NON_TANGIBLE_DELIVERY_SUMMARIES: readonly string[] = ['via dashboard', 'via voice'];

/** Does this stored summary describe a TANGIBLE handover — the 2026-07-22 standard, unchanged?
 *  The ONE predicate every consumer of the finished-work question asks. */
export function isTangibleDeliverySummary(summary: string | null | undefined): boolean {
  return !!summary && !NON_TANGIBLE_DELIVERY_SUMMARIES.includes(summary);
}

/** Compose the compact delivery summary for a turn from its delivery and
 *  artifact records. Empty string when the turn delivered nothing.
 *
 *  Two halves, in order: the TANGIBLE handover (files, out-of-band channels) exactly as
 *  before; and, only when there is no tangible handover at all, the honest naming of a
 *  dashboard/voice message the person actually read — see `NON_TANGIBLE_DELIVERY_SUMMARIES`.
 *  A chip is not a message: the dashboard half asks the same declared set
 *  (`NON_ANSWERING_DISPLAY_KINDS`) that the deliverable authority and the turn-receipt reader
 *  ask, so a `tool-turn` or `working-note` receipt names nothing. */
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
    if (parts.length > 0) return parts.join('; ').slice(0, 120);
    // T19 (D7): no tangible handover — but the person may still have READ something. Name it
    // truthfully, as one of the declared non-tangible values, so `(no delivery recorded)`
    // means what it says. Chips excluded by the same set the deliverable authority reads.
    const chipKinds = NON_ANSWERING_DISPLAY_KINDS.map((k) => `'${k}'`).join(', ');
    const seen = db.prepare(
      `SELECT DISTINCT d.channel AS channel FROM deliveries d
        WHERE d.agent_id = ? AND d.turn_number = ? AND d.outcome = 'delivered'
          AND d.channel IN ('dashboard', 'voice')
          AND NOT EXISTS (SELECT 1 FROM messages m
                           WHERE m.id = d.message_id AND m.display_kind IN (${chipKinds}))`,
    ).all(agentId, turnNumber) as Array<{ channel: string }>;
    const named = NON_TANGIBLE_DELIVERY_SUMMARIES
      .find((s) => seen.some((c) => s === `via ${c.channel}`));
    return named ?? '';
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
      `SELECT w.id AS id FROM work w
        WHERE ${taskScope('w')}
          AND w.agent_id = ?
          AND w.state IN ('claimed', 'on_deck', 'blocked')
          AND (
            (w.source_message_id IS NOT NULL AND w.source_message_id = ?)
            OR (w.origin_conv_key IS NOT NULL AND w.origin_conv_key = ?)
            OR w.origin_turn = ?
            OR w.id = ?
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
    //
    // PHASE-2 T8b: on `work`, and TWO columns are gone rather than moved.
    // `last_answer_message_id` and `last_delivery_at` had exactly one occurrence each in
    // production — this statement — and it was a COALESCE onto themselves, i.e. a write
    // that read the column only to preserve it. Migration `137` therefore did not carry
    // them (T8a report §2.3c enumerates every occurrence; #15: proven by enumeration, never
    // by absence). Writing a column nobody reads is the accretion this phase removes, so
    // the two assignments are deleted here with their column.
    //   requirement preserved: "the ticket records which message answered it, and when it
    //   was last delivered to" — `last_answered_turn` + `last_answered_at` +
    //   `last_delivery_summary` carry both facts and DO have readers; the answer MESSAGE id
    //   is `deliveries.message_id` on the row this turn's delivery already wrote (T5).
    const stampMs = Date.now();
    for (const t of tied) {
      stampTicket(t.id, {
        activityTurn: input.turnNumber,
        activityAt: stampMs,
        activityOutcome: input.outcome,
        answeredTurn: answered ? input.turnNumber : null,
        answeredAt: answered ? stampMs : null,
        deliverySummary: hasDelivery ? deliverySummary : null,
      });
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

/**
 * T67b — THE AGE IS RELATIVE FOR A TOOL RESULT AND AN INSTANT FOR THE PREFIX.
 *
 * `relAgo` is a clock read, so a caller that renders this line INSIDE the cacheable message
 * region re-bills every cached token behind it once a minute with no tracker row changed —
 * `lane.active-tasks` (MessageSlot.ActiveTasks = 600) was doing exactly that. It passes
 * `{ relative: false }` and gets the recorded instant instead. Every other caller here is a
 * tool result or a PM report — 0 prefix bytes — and keeps the relative form, which is the
 * more readable one and the reason it exists.
 *
 * The instant form is the HL5 snapshot's own answer to this question (`memory/recall-lane.ts`:
 * "an ISO instant is unambiguous, costs six words, and cannot disagree with the clock lane").
 */
export interface TaskStampOptions {
  /** false renders the recorded instant instead of "10m ago". Default true. */
  relative?: boolean;
}

/** The one compact stamp line the model reads (<=~90 chars typical).
 *  Owner ruling: facts PLUS instruction on answered tickets. */
export function renderTaskStamps(t: TaskStampFields, opts?: TaskStampOptions): string {
  const relAgo = opts?.relative === false ? absInstant : relAgoFromNow;
  if (t.last_answered_turn !== null && t.last_answered_at) {
    // The CLOSE instruction requires a TANGIBLE handover on record, the same
    // standard as the strike-2 engine close. A reply without a recorded
    // delivery is often just an ack ("back with you soon"); nudging CLOSE on
    // it strangled a delegation synthesis task mid-wait (battery catch,
    // 2026-07-22). Facts only in that case.
    if (isTangibleDeliverySummary(t.last_delivery_summary)) {
      return `answered T${t.last_answered_turn} ${relAgo(t.last_answered_at)}; ${t.last_delivery_summary}; CLOSE if done`;
    }
    // T19 (D7): "facts only" used to mean "(no delivery recorded)", which on the owner's
    // primary channel was FALSE — and the model read it in the same tool result as an
    // ALREADY-DELIVERED assertion built from the same window. Facts only still means facts
    // only; it now means the TRUE ones.
    if (t.last_delivery_summary) {
      return `answered T${t.last_answered_turn} ${relAgo(t.last_answered_at)}; ${t.last_delivery_summary}`;
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
      `SELECT w.step_number AS step_number, w.title AS title FROM work w
        WHERE ${taskScope('w')}
          AND w.parent_id = ? AND w.step_number IS NOT NULL AND w.step_number < ?
          AND w.state NOT IN ('done', 'failed')
        ORDER BY w.step_number ASC LIMIT 1`,
    ).get(t.project_id, t.step_number) as { step_number: number; title: string } | undefined;
    if (!openEarlier) return `step ${t.step_number} of ${t.total_steps}`;
    return `step ${t.step_number} of ${t.total_steps}; step ${openEarlier.step_number} '${openEarlier.title.slice(0, 40)}' still open`;
  } catch {
    return '';
  }
}
