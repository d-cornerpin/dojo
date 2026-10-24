// ════════════════════════════════════════
// v3.5 D1 — WHERE A MEASURED JOB STANDS AT THE END OF A PASS: one reading, shared by everything
// that asks. Three readers ask in one pass, and they must agree:
//   · terminal-text.ts — may a held line be promoted to the owner as an answer? (not while the job is going);
//   · closeout-floors.ts — is this pass's closing text progress (a working note) or a result? (R4);
//   · job-continues.ts — park and continue, record a stall, or leave it to the detector? (D1).
// Before this module the demotion read the PREVIOUS turn's reading while the continuation rule
// re-counted, so the turn that finished a job had its one result kept as a note (fix round 1, I2).
//
// THE JOB'S TASK (one pick, `jobTaskOf`): on the run the park's own wake started, the job's own
// carried task; otherwise the agent's most recently updated claimed, unpaused task (the effort
// meter's pick). A task that really left `claimed`, or was paused, is no longer the job; a status
// call that was refused or failed, or a move on another task, changes nothing here (fix round 1, I1).
//
// MOMENTUM (owner 2026-10-19, refined by the orchestrator in fix round 1): this turn touched an item
// the task had never touched (`ledgerNewItemsSince`; a re-touch is a loop, not progress), OR made a
// call the task had never made AND IT SUCCEEDED (`novelCallsInTurn`; a new failing call is not
// progress), OR opened the task (the job's start: an owner turn that only says "on it" has begun it).
//
// THE RE-COUNT runs once per pass, only on a terminal pass (no tool calls: the turn is ending), and
// only when the turn had momentum: a measure is a mailbox paging (hundreds of ids per page), and a
// turn that moved nothing cannot have changed what it lists by its own work, so the stored reading
// stands for it. A count that cannot be read keeps the stored one (and says so on the record).
// ════════════════════════════════════════

import type { Database } from 'better-sqlite3';
import { taskScope } from '../../../../work/tracker-view.js';
import { countMeasure, parseMeasure, type Measure } from '../../../../work/measure.js';
import { ledgerNewItemsSince, recordMeasured } from '../../../../work/ledger-store.js';
import { jobCarriedIds, runCarriesJob } from '../../../../work/task-freshness.js';
import { lastTurnEnd } from '../../../../work/job-momentum.js';
import { novelCallsInTurn } from '../../../../tracker/effort-ledger.js';
import type { AgentTurnState } from '../../state.js';
import type { PostCallClassifyContext } from './index.js';

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

/** The job's task (see the header). */
export function jobTaskOf(agentId: string, db: Database): TaskRow | null {
  const carried = runCarriesJob(agentId) ? jobCarriedIds(agentId) : null;
  if (carried && carried.length === 0) return null;
  const only = carried ? `AND w.id IN (${carried.map(() => '?').join(', ')})` : '';
  return (db.prepare(`
    SELECT w.id AS id, w.measure_json AS measureJson, w.measure_remaining AS stored FROM work w
    WHERE ${taskScope('w')} AND w.agent_id = ? AND w.state = 'claimed' AND w.is_paused = 0 ${only}
    ORDER BY w.updated_at DESC, w.rowid DESC LIMIT 1
  `).get(agentId, ...(carried ?? [])) as TaskRow | undefined) ?? null;
}

function measureOf(json: string | null): Measure | null {
  if (!json) return null;
  try { const p = parseMeasure(JSON.parse(json)); return p.ok ? p.measure : null; } catch { return null; }
}

/** What the records say now, without a count. */
function storedFacts(state: AgentTurnState, agentId: string, db: Database): JobAtPassEnd | null {
  const task = jobTaskOf(agentId, db);
  if (!task) return null;
  const touchedThisTurn = ledgerNewItemsSince(task.id, state.turnStartMs);
  const novelCallsThisTurn = novelCallsInTurn(task.id, state.turnStartMs);
  const openedThisTurn = !!db.prepare(`SELECT 1 FROM work_events WHERE work_id = ? AND kind = 'opened' AND created_at >= ? LIMIT 1`).get(task.id, state.turnStartMs);
  const measure = measureOf(task.measureJson);
  return {
    taskId: task.id, measure, remaining: measure ? task.stored : null, touchedThisTurn, novelCallsThisTurn, openedThisTurn,
    momentum: touchedThisTurn > 0 || novelCallsThisTurn > 0 || openedThisTurn,
  };
}

const memo = new Map<string, { key: string; facts: JobAtPassEnd | null }>();
const passKey = (state: AgentTurnState): string => `${state.turnStartMs}:${state.loopCount}`;

/** Where the job stands at the end of this pass, read once (the re-count included) and shared. */
export async function readJobAtPassEnd(state: AgentTurnState, ctx: Pick<PostCallClassifyContext, 'agentId' | 'db' | 'agent' | 'result'>): Promise<JobAtPassEnd | null> {
  const hit = memo.get(ctx.agentId);
  if (hit?.key === passKey(state)) return hit.facts;
  const facts = storedFacts(state, ctx.agentId, ctx.db);
  if (facts?.measure && facts.momentum && ctx.result.toolCalls.length === 0) {
    const count = await countMeasure(facts.measure, ctx.agentId, ctx.agent.name ?? ctx.agentId);
    recordMeasured(facts.taskId, count, Date.now());
    if (count.ok) facts.remaining = count.count;
  }
  memo.set(ctx.agentId, { key: passKey(state), facts });
  return facts;
}

/** This pass's reading if it was taken, else the records (never a count). */
export function jobAtPassEndNow(state: AgentTurnState, ctx: Pick<PostCallClassifyContext, 'agentId' | 'db'>): JobAtPassEnd | null {
  const hit = memo.get(ctx.agentId);
  return hit?.key === passKey(state) ? hit.facts : storedFacts(state, ctx.agentId, ctx.db);
}

/** Is this pass the engine's continuation of a measured job that still has items left? (R4) While it
 *  is, the turn's text is progress and stays on the record; the owner hears from the job when it is
 *  finished (the reading is 0), when it stalls (the `stalled` path to the PM), or when the agent asks
 *  him or reports a blocker through the tracker's own doors ("paused" waiting on him, "blocked"): the
 *  task then is no longer the job, and the turn speaks under the existing rules for an engine turn. */
export function continuedJobStillGoing(state: AgentTurnState, ctx: Pick<PostCallClassifyContext, 'agentId' | 'db'>): boolean {
  if (!runCarriesJob(ctx.agentId)) return false;   // only the run the park's own wake started
  const job = jobAtPassEndNow(state, ctx);
  if (!job?.measure || job.remaining === null || job.remaining <= 0) return false;
  return lastTurnEnd(job.taskId)?.kind === 'continued';
}
