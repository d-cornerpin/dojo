// v3.5 DONE IS MEASURED — the async half of a task's measure, at the work verbs' door
// (`agent/tools/cat/tracker.ts`), because reading a mailbox is I/O and the tracker's handlers are
// synchronous. It validates the wire value, holds the measure to the same wall the executor holds
// the agent's own call to (a measure is a read made on the agent's behalf, so a read the agent
// may not make, the engine does not make for it), and reads it. `tracker/measure-gate.ts` stores
// and judges what this reads.
import { getDb } from '../../../db/connection.js';
import { parseMeasure, countMeasure, type Measure, type MeasureCount } from '../../../work/measure.js';
import { recordMeasured } from '../../../work/ledger-store.js';
import { editMeasure, remainderRefusal, type MeasureReading } from '../../../tracker/measure-gate.js';
import { resolveAgentTaskId } from '../../agent-task.js';
import { handedInExpr } from '../../../work/tracker-view.js';
import { gatesForCall } from '../gates.js';
import { evaluateGate } from '../gate-eval.js';

const agentNameOf = (agentId: string): string =>
  (getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined)?.name ?? agentId;

/** The executor's own refusal for this read, or null when the agent may make it. */
async function refusalFor(agentId: string, m: Measure): Promise<string | null> {
  const args = m.args as Record<string, unknown>;
  for (const gate of gatesForCall(m.tool, args)) {
    // eslint-disable-next-line no-await-in-loop -- the gates are evaluated in their declared order, as the executor does
    const { verdict } = await evaluateGate(gate, { agentId, name: m.tool, args, resolveRef: () => null });
    if (!verdict.allowed) return verdict.blockedMessage;
  }
  return null;
}

/** A `measure` on work_open / work_update(edit): absent → {}; refused → { error }; else read once. */
export async function readMeasureArg(agentId: string, raw: unknown): Promise<{ reading?: MeasureReading; error?: string }> {
  if (raw === undefined || raw === null) return {};
  const parsed = parseMeasure(raw);
  if (!parsed.ok) return { error: `Error: ${parsed.error}` };
  const refused = await refusalFor(agentId, parsed.measure);
  if (refused) return { error: refused };
  const count = await countMeasure(parsed.measure, agentId, agentNameOf(agentId));
  // Re-review 2 (S2): a measure that reads 0 when it is set has counted nothing, so it can never show
  // progress (a wrong folder, a pattern in the wrong case, a query that matches nothing); left standing,
  // its 0 would read as done. Refused with the fact; never coaching.
  // A 0 with folders it could not read is not a 0 (re-review 3, M4): it is set as a reading not made.
  if (count.ok && count.count === 0 && !count.unreadable?.length) return { error: `Error: ${MEASURE_READS_ZERO}.` };
  return { reading: { measure: parsed.measure, count, at: Date.now() } };
}

/** The fact a measure refused at set time is told. */
export const MEASURE_READS_ZERO = 'this measure reads 0 now, so it cannot show progress; check the folder, pattern or query';

/** One gated count (re-review 2, S10): the measure's own tool gates for `agentId`, then the count. Every
 *  count goes through here: at set (above), at a close (`remeasureTask`) and at the end of a turn
 *  (`post-call-classify/job-turn-end.ts`), so a read that agent may no longer make is never made. */
export async function gatedMeasureCount(m: Measure, agentId: string): Promise<MeasureCount> {
  const refused = await refusalFor(agentId, m);
  return refused ? { ok: false, error: refused } : countMeasure(m, agentId, agentNameOf(agentId));
}

/** A close of a measured task re-reads its measure first; the close door judges that reading.
 *  The read is made AS THE TASK'S OWN AGENT, whoever closes (the agent, the PM, an apprentice's
 *  parent): it is that agent's job and that agent's mailbox, and it is held to the same wall as when
 *  it was set, so a read that agent may no longer make is not made, and is recorded as a reading
 *  that could not be taken (which never refuses the close). */
export async function remeasureTask(_closer: string, taskId: string | null): Promise<void> {
  if (!taskId) return;
  const row = getDb().prepare('SELECT measure_json, agent_id FROM work WHERE id = ?').get(taskId) as { measure_json: string | null; agent_id: string } | undefined;
  if (!row?.measure_json) return;
  let raw: unknown;
  try { raw = JSON.parse(row.measure_json); } catch { return; }
  const parsed = parseMeasure(raw);
  if (!parsed.ok) return;
  recordMeasured(taskId, await gatedMeasureCount(parsed.measure, row.agent_id), Date.now());
}

export async function editWithMeasure(
  agentId: string, args: Record<string, unknown>, hasFields: boolean, edit: () => string,
): Promise<{ content: string; isError: boolean }> {
  const measured = await readMeasureArg(agentId, args.measure);
  if (measured.error) return { content: measured.error, isError: true };
  if (!measured.reading) return { content: edit(), isError: false };
  const content = hasFields ? edit() : '';
  if (content.startsWith('Error')) return { content, isError: true };
  const m = editMeasure(agentId, String(args.task_id), measured.reading);
  if ('error' in m) return { content: m.error, isError: true };
  return { content: hasFields ? `${content}\n${m.line}` : `[OK] task_id=${String(args.task_id)}\n\n${m.line}`, isError: false };
}

/** complete_task(status="complete"), before the agent is ended: its task is re-read and judged like
 *  any close. A task already closed, or carrying a close request (it crossed a door that judged it),
 *  is not judged again. complete_task takes no remainder, so the refusal names the door that does. */
export async function completeTaskRefusal(agentId: string): Promise<string | null> {
  const taskId = resolveAgentTaskId(agentId);
  if (!taskId) return null;
  const row = getDb().prepare(`SELECT w.state AS state, ${handedInExpr('w')} AS pending FROM work w WHERE w.id = ?`)
    .get(taskId) as { state: string; pending: number } | undefined;
  if (!row || row.pending === 1 || !['claimed', 'open'].includes(row.state)) return null;
  await remeasureTask(agentId, taskId);
  return remainderRefusal(taskId, 'complete_task(status="complete")');
}
