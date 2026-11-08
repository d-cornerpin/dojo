// WHAT THE PM ACTUALLY LOOKED AT. A verdict carries the PM's own reads, built structurally from its
// persisted tool calls (the tool name and its id / path argument, joined to a stored result), never
// from anything the PM says about itself. `pmVerdictRecord` is what the one place that writes a PM
// verdict (`work/tracker-store.ts`) attaches: the record into `adjudications.evidence_ref` and the
// claim event, and one plain line for the owner's card. The window is every PM read since the row's
// close was filed, plus the ruling turn. Outside a live PM turn nothing is attached.

import { getDb } from '../db/connection.js';
import { turnContext } from '../agent/turn-context.js';
import { currentTurnNumber } from '../agent/v2/turn-record.js';
import { workOperation } from '../tools/work-verbs.js';
import { proofFor, type ResolvedItem } from '../work/done/proof.js';

export interface LookedAt {
  tasks: string[]; activity: string[]; files: string[]; messages: string[]; results: string[]; vault: string[];
  /** Reads that failed or were refused, by their id / path / query. */
  failed: string[];
  /** The proof on record when the PM ruled (`proofFor`), as "<kind> <ref>": what the close was judged on. */
  proof?: string[];
}

type Row = { content: string };
interface Block { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: unknown }

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const add = (into: string[], v: unknown): void => { const s = str(v); if (s && !into.includes(s)) into.push(s); };

function callsOf(rows: Row[]): Block[] {
  const out: Block[] = [];
  for (const r of rows) {
    try {
      for (const b of JSON.parse(r.content) as Block[]) if (b?.type === 'tool_use' && b.name) out.push(b);
    } catch { /* plain text, not a block array */ }
  }
  return out;
}

/** Which of the PM's rows count: the ruling turn's, and every row since the close was filed. */
interface ReadWindow { turn: number; sinceMs: number | null }
const inWindow = "(turn_number = ? OR (? IS NOT NULL AND created_at >= ?))";
const windowArgs = (w: ReadWindow): unknown[] => [w.turn, w.sinceMs, w.sinceMs];

/** When the row's close was filed: the newest Key-1 request, or the engine's own receipt close. Null
 *  when no close is on record (the window is then the ruling turn alone, as it always was). */
export function closeFiledAt(workId: string): number | null {
  const r = getDb().prepare(
    `SELECT MAX(created_at) AS at FROM work_events WHERE work_id = ?
       AND ((kind = 'validation_requested' AND json_extract(payload, '$.requested_state') = 'done')
         OR (kind = 'transition' AND json_extract(payload, '$.to') = 'done'))`,
  ).get(workId) as { at: number | null } | undefined;
  return r?.at ?? null;
}

/** Tool-use id -> did its result succeed, for the results stored in the window. */
function resultsOf(pmAgentId: string, w: ReadWindow): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const rows = getDb().prepare(
    `SELECT content FROM messages WHERE agent_id = ? AND ${inWindow} AND role = 'tool' AND content LIKE '[{%'`,
  ).all(pmAgentId, ...windowArgs(w)) as Row[];
  for (const r of rows) {
    try {
      for (const b of JSON.parse(r.content) as Block[]) if (b?.type === 'tool_result' && b.tool_use_id) out.set(b.tool_use_id, !b.is_error);
    } catch { /* not a block array */ }
  }
  return out;
}

/** What the PM read in turn `turnNumber` and, when `workId` has a close on record, in every turn since
 *  that close was filed: from its own persisted tool calls (joined to their results) and the receipts its
 *  request showed. `workId`: the work being judged, so receipts are that task's. */
export function lookedAtThisTurn(pmAgentId: string, turnNumber: number, workId?: string): LookedAt {
  const w: ReadWindow = { turn: turnNumber, sinceMs: workId ? closeFiledAt(workId) : null };
  return readsIn(pmAgentId, w);
}

/** The PM's reads in a window, from its persisted tool calls joined to their stored results. */
function readsIn(pmAgentId: string, w: ReadWindow): LookedAt {
  const l: LookedAt = { tasks: [], activity: [], files: [], messages: [], results: [], vault: [], failed: [] };
  const mine = getDb().prepare(
    `SELECT content FROM messages WHERE agent_id = ? AND ${inWindow} AND role = 'assistant' AND content LIKE '[{%' ORDER BY created_at, rowid`,
  ).all(pmAgentId, ...windowArgs(w)) as Row[];
  const results = resultsOf(pmAgentId, w);
  for (const c of callsOf(mine)) {
    const ok = c.id ? results.get(c.id) : undefined;
    if (ok === undefined) continue;   // no stored result: the PM had not read it when it judged
    const a = c.input ?? {};
    const into = (list: string[], v: unknown): void => add(ok ? list : l.failed, v);
    switch (workOperation(c.name, a) ?? c.name) {
      case 'work_update:get': into(l.tasks, a.task_id); break;
      case 'work_update:activity': into(l.activity, a.task_id ?? a.project_id); break;
      case 'vault_get': into(l.vault, a.entry_id); break;
      case 'vault_search': into(l.vault, a.query); break;
      case 'history_get': into(l.messages, a.id ?? a.query); break;
      case 'history_search': into(l.messages, a.query ?? a.pattern); break;
      case 'tool_result_read': into(l.results, a.id); break;
      case 'file_read': case 'file_list': into(l.files, a.path); break;
    }
  }
  return l;
}

