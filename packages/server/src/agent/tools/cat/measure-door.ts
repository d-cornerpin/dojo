// DONE IS MEASURED: the async half of a task's measure, at the work verbs' door in `tracker.ts`.
// A measure is a read made on the agent's behalf, so it is held to the same wall as the agent's own call.
import { getDb } from '../../../db/connection.js';
import { parseMeasure, countMeasure, type Measure, type MeasureCount } from '../../../work/measure.js';
import { recordMeasured } from '../../../work/ledger-store.js';
import { editMeasure, type MeasureReading } from '../../../tracker/measure-gate.js';
import { ownedOpenTasks, resolveAgentTaskId } from '../../agent-task.js';
import { handIn } from '../../../work/done/hand-in.js';
import { proofFor } from '../../../work/done/proof.js';
import { gatesForCall } from '../gates.js';
import { evaluateGate } from '../gate-eval.js';
import { WORKING_STATES } from '../../../work/terminal-states.js';

const agentNameOf = (agentId: string): string =>
  (getDb().prepare('SELECT name FROM agents WHERE id = ?').get(agentId) as { name: string } | undefined)?.name ?? agentId;

async function refusalFor(agentId: string, m: Measure): Promise<string | null> {
  const args = m.args as Record<string, unknown>;
  for (const gate of gatesForCall(m.tool, args)) {
    // eslint-disable-next-line no-await-in-loop -- the gates are evaluated in their declared order, as the executor does
    const { verdict } = await evaluateGate(gate, { agentId, name: m.tool, args, resolveRef: () => null });
    if (!verdict.allowed) return verdict.blockedMessage || 'refused by its gate';
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
  // A set measure that reads 0 has counted nothing: it can never show progress, so it is refused
  // with the fact. A 0 over folders it could not read is not a 0; it is set as a reading not made.
  if (count.ok && count.count === 0 && !count.unreadable?.length) return { error: `Error: ${MEASURE_READS_ZERO}.` };
  return { reading: { measure: parsed.measure, count, at: Date.now() } };
}

export const MEASURE_READS_ZERO = 'this measure reads 0 now, so it cannot show progress; check the folder, pattern or query';

// The one gated count (set, close, turn end): the measure's tool gates for this agent run before the count.
export async function gatedMeasureCount(m: Measure, agentId: string): Promise<MeasureCount> {
  const refused = await refusalFor(agentId, m);
  return refused ? { ok: false, error: refused } : countMeasure(m, agentId, agentNameOf(agentId));
}

// A close of a measured task re-reads its measure first, made as the task's OWN agent, whoever
// closes; a reading that cannot be taken never refuses the close, and is recorded as such.
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

// complete_task, before the agent is ended: the task is handed in on the proof on record (its
// measure re-read first); "complete" is refused while any other owned step is open. A refusal means the
// agent is not ended; work already handed in is not re-handed. complete_task sends the last words itself.
export async function completeTaskHandIn(agentId: string, status: 'complete' | 'fallen', summary: string): Promise<string | null> {
  const taskId = resolveAgentTaskId(agentId);
  const others = status === 'complete' ? ownedOpenTasks(agentId).filter((t) => t.id !== taskId) : [];
  if (others.length > 0) {
    return `You are not ended: you still own open steps ${others.map((t) => `"${t.title}" (${t.id.slice(0, 8)})`).join(', ')}. Hand in each step you can with work_update(action="hand_in", ...); when a step waits on the owner, end with complete_task(status="blocked") and say why.`;
  }
  if (!taskId) return null;
  const row = getDb().prepare('SELECT state, a2a_thread_id AS thread FROM work WHERE id = ?').get(taskId) as
    { state: string; thread: string | null } | undefined;
  if (!row || !['open', ...WORKING_STATES].includes(row.state)) return null;
  await remeasureTask(agentId, taskId);
  const r = handIn({
    workId: taskId, by: { kind: 'worker', agentId }, outcome: status === 'complete' ? 'finished' : 'cant_be_done',
    items: status === 'complete' ? proofFor(taskId).map(({ kind, ref }) => ({ kind, ref }))
      : [{ kind: 'remainder', ref: 'what was not done', facts: { reason: summary } }],
    note: summary, wordsFollow: true,
  });
  if (r.kind === 'handed_in') return null;
  return row.thread
    ? `${r.text}\nYou are not ended. If your result is your answer, reply on your job's thread with send_to_agent(intent="COMPLETE", thread_id="${row.thread}", payload=<your result>); that reply hands the task in. Then call complete_task again.`
    : `${r.text}\nYou are not ended. Hand the task in yourself with work_update(action="hand_in", task_id="${taskId}", outcome, proof, note), then call complete_task again.`;
}
