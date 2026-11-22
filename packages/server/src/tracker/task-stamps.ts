// Task stamps: the engine records what it OBSERVED at ONE point, turn finalize, so "what has been done" comes
// from engine records, never conversation memory. A stamp is one `activity` work event per task (`stampTicket`)
// and touches no work-row column: not `updated_at` (the drive ladder's idle clock), not status, not *_validated.
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { taskScope } from '../work/tracker-view.js';
import { stampTicket } from '../work/tracker-store.js';
import { servedByNotice } from '../work/task-freshness.js';
import { recordTurnOnTasks, tasksServedBy } from '../work/task-turns.js';
import { relAgoFromNow, absInstant } from './task-stamp-time.js';
// The declared set of bubbles ruled not-an-answer: read, never retyped (see `work/occurrences.ts`).
import { NON_ANSWERING_DISPLAY_KINDS } from '../work/ask-settlement.js';
import { workingExpr } from '../work/done/hold.js';

const logger = createLogger('task-stamps');

/**
 * Delivery summaries that name a channel WITHOUT licensing a close: a dashboard or voice only delivery is named
 * so the stamp is true, but it is not a handover (an ack is not one). `isTangibleDeliverySummary` is the one
 * test, read by the ladder re-arm below.
 * A closed set of exact strings: never a prose test.
 */
export const NON_TANGIBLE_DELIVERY_SUMMARIES: readonly string[] = ['via dashboard', 'via voice'];

/** Does this stored summary describe a TANGIBLE handover? The ONE predicate for the finished-work question. */
export function isTangibleDeliverySummary(summary: string | null | undefined): boolean {
  return !!summary && !NON_TANGIBLE_DELIVERY_SUMMARIES.includes(summary);
}

/** Compose the compact delivery summary for a turn ('' when it delivered nothing): the TANGIBLE handover (files,
 *  out-of-band channels) and, only when there is none, a dashboard/voice message the person read. Chips
 *  (`NON_ANSWERING_DISPLAY_KINDS`) are not messages. */
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
    const unique = [...new Set(names)];
    if (unique.length > 0) parts.push(`file ${unique.join(', ')}`);
    // An `a2a` delivery is a HANDOVER only when it went BACK to the requester on that thread: a delegation this
    // agent sent is also `a2a`/`delivered`, and counting it closed the delegating turn's task early. Excluding
    // `a2a` outright would stop an A2A-ASSIGNED task closing on its deliverable.
    const a2aBackToRequester = (): boolean => {
      try {
        return !!db.prepare(
          `SELECT 1 AS hit FROM deliveries d
             JOIN messages sent ON sent.id = d.message_id AND sent.a2a_thread_id IS NOT NULL
             JOIN messages asked ON asked.a2a_thread_id = sent.a2a_thread_id
            WHERE d.agent_id = ? AND d.turn_number = ? AND d.outcome = 'delivered' AND d.channel = 'a2a'
              AND asked.agent_id = d.agent_id AND asked.source_agent_id = d.recipient_id
              AND asked.a2a_intent IN ('ASSIGN', 'QUESTION', 'BLOCK')
            LIMIT 1`,
        ).get(agentId, turnNumber);
      } catch { return false; }   // no proof it went back to the requester: not a handover
    };
    const chans = (db.prepare(
      `SELECT DISTINCT channel FROM deliveries
        WHERE agent_id = ? AND turn_number = ? AND outcome = 'delivered' AND channel NOT IN ('dashboard', 'voice')`,
    ).all(agentId, turnNumber) as Array<{ channel: string }>)
      .filter((c) => c.channel !== 'a2a' || a2aBackToRequester());
    if (chans.length > 0) parts.push(`via ${chans.map((c) => c.channel).join('/')}`);
    if (parts.length > 0) return parts.join('; ').slice(0, 120);
    // No tangible handover, but the person may still have READ something: name it as a declared non-tangible
    // value so `(no delivery recorded)` means what it says. Chips are excluded by the same declared set.
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

