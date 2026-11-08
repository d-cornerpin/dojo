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
// carried task; otherwise the claimed, unpaused task the turn is working (`workingTaskOrder`, the
// effort meter's pick: most recently updated, a filed close last, the earlier step on a tie). A task that really left `claimed`, or was paused, is no longer the job; a status
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
import { taskScope, workingTaskOrder } from '../../../../work/tracker-view.js';
import { parseMeasure, type Measure } from '../../../../work/measure.js';
import { ledgerNewItemsSince, recordMeasured } from '../../../../work/ledger-store.js';
import { jobCarriedIds, runCarriesJob } from '../../../../work/task-freshness.js';
import { lastTurnEnd } from '../../../../work/job-momentum.js';
import { novelCallsInTurn } from '../../../../tracker/effort-ledger.js';
import { succeededIn } from '../../../../work/ledger-store.js';
import { toolOpKey } from '../../../../tools/work-verbs.js';
import { normalizeTaskStatus } from '../../../../tracker/task-status-words.js';
import type { ToolCall } from '@dojo/shared';
import type { AgentTurnState } from '../../state.js';
import type { PostCallClassifyContext } from './index.js';
import { heldExpr } from '../../../../work/done/hold.js';

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
    WHERE ${taskScope('w')} AND w.agent_id = ? AND w.state = 'claimed' AND w.is_paused = 0 AND NOT ${heldExpr('w')} ${only}
    ORDER BY ${workingTaskOrder('w')} LIMIT 1
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
    // Re-review 2 (S10): the same gates as at set and at close. Loaded here, not at import, so this step
    // takes no module edge onto the tool layer.
    const { gatedMeasureCount } = await import('../../../tools/cat/measure-door.js');
    const count = await gatedMeasureCount(facts.measure, ctx.agentId);
    recordMeasured(facts.taskId, count, Date.now(), { keepStoredOnFailure: true });
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

/** A status call that is a door to the owner: "paused" (waiting on him) or "blocked", on ANY task. */
const isDoorCall = (tc: Pick<ToolCall, 'name' | 'arguments'>): boolean =>
  toolOpKey(tc.name, tc.arguments) === 'work_update:status'
  && ['paused', 'blocked'].includes(normalizeTaskStatus((tc.arguments as { status?: unknown } | undefined)?.status) ?? '');

/** The calls this TURN made, every pass of it, from the turn's own record: the assistant rows the post-call
 *  step persists for each pass (`persist-assistant.ts`, one `tool_use` block per call, stamped with the
 *  turn's number; the same rows `execute/tracker-floors.ts` tallies). Never `state.toolCalls`: each pass's
 *  model call REPLACES that with the pass's own calls (`call-llm/index.ts`), so a door an earlier pass took
 *  is gone from it by the pass that speaks (fix round 4). The results ride `state.toolResults`, which
 *  execute APPENDS for the whole turn, and are joined by call id. */
function callsThisTurn(agentId: string, turnNumber: number, db: Database): ToolCall[] {
  const rows = db.prepare(`SELECT content FROM messages WHERE agent_id = ? AND turn_number = ? AND role = 'assistant' AND content LIKE '[{%'`)
    .all(agentId, turnNumber) as Array<{ content: string }>;
  const calls: ToolCall[] = [];
  for (const r of rows) {
    try {
      for (const b of JSON.parse(r.content) as Array<{ type?: string; id?: string; name?: string; input?: Record<string, unknown> }>) {
        if (b.type === 'tool_use' && b.id && b.name) calls.push({ id: b.id, name: b.name, arguments: b.input ?? {} } as ToolCall);
      }
    } catch { /* not a block array */ }
  }
  return calls;
}

/** Does this turn speak to the owner whatever the job is doing? (fix round 2, ruling 1): an answer to a
 *  person who is waiting; a door call riding THIS pass (judged before it runs, so an attempt resolves
 *  toward answering); or a door call an EARLIER pass of this turn made that succeeded, on any task. */
function speaksThisTurn(state: AgentTurnState, ctx: Pick<PostCallClassifyContext, 'agentId' | 'db' | 'turnNumber' | 'hasUnansweredUser' | 'triggerRow' | 'result'>): boolean {
  if (ctx.hasUnansweredUser || ctx.triggerRow) return true;
  if ((ctx.result?.toolCalls ?? []).some(isDoorCall)) return true;
  const ok = succeededIn(state.toolResults as unknown as Parameters<typeof succeededIn>[0]);
  return callsThisTurn(ctx.agentId, ctx.turnNumber, ctx.db).some((tc) => isDoorCall(tc) && ok(tc));
}

/** Is this pass the engine's continuation of a measured job that still has items left, with nothing
 *  the owner must hear? (R4) While it is, the pass's text is plain progress and stays on the record.
 *  The owner hears from the job when it is finished (the reading is 0), when it stalls (the `stalled`
 *  path to the PM), when the agent asks him or reports a blocker through the tracker's doors on any
 *  task ("paused" waiting on him, "blocked"), or when the turn answers him: those speak under the
 *  existing rules for an engine turn. The stop rule (`job-continues.ts`) is a different question: the
 *  job itself keeps continuing unless its own task really leaves `claimed`. */
export function continuedJobStillGoing(state: AgentTurnState, ctx: Pick<PostCallClassifyContext, 'agentId' | 'db' | 'turnNumber' | 'hasUnansweredUser' | 'triggerRow' | 'result'>): boolean {
  if (!runCarriesJob(ctx.agentId)) return false;   // only the run the park's own wake started
  if (speaksThisTurn(state, ctx)) return false;
  const job = jobAtPassEndNow(state, ctx);
  if (!job?.measure || job.remaining === null || job.remaining <= 0) return false;
  return lastTurnEnd(job.taskId)?.kind === 'continued';
}