/** The proof each review put in front of the PM, by task: process memory, so after a restart the PM opens it itself. */
const proofShown = new Map<string, Set<string>>();

/** The review showed the PM these proof items for the task (replaces what an earlier review showed). */
export function noteProofShown(taskId: string, refs: readonly string[]): void { proofShown.set(taskId, new Set(refs)); }
/** Forget every task not still awaiting a verdict. */
export function keepProofShownFor(pending: ReadonlySet<string>): void {
  for (const id of [...proofShown.keys()]) if (!pending.has(id)) proofShown.delete(id);
}

/** Has the PM been shown one of these items by a review, or opened one (the file, or the delivered message)
 *  since the close was filed? A read of something else binds nothing. */
export function proofSeen(pmAgentId: string, taskId: string, items: readonly ResolvedItem[]): boolean {
  const shown = proofShown.get(taskId);
  if (items.some((i) => shown?.has(i.ref))) return true;
  const ctx = turnContext(pmAgentId);
  if (!ctx || items.length === 0) return false;
  const l = lookedAtThisTurn(pmAgentId, ctx.turnNumber ?? currentTurnNumber(pmAgentId), taskId);
  const opened = (id: string): boolean => !!id && [...l.messages, ...l.results].some((m) => m === id || (m.length >= 8 && id.startsWith(m)));
  return items.some((i) => (i.kind === 'file' && l.files.includes(String(i.facts.path))) || (i.kind === 'delivery' && opened(String(i.facts.message))));
}

/** A task id as the tools accept it: the full id or its 8-character prefix, never anything shorter. */
const matchesWork = (workId: string, given: string): boolean => given.length >= 8 && workId.startsWith(given);

const n = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** One plain line: "read the task, opened 2 files, 6 receipts shown". `workId` is the work being judged:
 *  reading ANOTHER task is said as such, never as "read the task". */
export function lookedAtLine(l: LookedAt, workId?: string): string {
  const isThis = (id: string): boolean => workId !== undefined && matchesWork(workId, id);
  const mine = l.tasks.filter(isThis).length;
  const other = l.tasks.length - mine;
  const parts: string[] = [];
  if (mine) parts.push('read the task');
  if (other) parts.push(`read ${n(other, 'other task', 'other tasks')}`);
  if (l.activity.length) parts.push(`read the activity of ${n(l.activity.length, 'task', 'tasks')}`);
  if (l.files.length) parts.push(`opened ${n(l.files.length, 'file', 'files')}`);
  if (l.messages.length) parts.push(`searched or read ${n(l.messages.length, 'message', 'messages')}`);
  if (l.results.length) parts.push(`re-read ${n(l.results.length, 'tool result', 'tool results')}`);
  if (l.vault.length) parts.push(`consulted the vault ${n(l.vault.length, 'time', 'times')}`);
  if (l.failed.length) parts.push(`tried to read ${l.failed.join(', ')} (failed)`);
  if (l.proof?.length) parts.push(`${n(l.proof.length, 'proof item', 'proof items')} on record`);
  return parts.length ? parts.join(', ') : 'looked at nothing';
}

/** The `reason` the PM gave on its latest `work_validate` call for this task this turn, if any. */
function reasonGiven(pmAgentId: string, turnNumber: number, workId: string): string | null {
  const rows = getDb().prepare(
    "SELECT content FROM messages WHERE agent_id = ? AND turn_number = ? AND role = 'assistant' AND content LIKE '[{%' ORDER BY created_at, rowid",
  ).all(pmAgentId, turnNumber) as Row[];
  for (const c of callsOf(rows).reverse()) {
    if (workOperation(c.name, c.input) !== 'work_validate:validate') continue;
    const id = str(c.input?.task_id);
    if (id && matchesWork(workId, id)) return str(c.input?.reason);
  }
  return null;
}

export interface VerdictRecord {
  /** The JSON written to `adjudications.evidence_ref`. */
  ref: string;
  /** The same record, for the claim event's payload. */
  looked_at: LookedAt & { summary: string; reason?: string };
  /** `PM validated: <summary>`, the uphold note. */
  note: string;
}

/**
 * The record a PM verdict carries, or undefined when `by` is not the PM or no PM turn is open
 * for `byId`. `workId` finds the PM's own `reason` on its validate call.
 */
export function pmVerdictRecord(by: string, byId: string, workId: string): VerdictRecord | undefined {
  if (by !== 'pm') return undefined;
  try {
    const ctx = turnContext(byId);
    if (!ctx) return undefined;
    const turn = ctx.turnNumber ?? currentTurnNumber(byId);
    const looked: LookedAt = { ...lookedAtThisTurn(byId, turn, workId), proof: proofFor(workId).map((i) => `${i.kind} ${i.ref}`) };
    const summary = lookedAtLine(looked, workId);
    const reason = reasonGiven(byId, turn, workId);
    const looked_at = { ...looked, summary, ...(reason ? { reason } : {}) };
    return { ref: JSON.stringify(looked_at), looked_at, note: `PM validated: ${summary}${reason ? ` (${reason})` : ''}` };
  } catch {
    return undefined;   // a verdict is never held up by its own bookkeeping
  }
}
