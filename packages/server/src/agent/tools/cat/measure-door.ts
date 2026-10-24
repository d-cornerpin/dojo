// v3.5 DONE IS MEASURED — the async half of a task's measure, at the work verbs' door
// (`agent/tools/cat/tracker.ts`), because reading a mailbox is I/O and the tracker's handlers are
// synchronous. It validates the wire value, holds the measure to the same wall the executor holds
// the agent's own call to (a measure is a read made on the agent's behalf, so a read the agent
// may not make, the engine does not make for it), and reads it. `tracker/measure-gate.ts` stores
// and judges what this reads.
import { getDb } from '../../../db/connection.js';
import { parseMeasure, countMeasure, type Measure } from '../../../work/measure.js';
import { recordMeasured } from '../../../work/ledger-store.js';
import { editMeasure, type MeasureReading } from '../../../tracker/measure-gate.js';
import { resolveTaskId } from '../../../tracker/schema.js';
import { taskScope } from '../../../work/tracker-view.js';
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

/** A close of a measured task re-reads its measure first; the close door judges that reading. */
export async function remeasureTask(agentId: string, taskId: string | null): Promise<void> {
  if (!taskId) return;
  const row = getDb().prepare('SELECT measure_json FROM work WHERE id = ?').get(taskId) as { measure_json: string | null } | undefined;
  if (!row?.measure_json) return;
  let raw: unknown;
  try { raw = JSON.parse(row.measure_json); } catch { return; }
  const parsed = parseMeasure(raw);
  if (!parsed.ok) return;
  recordMeasured(taskId, await countMeasure(parsed.measure, agentId, agentNameOf(agentId)), Date.now());
}

/** The task a close names: its id, or (complete_step without one) the agent's one claimed task —
 *  the same pick `trackerCompleteStep` makes, so the reading lands on the row that door judges. */
export function closeTargetOf(agentId: string, raw: unknown): string | null {
  if (typeof raw === 'string' && raw) {
    const r = resolveTaskId(raw, agentId);
    return r.ok ? r.id : null;
  }
  const rows = getDb().prepare(`SELECT w.id AS id FROM work w WHERE ${taskScope('w')} AND w.agent_id = ? AND w.state = 'claimed'`)
    .all(agentId) as Array<{ id: string }>;
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
