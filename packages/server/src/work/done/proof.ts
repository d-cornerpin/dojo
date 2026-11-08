// THE ONE PROOF CHECK: "is there real proof, made by this task's worker for this task, that the work
// happened?" is answered here and nowhere else.
//   - `checkProof` judges the items a worker names: every item resolves to a row the engine wrote, made
//     by this worker at or after the task was opened (`proof-kinds.ts` holds the per-kind rule); a
//     "finished" hand-in needs a file, a delivery to the asker, a command that exited 0, a confirmed
//     receipt or the measure at 0; "can't be done" needs a failure, a remainder, the asker's withdrawal,
//     a command that did not exit 0 or a receipt carrying an error. Prose and status claims never resolve.
//   - `proofFor` is the engine's own finder: the items the worker's rows show for the task, each held
//     to the same rule. A scheduled task is judged on its current run, never on the ask that set it up.
// Neither judges whether the proof meets the goal: a decider does that after opening it.
import { getDb } from '../../db/connection.js';
import { measureReadsZero } from '../measure-close-gate.js';
import { PROOF_LABELS, resolveItem, type HandInOutcome, type ProofContext, type ProofItemInput, type ProofKind, type ResolvedItem } from './proof-kinds.js';
import { askerOf } from './asker.js';

export type { HandInOutcome, ProofItemInput, ProofKind, ResolvedItem } from './proof-kinds.js';
export type ProofRefusal = { index: number; why: string };

const FINISHED_KINDS: ReadonlySet<ProofKind> = new Set(['file', 'delivery', 'command', 'receipt', 'measure']);
const CANT_BE_DONE_KINDS: ReadonlySet<ProofKind> = new Set(['failure', 'remainder', 'withdrawal']);

/** The task as the rules read it, with the agent working it; null when there is no such row. */
function taskOf(workId: string): { id: string; title: string | null; openedAt: number; worker: string } | null {
  const w = getDb().prepare('SELECT id, title, opened_at, agent_id FROM work WHERE id = ?').get(workId) as
    { id: string; title: string | null; opened_at: number; agent_id: string } | undefined;
  return w ? { id: w.id, title: w.title, openedAt: w.opened_at, worker: w.agent_id } : null;
}

/** Does this resolved item show the attempt failed (for a "can't be done")? */
function showsFailure(item: ResolvedItem): boolean {
  if (CANT_BE_DONE_KINDS.has(item.kind)) return true;
  if (item.kind === 'command') return item.facts.exit !== 0;
  return item.kind === 'receipt' && typeof item.facts.error === 'string' && item.facts.error !== '';
}

const describe = (i: ProofItemInput, n: number): string => `Item ${n + 1} (${i.kind} ${JSON.stringify(i.ref ?? '')})`;

/** THE proof check. The resolved items on success, else every refusal, each naming its item. */
export function checkProof(
  workId: string, workerId: string, outcome: HandInOutcome, items: ProofItemInput[],
): { ok: true; items: ResolvedItem[] } | { ok: false; refusals: ProofRefusal[] } {
  if (items.length === 0) {
    return { ok: false, refusals: [{ index: -1, why: 'The hand-in has no proof items. Name the records that show the work: a file, a message, a command, a receipt or the measure.' }] };
  }
  const task = taskOf(workId);
  if (!task) return { ok: false, refusals: [{ index: -1, why: `There is no task ${workId}.` }] };
  const ctx: ProofContext = { task, asker: askerOf(workId), workerId, outcome };
  const refusals: ProofRefusal[] = [];
  const resolved: ResolvedItem[] = [];
  const seen = new Set<string>();
  items.forEach((input, index) => {
    const key = (input.ref ?? '').trim();
    if (seen.has(key)) { refusals.push({ index, why: `${describe(input, index)} cites a record already listed in this hand-in.` }); return; }
    seen.add(key);
    const r = resolveItem(ctx, input);
    if (r.ok) resolved.push(r.item);
    else refusals.push({ index, why: `${describe(input, index)} ${r.why}.` });
  });
  if (refusals.length === 0 && outcome === 'finished' && !resolved.some((i) => FINISHED_KINDS.has(i.kind))) {
    refusals.push({ index: -1, why: 'A finished hand-in needs at least one file, message to the asker, command, receipt or measure.' });
  }
  if (refusals.length === 0 && outcome === 'cant_be_done' && !resolved.some(showsFailure)) {
    refusals.push({ index: -1, why: "A can't be done hand-in needs proof of why: a failed attempt, a named remainder, the asker's withdrawal, a command that did not exit 0, or a receipt carrying an error." });
  }
  return refusals.length > 0 ? { ok: false, refusals } : { ok: true, items: resolved };
}

/** `datetime('now')` text for an instant, floored to its second: how the rows below stamp their time. */
const sqlFloor = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('T', ' ').slice(0, 19);

type Found = 'delivery' | 'file' | 'receipt' | 'measure';
type Finder = (workId: string, worker: string, floor: string) => ProofItemInput[];

