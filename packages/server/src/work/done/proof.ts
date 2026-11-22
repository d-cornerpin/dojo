// THE ONE PROOF CHECK: "is there real proof, made by this task's worker for this task, that the work
// happened?" is answered here only. `checkProof` judges the items a worker names: each must resolve to a row
// the engine wrote, made by this worker at or after the task opened (`proof-kinds.ts` holds the per-kind
// rule); prose never resolves. `proofFor` is the engine's own finder, holding what it finds to the same rule.
// Neither judges whether the proof meets the goal: a decider does that after opening it.
import { getDb } from '../../db/connection.js';
import { measureReadsZero } from '../measure-close-gate.js';
import { PROOF_LABELS, resolveItem, sqlFloor, type HandInOutcome, type ProofContext, type ProofItemInput, type ProofKind, type ProofTask, type ResolvedItem } from './proof-kinds.js';
import { askerOf } from './asker.js';

export type { HandInOutcome, ProofItemInput, ProofKind, ResolvedItem } from './proof-kinds.js';
export type ProofRefusal = { index: number; why: string };

const FINISHED_KINDS: ReadonlySet<ProofKind> = new Set(['file', 'delivery', 'command', 'receipt', 'measure']);
const CANT_BE_DONE_KINDS: ReadonlySet<ProofKind> = new Set(['failure', 'remainder']);

/** The task as the rules read it, with the agent working it; null when there is no such row. A
 *  scheduled task opens at its newest run, so one run's proof never counts for another. */
function taskOf(workId: string): (ProofTask & { worker: string }) | null {
  const w = getDb().prepare(
    `SELECT w.id, w.title, MAX(w.opened_at, COALESCE((SELECT MAX(r.opened_at) FROM work r WHERE r.parent_id = w.id AND r.kind = 'occurrence'), 0)) AS opened_at,
            w.agent_id, 'ask:' || COALESCE(w.source_message_id, p.source_message_id) AS ask_id, a.result_delivery_id AS ask_receipt
       FROM work w LEFT JOIN work p ON p.id = w.parent_id
       LEFT JOIN work a ON a.kind = 'ask' AND a.id = 'ask:' || COALESCE(w.source_message_id, p.source_message_id)
      WHERE w.id = ?`,
  ).get(workId) as { id: string; title: string | null; opened_at: number; agent_id: string; ask_id: string | null; ask_receipt: string | null } | undefined;
  return w ? { id: w.id, title: w.title, openedAt: w.opened_at, worker: w.agent_id, ask: w.ask_id ? { id: w.ask_id, receipt: w.ask_receipt } : null } : null;
}

function showsFailure(item: ResolvedItem): boolean {
  if (CANT_BE_DONE_KINDS.has(item.kind)) return true;
  if (item.kind === 'command') return item.facts.exit !== 0;
  return item.kind === 'receipt' && typeof item.facts.error === 'string' && item.facts.error !== '';
}

const describe = (i: ProofItemInput, n: number): string => `Item ${n + 1} (${i.kind} ${JSON.stringify(i.ref ?? '')})`;

/** THE proof check. The resolved items on success, else every refusal, each naming its item. */
export function checkProof(
  workId: string, workerId: string, outcome: HandInOutcome, items: ProofItemInput[], byEngine = false,
): { ok: true; items: ResolvedItem[] } | { ok: false; refusals: ProofRefusal[] } {
  if (items.length === 0) {
    return { ok: false, refusals: [{ index: -1, why: 'The hand-in has no proof items. Name the records that show the work: a file, a message, a command, a receipt or the measure.' }] };
  }
  const task = taskOf(workId);
  if (!task) return { ok: false, refusals: [{ index: -1, why: `There is no task ${workId}.` }] };
  const ctx: ProofContext = { task, asker: askerOf(workId), workerId, outcome, byEngine };
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
    refusals.push({ index: -1, why: "A can't be done hand-in needs proof of why: a failed attempt, a named remainder, a command that did not exit 0, or a receipt carrying an error." });
  }
  return refusals.length > 0 ? { ok: false, refusals } : { ok: true, items: resolved };
}

