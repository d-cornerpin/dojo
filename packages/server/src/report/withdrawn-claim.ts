// Is the report behind this answer still standing? `dojo_report` writes no `deliveries` row, so a stamp has
// no edge to its card; the binding is the id `createReport` minted (8 hex chars) in this agent's rows, never
// a phrase. `agent/v2/answered-edge.ts` imports this; this owns report validity only and knows no stamps.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import type { ReportStatus } from './store.js';

const logger = createLogger('withdrawn-claim');

/** States where the artefact stands; `drafting`, `cancelled` and anything unrecognised are withdrawn. */
const STANDING_REPORT_STATUSES: readonly ReportStatus[] = ['awaiting_approval', 'approved', 'posted'];

// Two statements, not an `OR`, so each arm keeps its index; literal SQL, which the SQL gate prepares.
const REPORTS_NAMED_IN_TURNS = `SELECT DISTINCT r.id AS id, r.status AS status
         FROM messages m
         JOIN dojo_reports r ON r.agent_id = ?
                            AND m.content LIKE '%' || substr(r.id, 1, 8) || '%'
        WHERE m.agent_id = ? AND m.turn_number BETWEEN ? AND ?
          AND m.role IN ('assistant', 'tool')`;
const REPORTS_NAMED_IN_SPAN = `SELECT DISTINCT r.id AS id, r.status AS status
         FROM messages m
         JOIN dojo_reports r ON r.agent_id = ?
                            AND m.content LIKE '%' || substr(r.id, 1, 8) || '%'
        WHERE m.agent_id = ? AND m.seq >= ? AND m.seq <= ?
          AND m.role IN ('assistant', 'tool')`;

const REPORTS_BOUND_TO_ASK = `SELECT r.id AS id, r.status AS status
         FROM dojo_reports r
        WHERE r.agent_id = ? AND r.ask_id = ?`;

const ASK_ROW_ID = `SELECT id FROM messages WHERE agent_id = ? AND seq = ? LIMIT 1`;

// Measured: 1 catches a no-id restatement one turn after the work; 2 starts voiding unrelated asks.
const TURNS_BACK = 1;

/** No non-standing row, nothing to void. `NOT IN`: `IN` cannot name "unrecognised". No table, no reports. */
function agentHasWithdrawnReport(agentId: string): boolean {
  const marks = STANDING_REPORT_STATUSES.map(() => '?').join(', ');
  try {
    return getDb().prepare(
      `SELECT 1 AS ok FROM dojo_reports
        WHERE agent_id = ? AND status NOT IN (${marks}) LIMIT 1`,
    ).get(agentId, ...STANDING_REPORT_STATUSES) !== undefined;
  } catch {
    return false;
  }
}

const legacyReported = new Set<string>();
function tolerateLegacy(agentId: string): void {
  if (legacyReported.has(agentId)) return;
  legacyReported.add(agentId);
  logger.info(
    'withdrawn-claim: no report row names this ask, so the containment window decides it '
    + '(rows predating migration 183 carry no `ask_id`, and nothing backfills one)',
    { agentId },
  );
}

/** Does the answer this stamp points at still stand? `false` only when report rows are named in the window
 *  and all are withdrawn. A row bound by `ask_id` (from `askIdForNow`) is conclusive; else the window is
 *  agent-scoped containment (the stamp's turn and the one before, plus rows between ask and answer), which
 *  over-voids by design: never under-void. The span arm covers calls on turn N stamped at N+1; the turn arm
 *  reaches past the answer because call rows can be written after it. */
export function answerStillStands(
  agentId: string, askSeq: number, answerMessageId: string | null | undefined,
): boolean {
  if (!agentHasWithdrawnReport(agentId)) return true;
  if (!answerMessageId) return true;
  let named: Array<{ id: string; status: string }>;
  try {
    const db = getDb();
    const ans = db.prepare(
      'SELECT seq, turn_number AS turn FROM messages WHERE id = ? AND agent_id = ?',
    ).get(answerMessageId, agentId) as { seq: number; turn: number | null } | undefined;
    if (!ans) return true;
    const arm = (sql: string, params: unknown[]): Array<{ id: string; status: string }> =>
      db.prepare(sql).all(...params as never[]) as Array<{ id: string; status: string }>;

    const askRow = db.prepare(ASK_ROW_ID).get(agentId, askSeq) as { id: string } | undefined;
    if (askRow !== undefined) {
      const bound = arm(REPORTS_BOUND_TO_ASK, [agentId, askRow.id]);
      if (bound.length > 0) {
        return bound.some((r) => (STANDING_REPORT_STATUSES as readonly string[]).includes(r.status));
      }
    }

    tolerateLegacy(agentId);
    named = ans.turn === null ? []
      : arm(REPORTS_NAMED_IN_TURNS, [agentId, agentId, ans.turn - TURNS_BACK, ans.turn]);
    named = named.concat(arm(REPORTS_NAMED_IN_SPAN, [agentId, agentId, askSeq, ans.seq]));
  } catch (err) {
    // FAIL OPEN, loudly: a throw is the instrument failing. Failing closed would void every answered ask
    // on the agent (all answered-edge reads filter through this); failing open loses only the check.
    logger.error(
      'withdrawn-claim: the withdrawn-report check could not run, so this answer stamp STANDS '
      + '(pre-fix behaviour) — until this is fixed a cancelled report card can be asserted as live',
      { askSeq, answerMessageId, error: err instanceof Error ? err.message : String(err) },
      agentId,
    );
    return true;
  }
  if (named.length === 0) return true;
  return named.some((r) => (STANDING_REPORT_STATUSES as readonly string[]).includes(r.status));
}
