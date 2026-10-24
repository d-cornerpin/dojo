// ════════════════════════════════════════
// WHAT THE PM ACTUALLY LOOKED AT (K35).
//
// A verdict used to say "PM validated the close against the goal" whether the PM had read the
// task, opened the files, and checked the receipts, or had read nothing at all. The PM's own
// tool calls this turn (the `messages` rows the loop persists before it runs them) are the
// complete record of what it read, so the record is built from THOSE, structurally: the tool
// name and its id / path argument. Nothing the PM says about itself is trusted.
//
// `pmVerdictRecord` is what the one place that writes a PM verdict (`work/tracker-store.ts`)
// attaches to it: the whole record into `adjudications.evidence_ref` and into the claim event's
// payload, and one plain line for the owner's card. Outside a live PM turn (the scheduler's
// timeout, a test) there is no turn to read, so nothing is attached and the verdict reads as it
// always did. A verdict with NOTHING looked at is still a verdict; the line says "looked at
// nothing", which is the finding.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { turnContext } from '../agent/turn-context.js';
import { currentTurnNumber } from '../agent/v2/turn-record.js';
import { workOperation } from '../tools/work-verbs.js';

export interface LookedAt {
  tasks: string[]; activity: string[]; files: string[]; messages: string[]; results: string[]; vault: string[];
  /** Reads that failed or were refused, by their id / path / query. */
  failed: string[];
  /** Engine receipts filed against the task that the request showed the PM (counted when the request was built). */
  receiptsShown: number;
  /** The measure and ledger lines the validation request carried (the measured plan's E1). Not yet
   *  carried by any request on this base, so never set here; the field is the place it lands. */
  measure?: { remaining: number | null; touched: number };
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

/** Tool-use id -> did its result succeed, for the results stored in this turn. */
function resultsOf(pmAgentId: string, turnNumber: number): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const rows = getDb().prepare(
    "SELECT content FROM messages WHERE agent_id = ? AND turn_number = ? AND role = 'tool' AND content LIKE '[{%'",
  ).all(pmAgentId, turnNumber) as Row[];
  for (const r of rows) {
    try {
      for (const b of JSON.parse(r.content) as Block[]) if (b?.type === 'tool_result' && b.tool_use_id) out.set(b.tool_use_id, !b.is_error);
    } catch { /* not a block array */ }
  }
  return out;
}

/** Receipts the PM's requests this turn showed for `workId` (or for any task when omitted), from the
 *  count the request builder kept with the task's trail entry beside the thread the request rode. */
function receiptsShownThisTurn(pmAgentId: string, turnNumber: number, workId?: string): number {
  const db = getDb();
  const threads = new Set((db.prepare(
    "SELECT DISTINCT a2a_thread_id AS t FROM messages WHERE agent_id = ? AND turn_number = ? AND role = 'user' AND a2a_thread_id IS NOT NULL",
  ).all(pmAgentId, turnNumber) as Array<{ t: string }>).map((r) => r.t));
  if (threads.size === 0) return 0;
  const entries = db.prepare(
    `SELECT json_extract(payload, '$.evidence_json') AS ev FROM work_events
      WHERE kind = 'audit' AND json_extract(payload, '$.entry_kind') = 'closeout_miss'${workId ? ' AND work_id = ?' : ''}`,
  ).all(...(workId ? [workId] : [])) as Array<{ ev: string | null }>;
  let shown = 0;
  for (const e of entries) {
    try {
      const ev = JSON.parse(e.ev ?? '') as { thread_id?: string; receipts_shown?: number };
      if (ev.thread_id && threads.has(ev.thread_id) && typeof ev.receipts_shown === 'number') shown += ev.receipts_shown;
    } catch { /* an entry with no structured evidence */ }
  }
  return shown;
}

/** What the PM read in turn `turnNumber`, from its own persisted tool calls (joined to their results)
 *  and the receipts its request showed. `workId`: the work being judged, so receipts are that task's. */
export function lookedAtThisTurn(pmAgentId: string, turnNumber: number, workId?: string): LookedAt {
  const l: LookedAt = { tasks: [], activity: [], files: [], messages: [], results: [], vault: [], failed: [], receiptsShown: 0 };
  const mine = getDb().prepare(
    "SELECT content FROM messages WHERE agent_id = ? AND turn_number = ? AND role = 'assistant' AND content LIKE '[{%'",
  ).all(pmAgentId, turnNumber) as Row[];
  const results = resultsOf(pmAgentId, turnNumber);
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
  l.receiptsShown = receiptsShownThisTurn(pmAgentId, turnNumber, workId);
  return l;
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
  if (l.receiptsShown) parts.push(n(l.receiptsShown, 'receipt shown', 'receipts shown'));
  if (l.measure) parts.push(`measure ${l.measure.remaining ?? 'unknown'} remaining`);
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
    const looked = lookedAtThisTurn(byId, turn, workId);
    const summary = lookedAtLine(looked, workId);
    const reason = reasonGiven(byId, turn, workId);
    const looked_at = { ...looked, summary, ...(reason ? { reason } : {}) };
    return { ref: JSON.stringify(looked_at), looked_at, note: `PM validated: ${summary}${reason ? ` (${reason})` : ''}` };
  } catch {
    return undefined;   // a verdict is never held up by its own bookkeeping
  }
}