type Found = 'delivery' | 'file' | 'receipt' | 'measure';
type Finder = (workId: string, worker: string, floor: string) => ProofItemInput[];

const FINDERS: Record<Found, Finder> = {
  delivery: (_w, worker, floor) => (getDb().prepare(
    `SELECT id FROM deliveries WHERE agent_id = ? AND outcome = 'delivered' AND tool <> 'engine-ack' AND created_at >= ?
      ORDER BY created_at, rowid`,
  ).all(worker, floor) as Array<{ id: string }>).map((d) => ({ kind: 'delivery', ref: d.id })),
  file: (workId) => (getDb().prepare(
    "SELECT substr(item_key, 6) AS path FROM work_ledger WHERE work_id = ? AND item_key LIKE 'file:%' ORDER BY last_at, item_key",
  ).all(workId) as Array<{ path: string }>).map((f) => ({ kind: 'file', ref: f.path })),
  receipt: (workId, worker) => (getDb().prepare('SELECT id FROM tool_receipts WHERE task_id = ? AND agent_id = ? ORDER BY created_at, rowid')
    .all(workId, worker) as Array<{ id: string }>).map((r) => ({ kind: 'receipt', ref: r.id })),
  measure: (workId) => {
    if (!measureReadsZero(workId)) return [];
    const m = getDb().prepare("SELECT MAX(id) AS id FROM work_events WHERE work_id = ? AND kind = 'measured'").get(workId) as { id: number | null };
    return m.id === null ? [] : [{ kind: 'measure', ref: String(m.id) }];
  },
};

/** Channels that reach no person: a run's engine-found delivery must not be one of them. */
const NO_PERSON_CHANNELS: ReadonlySet<string> = new Set(['a2a', 'none']);

/** `tiedOnly`: only what the engine tied to the task by its own record, for an engine decision. */
function found(workId: string, kinds: readonly Found[], byEngine = false, tiedOnly = false): ResolvedItem[] {
  const task = taskOf(workId);
  if (!task) return [];
  const ctx: ProofContext = { task, asker: askerOf(workId), workerId: task.worker, outcome: 'finished', byEngine };
  const counts = (i: ResolvedItem): boolean =>
    !(byEngine && NO_PERSON_CHANNELS.has(String(i.facts.channel))) && !(tiedOnly && i.facts.tied === 'no');
  return kinds.flatMap((k) => FINDERS[k](workId, task.worker, sqlFloor(task.openedAt)))
    .flatMap((c) => { const r = resolveItem(ctx, c); return r.ok && counts(r.item) ? [r.item] : []; });
}

/** THE engine's finder: deliveries to the asker, files the worker wrote that were charged to this task's
 *  ledger, receipts filed against the task, and the measure when it came down to 0. */
export const proofFor = (workId: string): ResolvedItem[] => found(workId, ['delivery', 'file', 'receipt', 'measure']);

/** The newest delivery to the asker tied to this task alone, else the newest tied to it and another (ambiguous): what a
 *  close points at, or null. `byEngine`: the engine's own run close, where the delivery may go to whoever the schedule serves. */
export function proofDelivery(workId: string, byEngine = false): string | null {
  const tied = found(workId, ['delivery'], byEngine, true);
  return (tied.filter((i) => i.facts.tied === 'yes').pop() ?? tied.pop())?.ref ?? null;
}

/** What the engine itself may count for this task without a decider: a file or the measure at 0,
 *  never a line of text, which may be an ack. */
export const engineProof = (workId: string): ResolvedItem[] => found(workId, ['file', 'measure'], false, true);

const fact = (f: ResolvedItem['facts'], k: string): string => (f[k] === undefined ? '' : String(f[k]));

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
  }
}

/** Each item as one line, "<label>: <what it shows>". A delivery always reads as the worker's own message. */
export function proofLines(items: readonly ResolvedItem[]): string[] {
  return items.map((i) => `${PROOF_LABELS[i.kind]}: ${summarize(i)}${i.facts.tied === 'no' ? ' (the engine could not tie this to the task)' : ''}`);
}


export function engineProofLine(workId: string): string | null {
  const lines = proofLines(engineProof(workId));
  return lines.length > 0 ? lines.join('; ') : null;
}