/** Did this turn DO something (an effectful tool call, counted on the turn's own row)? */
function turnMadeEffectfulCall(db: ReturnType<typeof getDb>, agentId: string, turnNumber: number, taskId: string | null): boolean {
  try {
    const r = db.prepare(`SELECT effectful_calls AS n, CAST(strftime('%s', started_at) AS INTEGER) * 1000 AS started_ms
        FROM turns WHERE agent_id = ? AND turn_number = ?`)
      .get(agentId, turnNumber) as { n: number | null; started_ms: number | null } | undefined;
    if ((r?.n ?? 0) === 0) return false;
    // Counts as work on THIS task only when it reached the task's own ledger during the turn; counted
    // turn-wide, a poke-woken turn that worked elsewhere re-armed this task's ladder.
    if (!taskId) return true;
    const touched = db.prepare('SELECT 1 FROM work_ledger WHERE work_id = ? AND last_at >= ? LIMIT 1')
      .get(taskId, r?.started_ms ?? 0);
    return !!touched;
  } catch { return false; /* no record of an effect: a turn that only talked */ }
}

/** The single stamping point (`steps/teardown/finalize-record.ts`): stamps every task of THIS agent tied to the
 *  ending turn. Best-effort: never throws into a live finalize. */
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
    // Only work THIS turn's trigger names (a job's own turn names the task it was started from),
    // never by conversation: `input.convKey` kept a same-conversation abandoned task fresh.
    const deliverySummary = composeTurnDeliverySummary(input.agentId, input.turnNumber);
    const hasDelivery = deliverySummary.length > 0;
    // A wake by a re-drive or assignment notice is not progress, and the turn's reply to it is an ANSWER: only a
    // tangible deliverable or an effectful call the turn's record counts (`turns.effectful_calls`) re-arms the ladder.
    const worked = isTangibleDeliverySummary(deliverySummary) || turnMadeEffectfulCall(db, input.agentId, input.turnNumber, input.servedTaskId);
    const woken = !worked && servedByNotice(input.agentId, input.turnNumber, input.servedTaskId) ? input.servedTaskId : null;
    const carried = tasksServedBy(input.agentId, input.turnNumber).filter((id) => id !== woken);
    recordTurnOnTasks(input.agentId, input.turnNumber, [...carried, ...(woken || !input.servedTaskId ? [] : [input.servedTaskId])]);
    const tied = db.prepare(
      `SELECT w.id AS id FROM work w
        WHERE ${taskScope('w')}
          AND w.agent_id = ?
          AND ${workingExpr('w', true)}
          AND (
            (w.source_message_id IS NOT NULL AND w.source_message_id = ?)
            OR w.origin_turn = ?
            OR w.id = ?
            OR w.id IN (${carried.map(() => '?').join(', ') || 'NULL'})
          )
        LIMIT 20`,
    ).all(
      input.agentId,
      input.rootSourceMessageId ?? '',
      input.turnNumber,
      woken ? '' : (input.servedTaskId ?? ''),
      ...carried,
    ) as Array<{ id: string }>;
    if (tied.length === 0) return;

    const answered = input.outcome === 'answered';

    // One `activity` work event per task (`stampTicket`); the answer MESSAGE id is `deliveries.message_id`.
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

/** `relAgo` reads the clock, so a caller inside the cacheable message region passes `{ relative: false }` for the
 *  recorded instant (a changing age would re-bill the cache); tool results and PM reports keep the relative form. */
export interface TaskStampOptions {
  /** false renders the recorded instant instead of "10m ago". Default true. */
  relative?: boolean;
}

/** The one compact stamp line the model reads. FACTS ONLY (what was sent and when); an ack is never completion. */
export function renderTaskStamps(t: TaskStampFields, opts?: TaskStampOptions): string {
  const relAgo = opts?.relative === false ? absInstant : relAgoFromNow;
  if (t.last_answered_turn !== null && t.last_answered_at) {
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

export function renderStepFacts(t: TaskStampFields): string {
  if (!t.project_id || t.step_number === null || t.step_number === undefined || !t.total_steps) return '';
  try {
    const db = getDb();
    const openEarlier = db.prepare(
      `SELECT w.step_number AS step_number, w.title AS title FROM work w
        WHERE ${taskScope('w')}
          AND w.parent_id = ? AND w.step_number IS NOT NULL AND w.step_number < ?
          AND w.state NOT IN ('done', 'failed', 'abandoned')
        ORDER BY w.step_number ASC LIMIT 1`,
    ).get(t.project_id, t.step_number) as { step_number: number; title: string } | undefined;
    if (!openEarlier) return `step ${t.step_number} of ${t.total_steps}`;
    return `step ${t.step_number} of ${t.total_steps}; step ${openEarlier.step_number} '${openEarlier.title.slice(0, 40)}' still open`;
  } catch {
    return '';
  }
}