/** Where the engine finds each kind of item for a task, oldest first. */
const FINDERS: Record<Found, Finder> = {
  delivery: (_w, worker, floor) => (getDb().prepare(
    `SELECT id FROM deliveries WHERE agent_id = ? AND outcome = 'delivered' AND tool <> 'engine-ack' AND created_at >= ?
      ORDER BY created_at, rowid`,
  ).all(worker, floor) as Array<{ id: string }>).map((d) => ({ kind: 'delivery', ref: d.id })),
  file: (_w, worker, floor) => (getDb().prepare(
    `SELECT target FROM audit_log WHERE agent_id = ? AND action_type = 'file_write' AND result = 'success'
        AND target IS NOT NULL AND created_at >= ? GROUP BY target ORDER BY MAX(created_at), target`,
  ).all(worker, floor) as Array<{ target: string }>).map((f) => ({ kind: 'file', ref: f.target })),
  receipt: (workId, worker) => (getDb().prepare('SELECT id FROM tool_receipts WHERE task_id = ? AND agent_id = ? ORDER BY created_at, rowid')
    .all(workId, worker) as Array<{ id: string }>).map((r) => ({ kind: 'receipt', ref: r.id })),
  measure: (workId) => {
    if (!measureReadsZero(workId)) return [];
    const m = getDb().prepare("SELECT MAX(id) AS id FROM work_events WHERE work_id = ? AND kind = 'measured'").get(workId) as { id: number | null };
    return m.id === null ? [] : [{ kind: 'measure', ref: String(m.id) }];
  },
};

/** The items of these kinds the worker's own rows prove for the task, each held to `checkProof`'s rule
 *  for a finished task. A scheduled task counts from its newest run, never from the ask that set it up. */
function found(workId: string, kinds: readonly Found[]): ResolvedItem[] {
  const task = taskOf(workId);
  if (!task) return [];
  const run = getDb().prepare("SELECT MAX(opened_at) AS at FROM work WHERE parent_id = ? AND kind = 'occurrence'").get(workId) as { at: number | null };
  const since = Math.max(task.openedAt, run.at ?? 0);
  const ctx: ProofContext = { task: { ...task, openedAt: since }, asker: askerOf(workId), workerId: task.worker, outcome: 'finished' };
  return kinds.flatMap((k) => FINDERS[k](workId, task.worker, sqlFloor(since)))
    .flatMap((c) => { const r = resolveItem(ctx, c); return r.ok ? [r.item] : []; });
}

/** THE engine's finder: deliveries to the asker, files the worker wrote, receipts filed against the
 *  task, and the measure when it came down to 0. */
export const proofFor = (workId: string): ResolvedItem[] => found(workId, ['delivery', 'file', 'receipt', 'measure']);

/** The newest delivery to the asker on record for this task: what a close points at, or null. */
export const proofDelivery = (workId: string): string | null => found(workId, ['delivery']).pop()?.ref ?? null;

/** What the engine itself may count for this task without a decider: a file or the measure at 0,
 *  never a line of text, which may be an ack. */
export const engineProof = (workId: string): ResolvedItem[] => found(workId, ['file', 'measure']);

const fact = (f: ResolvedItem['facts'], k: string): string => (f[k] === undefined ? '' : String(f[k]));

/** One line saying what an item shows, from its facts. */
function summarize(i: ResolvedItem): string {
  const f = i.facts;
  switch (i.kind) {
    case 'file': return `${fact(f, 'path')}, ${fact(f, 'size')} bytes, sha256 ${fact(f, 'sha256').slice(0, 12)}, modified ${fact(f, 'mtime')}`;
    case 'delivery': return `delivery ${i.ref.slice(0, 8)} to ${fact(f, 'recipient')} by ${fact(f, 'channel')} at ${fact(f, 'at')}: "${fact(f, 'excerpt')}"`;
    case 'command': return `${fact(f, 'command')}, exit ${fact(f, 'exit')}`;
    case 'receipt': return `${fact(f, 'tool')}${f.verified === 1 ? ', confirmed by the provider' : ', not confirmed'}`
      + `${fact(f, 'recipient') ? `, to ${fact(f, 'recipient')}` : ''}${fact(f, 'error') ? `, error: ${fact(f, 'error')}` : ''}`;
    case 'measure': return `${fact(f, 'left')} ${fact(f, 'unit')} left, from ${fact(f, 'initial')}`;
    case 'remainder': return `${i.ref}: ${fact(f, 'reason')}`;
    case 'failure': return `${fact(f, 'action')} ${fact(f, 'target')}: ${fact(f, 'error')}`.trim();
    case 'withdrawal': return `from ${fact(f, 'from')}: "${fact(f, 'excerpt')}"`;
  }
}

/** Each item as one line, "<label>: <what it shows>". A delivery always reads as the worker's own message. */
export function proofLines(items: readonly ResolvedItem[]): string[] {
  return items.map((i) => `${PROOF_LABELS[i.kind]}: ${summarize(i)}`);
}


/** `engineProof` as one line, or null when there is none. */
export function engineProofLine(workId: string): string | null {
  const lines = proofLines(engineProof(workId));
  return lines.length > 0 ? lines.join('; ') : null;
}
