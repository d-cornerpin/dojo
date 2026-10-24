// v3.5 DONE IS MEASURED — the async half of a task's measure, at the work verbs' door
// (`agent/tools/cat/tracker.ts`), because reading a mailbox is I/O and the tracker's handlers are
// synchronous. It validates the wire value, holds the measure to the same wall the executor holds
// the agent's own call to (a measure is a read made on the agent's behalf, so a read the agent
// may not make, the engine does not make for it), and reads it. `tracker/measure-gate.ts` stores
// and judges what this reads.
import { getDb } from '../../../db/connection.js';
import { parseMeasure, countMeasure, type Measure } from '../../../work/measure.js';
import { recordMeasured } from '../../../work/ledger-store.js';
import { editMeasure, namedRemainderNote, recordNamedRemainder, measuredOpenTasksOf, type MeasureReading } from '../../../tracker/measure-gate.js';
import { resolveTaskId, resolveProjectId } from '../../../tracker/schema.js';
import { claimedTasksOf } from '../../../tracker/claimed-tasks.js';
import { normalizeTaskStatus } from '../../../tracker/task-status-words.js';
import { withNamedRemainder } from '../../../work/measure-close-gate.js';
import { remainderGate } from '../../../tracker/measure-gate.js';
import { pendingCloseRequestExpr } from '../../../work/tracker-view.js';
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
  return { reading: { measure: parsed.measure, count: await countMeasure(parsed.measure, agentId, agentNameOf(agentId)), at: Date.now() } };
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
  const owner = row.agent_id;
  const refused = await refusalFor(owner, parsed.measure);
  recordMeasured(taskId, refused ? { ok: false, error: refused } : await countMeasure(parsed.measure, owner, agentNameOf(owner)), Date.now());
}

/** Is this status argument a close? The status door's own reading of the word, never a second copy. */
export const isCompleteStatus = (raw: unknown): boolean => normalizeTaskStatus(raw) === 'complete';

// A close LANDS as a transition (the task, or its run, moved) or as a filed close request (the
// two-key `validation_requested` an agent's close becomes). A refused or no-op close writes neither.
const lastTransitionId = (taskId: string): number => (getDb().prepare(
  `SELECT COALESCE(MAX(id), 0) AS n FROM work_events WHERE kind IN ('transition', 'validation_requested')
     AND (work_id = ? OR work_id IN (SELECT id FROM work WHERE parent_id = ?))`,
).get(taskId, taskId) as { n: number }).n;

/** status="complete" / complete_step: re-read, run the synchronous door, and record a named remainder
 *  only once the close has LANDED (the task or its run moved), never on a close refused later. */
export async function closeWithMeasure(agentId: string, taskId: string | null, args: Record<string, unknown>, close: () => string): Promise<string> {
  await remeasureTask(agentId, taskId);
  const note = taskId ? namedRemainderNote(taskId, args) : null;
  const mark = note && taskId ? lastTransitionId(taskId) : 0;
  // A named remainder is honoured by the status writer for exactly this synchronous close.
  const content = note && taskId ? withNamedRemainder(taskId, close) : close();
  if (note && taskId && lastTransitionId(taskId) > mark) recordNamedRemainder(agentId, taskId, note);
  return content;
}

/** close_project(status="complete"): every measured task it would close is re-read first. */
export async function remeasureProject(agentId: string, rawProjectId: unknown, status: unknown): Promise<void> {
  if (typeof rawProjectId !== 'string' || !isCompleteStatus(status)) return;
  const r = resolveProjectId(rawProjectId, agentId);
  if (!r.ok) return;
  for (const t of measuredOpenTasksOf(r.id)) await remeasureTask(agentId, t.id);   // eslint-disable-line no-await-in-loop -- one mailbox at a time
}

/** The task a close names: its id, or (complete_step without one) the agent's one claimed task —
 *  the same query `trackerCompleteStep` asks (`claimedTasksOf`), so the reading lands on the row it judges. */
export function closeTargetOf(agentId: string, raw: unknown): string | null {
  if (typeof raw === 'string' && raw) {
    const r = resolveTaskId(raw, agentId);
    return r.ok ? r.id : null;
  }
  const rows = claimedTasksOf(agentId);
  return rows.length === 1 ? rows[0].id : null;
}

/** work_update(action="edit"). A measure is a new scope, applied only once the rest of the edit
 *  has been; an edit carrying only a measure needs no other field. */
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
export async function completeTaskRefusal(agentId: string, taskId: string | null): Promise<string | null> {
  if (!taskId) return null;
  const row = getDb().prepare(`SELECT w.state AS state, ${pendingCloseRequestExpr('w')} AS pending FROM work w WHERE w.id = ?`)
    .get(taskId) as { state: string; pending: number } | undefined;
  if (!row || row.pending === 1 || !['claimed', 'on_deck'].includes(row.state)) return null;
  await remeasureTask(agentId, taskId);
  return remainderGate(taskId, {}, 'complete_task(status="complete")', false);
}
