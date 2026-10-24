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
  receiptsShown: number;
  /** The measure and ledger lines the validation request carried (the measured plan's E1). Not yet
   *  carried by any request on this base, so never set here; the field is the place it lands. */
  measure?: { remaining: number | null; touched: number };
}

type Row = { content: string };
interface Block { type?: string; name?: string; input?: Record<string, unknown> }

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const add = (into: string[], v: unknown): void => { const s = str(v); if (s && !into.includes(s)) into.push(s); };

/** One engine-written receipt line, as the PM's validation requests print them. */
const RECEIPT_LINE = /^\s+\[[^\]\n]+\] \S+ (?:VERIFIED|unverified) \(/gm;

function callsOf(rows: Row[]): Block[] {
  const out: Block[] = [];
  for (const r of rows) {
    try {
      for (const b of JSON.parse(r.content) as Block[]) if (b?.type === 'tool_use' && b.name) out.push(b);
    } catch { /* plain text, not a block array */ }
  }
  return out;
}

/** What the PM read in turn `turnNumber`, from its own persisted tool calls and the request it was woken with. */
export function lookedAtThisTurn(pmAgentId: string, turnNumber: number): LookedAt {
  const l: LookedAt = { tasks: [], activity: [], files: [], messages: [], results: [], vault: [], receiptsShown: 0 };
  const db = getDb();
  const mine = db.prepare(
    "SELECT content FROM messages WHERE agent_id = ? AND turn_number = ? AND role = 'assistant' AND content LIKE '[{%'",
  ).all(pmAgentId, turnNumber) as Row[];
  for (const c of callsOf(mine)) {
    const a = c.input ?? {};
    switch (workOperation(c.name, a) ?? c.name) {
      case 'work_update:get': add(l.tasks, a.task_id); break;
      case 'work_update:activity': add(l.activity, a.task_id ?? a.project_id); break;
      case 'vault_get': add(l.vault, a.entry_id); break;
      case 'vault_search': add(l.vault, a.query); break;
      case 'history_get': add(l.messages, a.id ?? a.query); break;
      case 'history_search': add(l.messages, a.query ?? a.pattern); break;
      case 'tool_result_read': add(l.results, a.id); break;
      case 'file_read': case 'file_list': add(l.files, a.path); break;
    }
  }
  const asked = db.prepare(
    "SELECT content FROM messages WHERE agent_id = ? AND turn_number = ? AND role = 'user'",
  ).all(pmAgentId, turnNumber) as Row[];
  for (const r of asked) l.receiptsShown += r.content.match(RECEIPT_LINE)?.length ?? 0;
  return l;
}

const n = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** One plain line: "read the task, opened 2 files, 6 receipts shown". `workId` is the work being judged:
 *  reading ANOTHER task is said as such, never as "read the task". */
export function lookedAtLine(l: LookedAt, workId?: string): string {
  const isThis = (id: string): boolean => workId !== undefined && workId.startsWith(id);
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
    if (id && workId.startsWith(id)) return str(c.input?.reason);
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
    const looked = lookedAtThisTurn(byId, turn);
    const summary = lookedAtLine(looked, workId);
    const reason = reasonGiven(byId, turn, workId);
    const looked_at = { ...looked, summary, ...(reason ? { reason } : {}) };
    return { ref: JSON.stringify(looked_at), looked_at, note: `PM validated: ${summary}${reason ? ` (${reason})` : ''}` };
  } catch {
    return undefined;   // a verdict is never held up by its own bookkeeping
  }
}
