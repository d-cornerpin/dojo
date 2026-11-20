// Where a measured job stands at the end of a pass: one reading, shared by the close-out floors, the job's
// continuation and the checkpoint window, which must agree within a pass.

import type { Database } from 'better-sqlite3';
import { getDb } from '../../../../db/connection.js';
import { taskScope, workingTaskOrder } from '../../../../work/tracker-view.js';
import { parseMeasure, type Measure } from '../../../../work/measure.js';
import { ledgerNewItemsSince, recordMeasured } from '../../../../work/ledger-store.js';
import { freshResults } from '../../repeat-rule.js';
import type { AgentTurnState } from '../../state.js';
import type { PostCallClassifyContext } from './index.js';
import { heldExpr, workingExpr } from '../../../../work/done/hold.js';
import { personArrivedSince } from '../../counterparty.js';
import { turnContext } from '../../../turn-context.js';

export interface JobAtPassEnd {
  taskId: string;
  measure: Measure | null;
  /** The measure's count (fresh when re-counted, else stored); null when unmeasured or never read. */
  remaining: number | null;
  touchedThisTurn: number;
  novelCallsThisTurn: number;
  openedThisTurn: boolean;
  momentum: boolean;
}

type TaskRow = { id: string; measureJson: string | null; stored: number | null };

/** The job's task: on a job turn the task it was started from, else the claimed unpaused task being worked. */
export function jobTaskOf(agentId: string, db: Database): TaskRow | null {
  const served = turnContext(agentId)?.servedJob;
  const only = served ? 'AND w.id = ?' : '';
  return (db.prepare(`
    SELECT w.id AS id, w.measure_json AS measureJson, w.measure_remaining AS stored FROM work w
    WHERE ${taskScope('w')} AND w.agent_id = ? AND ${workingExpr('w')} AND w.is_paused = 0 AND NOT ${heldExpr('w')} ${only}
    ORDER BY ${workingTaskOrder('w')} LIMIT 1
  `).get(agentId, ...(served ? [served] : [])) as TaskRow | undefined) ?? null;
}

function measureOf(json: string | null): Measure | null {
  if (!json) return null;
  try { const p = parseMeasure(JSON.parse(json)); return p.ok ? p.measure : null; } catch { return null; }
}

/** The records now, no count. Momentum: a new item touched, a work result new to the window, or the task opened. */
function storedFacts(state: AgentTurnState, agentId: string, db: Database): JobAtPassEnd | null {
  const task = jobTaskOf(agentId, db);
  if (!task) return null;
  const touchedThisTurn = ledgerNewItemsSince(task.id, state.turnStartMs);
  const novelCallsThisTurn = freshResults(agentId, turnContext(agentId));
  const openedThisTurn = !!db.prepare(`SELECT 1 FROM work_events WHERE work_id = ? AND kind = 'opened' AND created_at >= ? LIMIT 1`).get(task.id, state.turnStartMs);
  const measure = measureOf(task.measureJson);
  return {
    taskId: task.id, measure, remaining: measure ? task.stored : null, touchedThisTurn, novelCallsThisTurn, openedThisTurn,
    momentum: touchedThisTurn > 0 || novelCallsThisTurn > 0 || openedThisTurn,
  };
}

/** The job's momentum as one count that only grows within a turn. A job turn whose task is no longer working is
 *  measured by the repeat rule's own count; any other task-less turn has no measure and checkpoints as before. */
export function jobProgressMark(state: AgentTurnState, agentId: string, db: Database): number {
  const f = storedFacts(state, agentId, db);
  if (f) return f.touchedThisTurn + f.novelCallsThisTurn + (f.openedThisTurn ? 1 : 0);
  return turnContext(agentId)?.servedJob ? freshResults(agentId, turnContext(agentId)) : 0;
}

/** Did this stretch of the turn move the job (the progress test the window renews on)? */
export function stretchMoved(state: AgentTurnState, agentId: string): boolean {
  return jobProgressMark(state, agentId, getDb()) > (state.checkpointWindow?.mark ?? 0);
}

/** May the turn take pass `loopCount + ahead`? Open inside the window (75 passes, 15 minutes); at its end it
 *  renews if the job moved and no person waits behind this turn, else the turn checkpoints, as it always
 *  does after 200 tool calls or 500 passes. A job's own turn, or one serving no person, ends its stretch at
 *  the next step when a person waits behind it. */
export function turnWindow(state: AgentTurnState, agentId: string, ahead = 0): 'open' | 'renew' | 'checkpoint' {
  const w = state.checkpointWindow ?? { atLoop: 0, atMs: state.turnStartMs, mark: 0 };
  if (state.toolCallsExecutedThisTurn >= 200 || state.loopCount + ahead > 500) return 'checkpoint';
  if (personWaitsBehind(agentId)) return 'checkpoint';
  if (state.loopCount + ahead - w.atLoop <= 75 && Date.now() - w.atMs <= 15 * 60_000) return 'open';
  return jobProgressMark(state, agentId, getDb()) > w.mark && !personWaitsBehind(agentId, true) ? 'renew' : 'checkpoint';
}

/** A person wrote since this turn's pickup, behind a job's own turn or a turn serving no person (`anyTurn`: behind
 *  any turn); its stretch ends at the next step. */
export function personWaitsBehind(agentId: string, anyTurn = false): boolean {
  const turn = turnContext(agentId);
  return (anyTurn || !turn?.convKey || !!turn.servedJob) && personArrivedSince(agentId, turn?.pickupSeq ?? 0, turn?.convKey ?? null);
}

const memo = new Map<string, { key: string; facts: JobAtPassEnd | null }>();
const passKey = (state: AgentTurnState): string => `${state.turnStartMs}:${state.loopCount}`;

/** Where the job stands at the end of this pass, read once (the re-count included) and shared. */
export async function readJobAtPassEnd(state: AgentTurnState, ctx: Pick<PostCallClassifyContext, 'agentId' | 'db' | 'agent' | 'result'>): Promise<JobAtPassEnd | null> {
  const hit = memo.get(ctx.agentId);
  if (hit?.key === passKey(state)) return hit.facts;
  const facts = storedFacts(state, ctx.agentId, ctx.db);
  if (facts?.measure && facts.momentum && ctx.result.toolCalls.length === 0) {
    // Re-counted only on a terminal pass with momentum, through the same gates as at set and close.
    // Loaded here, not at import, so this step takes no module edge onto the tool layer.
    const { gatedMeasureCount } = await import('../../../tools/cat/measure-door.js');
    const count = await gatedMeasureCount(facts.measure, ctx.agentId);
    recordMeasured(facts.taskId, count, Date.now(), { keepStoredOnFailure: true });
    if (count.ok) facts.remaining = count.count;
  }
  memo.set(ctx.agentId, { key: passKey(state), facts });
  return facts;
}
