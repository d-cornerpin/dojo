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
// always did.
//
// v3.5 field fix 3 (#5): the record is no longer only this turn's reads.
//   * Its WINDOW is every PM read since the row's close was filed (plus the ruling turn): a PM that
//     read in a review turn which ended without a verdict, and ruled in the next, read the work.
//   * It carries what the CLOSE REQUEST itself showed, from the same records the request prints
//     (`tracker/validation-request.ts`): the measure and any named remainder, the ledger (files
//     written, commands run), the evidence lines, the delivered-answer id and the owner's words.
// `closeBacking` (below) is what the PM's door reads to refuse an uphold nothing backs (#6b,
// `tracker/empty-uphold.ts`); a verdict that reaches the store is still recorded as it is.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { turnContext } from '../agent/turn-context.js';
import { currentTurnNumber } from '../agent/v2/turn-record.js';
import { workOperation } from '../tools/work-verbs.js';
import { ledgerTotals } from '../work/ledger-read.js';
import { ledgerShownFor } from './request-shown.js';
import { unvalidatedCloseExpr } from '../work/tracker-view.js';
import { resolveTaskAnswerPointer } from './delivery-evidence.js';
import { readLaterMessages } from '../memory/task-list-words.js';
import { readAuditTrail } from '../work/audit-trail.js';

export interface LookedAt {
  tasks: string[]; activity: string[]; files: string[]; messages: string[]; results: string[]; vault: string[];
  /** Reads that failed or were refused, by their id / path / query. */
  failed: string[];
  /** Engine receipts filed against the task that the request showed the PM (counted when the request was built). */
  receiptsShown: number;
  // ── What the close request carried (v3.5 field fix 3, #5). Set only while a close is filed and
  //    unblessed, which is when the validation request shows them; absent otherwise. ──
  /** The Measure line: the reading (null = could not be read), its start, and the remainder the worker named. */
  measure?: { remaining: number | null; initial: number | null; named: string | null };
  /** The Ledger line: items touched (mailbox items and files), commands run, and the paths and commands themselves. */
  ledger?: { touched: number; commands: number; files?: string[]; sends?: Array<{ tool: string; to: string | null }>; commandsRun?: Array<{ command: string; status: string | null }>; notListed?: number };
  /** The worker's evidence lines, as the request prints them. */
  evidence?: string[];
  /** The delivered answer the request pointed at (its delivery id). */
  deliveredAnswer?: string;
  /** The owner's recorded words on the task (message ids). */
  ownerWords?: string[];
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

/** Receipts the PM's requests this turn showed for `workId` (or for any task when omitted), from the
 *  count the request builder kept with the task's trail entry beside the thread the request rode. */
function receiptsShownIn(pmAgentId: string, w: ReadWindow, workId?: string): number {
  const db = getDb();
  const threads = new Set((db.prepare(
    `SELECT DISTINCT a2a_thread_id AS t FROM messages WHERE agent_id = ? AND ${inWindow} AND role = 'user' AND a2a_thread_id IS NOT NULL`,
  ).all(pmAgentId, ...windowArgs(w)) as Array<{ t: string }>).map((r) => r.t));
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

/** What the PM read in turn `turnNumber` and, when `workId` has a close on record, in every turn since
 *  that close was filed: from its own persisted tool calls (joined to their results) and the receipts its
 *  request showed. `workId`: the work being judged, so receipts are that task's. */
export function lookedAtThisTurn(pmAgentId: string, turnNumber: number, workId?: string): LookedAt {
  const w: ReadWindow = { turn: turnNumber, sinceMs: workId ? closeFiledAt(workId) : null };
  const l = readsIn(pmAgentId, w);
  l.receiptsShown = receiptsShownIn(pmAgentId, w, workId);
  if (workId) Object.assign(l, closeRequestFacts(workId));
  return l;
}

/** The PM's successful (and failed) reads since `sinceMs` only: what it read after a refusal (review M3a). */
export function readsSince(pmAgentId: string, sinceMs: number): LookedAt {
  return readsIn(pmAgentId, { turn: -1, sinceMs });
}

/** The PM's reads in a window, from its persisted tool calls joined to their stored results. */
function readsIn(pmAgentId: string, w: ReadWindow): LookedAt {
  const l: LookedAt = { tasks: [], activity: [], files: [], messages: [], results: [], vault: [], failed: [], receiptsShown: 0 };
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

/** Is a close filed on this row and still unblessed (the request's own subject)? */
function closeIsPending(workId: string): boolean {
  const r = getDb().prepare(`SELECT 1 AS y FROM work w WHERE w.id = ? AND ${unvalidatedCloseExpr('w')}`).get(workId) as { y: number } | undefined;
  return !!r;
}

const REMAINDER_NOTE = 'Remainder named at close:';

/** What the validation request for this row carries, from the same records it prints them from. Empty
 *  when no close is pending: outside a request, nothing a request showed can be claimed. */
export function closeRequestFacts(workId: string): Pick<LookedAt, 'measure' | 'ledger' | 'evidence' | 'deliveredAnswer' | 'ownerWords'> {
  if (!closeIsPending(workId)) return {};
  const out: Pick<LookedAt, 'measure' | 'ledger' | 'evidence' | 'deliveredAnswer' | 'ownerWords'> = {};
  const row = getDb().prepare('SELECT measure_json, measure_initial, measure_remaining, evidence_json FROM work WHERE id = ?')
    .get(workId) as { measure_json: string | null; measure_initial: number | null; measure_remaining: number | null; evidence_json: string | null } | undefined;
  if (row?.measure_json) {
    const named = row.measure_remaining === 0 ? undefined
      : readAuditTrail(workId, { kinds: ['observation'] }).map((e) => e.note ?? '').find((x) => x.startsWith(REMAINDER_NOTE));   // newest first, as the request reads it
    out.measure = { remaining: row.measure_remaining, initial: row.measure_initial, named: named ? named.slice(REMAINDER_NOTE.length).trim() : null };
  }
  const { touched, commands } = ledgerTotals(workId);
  if (touched > 0 || commands > 0) {
    // Review M1: the page the request SHOWED (laid out in the PM's room), never a fresh unbounded read
    // of the whole ledger; the counts alone when no request for the row was shown in this process.
    const page = ledgerShownFor(workId);
    out.ledger = page ? { touched, commands, ...page } : { touched, commands };
  }
  try {
    const ev = JSON.parse(row?.evidence_json ?? '[]') as Array<{ kind?: string; claim?: string; pointer?: string }>;
    const lines = Array.isArray(ev) ? ev.map((e) => `[${e.kind ?? '?'}] ${e.claim ?? ''}${e.pointer ? ` @ ${e.pointer}` : ''}`) : [];
    if (lines.length > 0) out.evidence = lines;
  } catch { /* an unreadable evidence array is shown as none */ }
  const answer = taskAnswerFor(workId);
  if (answer) out.deliveredAnswer = answer.deliveryId;
  const words = readLaterMessages(workId).map((m) => m.messageId).filter((id): id is string => !!id);
  if (words.length > 0) out.ownerWords = words;
  return out;
}

/** THE TASK'S ANSWER, the one place this module (and `empty-uphold.ts`) asks for it. Review M2: the tree is
 *  collapsing "the task's recorded answer" into one function (`resolveTaskAnswerPointer`, f3-close), so
 *  this wrapper is the single swap point; it adds no definition of its own. */
export function taskAnswerFor(workId: string): { deliveryId: string; messageId: string | null; excerpt: string } | null {
  return resolveTaskAnswerPointer(workId);
}

/** Absolute paths a piece of record text names (a command, an answer): the tokens that start with "/" or "~/". */
function pathsIn(text: string): string[] {
  return (text.match(/(?:^|[\s"'`=(])((?:\/|~\/)[^\s"'`;|&<>()]+)/g) ?? [])
    .map((m) => m.replace(/^[\s"'`=(]/, '').replace(/[.,:]+$/, ''))
    .filter((p) => p.length > 1);
}

/** What THIS row's record names for a reader to open (review M3b, tightened in round 2 R7): the specific
 *  files its ledger wrote, the specific paths its commands name, its evidence pointers, the delivered
 *  answer's message and the paths it names, the owner's recorded messages; and the folders the ledger
 *  WROTE into (only these: a folder a command or a pointer merely names is never a licence for the reads
 *  under it). A read binds to the row only when it opens one of these. */
export function rowReadNames(workId: string): { paths: string[]; messages: string[]; wroteInto: string[] } {
  const db = getDb();
  const paths: string[] = [];
  const messages: string[] = [];
  const wroteInto: string[] = [];
  const keys = db.prepare('SELECT item_key AS k FROM work_ledger WHERE work_id = ?').all(workId) as Array<{ k: string }>;
  for (const { k } of keys) {
    if (k.startsWith('file:')) {
      const f = trimSlash(k.slice('file:'.length));
      paths.push(f);
      const dir = f.slice(0, f.lastIndexOf('/'));
      if (dir) wroteInto.push(dir);
    } else if (k.startsWith('cmd:')) paths.push(...pathsIn(k.slice('cmd:'.length)));
  }
  try {
    const ev = JSON.parse((db.prepare('SELECT evidence_json AS e FROM work WHERE id = ?').get(workId) as { e: string | null } | undefined)?.e ?? '[]') as Array<{ pointer?: unknown }>;
    for (const e of Array.isArray(ev) ? ev : []) {
      if (typeof e?.pointer !== 'string' || !e.pointer.trim()) continue;
      const p = e.pointer.trim();
      if (p.startsWith('/') || p.startsWith('~/')) paths.push(p); else messages.push(p);
    }
  } catch { /* no readable evidence names nothing */ }
  const answer = taskAnswerFor(workId);
  if (answer?.messageId) messages.push(answer.messageId);
  if (answer?.excerpt) paths.push(...pathsIn(answer.excerpt));
  for (const m of readLaterMessages(workId)) if (m.messageId) messages.push(m.messageId);
  return { paths: [...new Set(paths.map(trimSlash))], messages: [...new Set(messages)], wroteInto: [...new Set(wroteInto)] };
}

function trimSlash(p: string): string { return p.length > 1 ? p.replace(/\/+$/, '') : p; }
/** Does reading `read` open the row's work? The very path the record names, or a file inside a folder the
 *  row's own ledger wrote into (never that folder itself, never a folder merely named). */
function opensRowWork(read: string, names: { paths: string[]; wroteInto: string[] }): boolean {
  const r = trimSlash(read);
  if (names.paths.includes(r)) return true;
  return names.wroteInto.some((d) => r.startsWith(`${d}/`));
}
const sameMessage = (read: string, named: string): boolean => read === named || (read.length >= 8 && named.startsWith(read));

/** Did these reads open THIS row's work (review M3b, R7)? Its activity, or something its record names. */
export function readsBoundToRow(l: LookedAt, workId: string, names = rowReadNames(workId)): boolean {
  return l.activity.some((id) => matchesWork(workId, id))
    || l.files.some((f) => opensRowWork(f, names))
    || [...l.messages, ...l.results].some((m) => names.messages.some((n) => sameMessage(m, n)));
}

/** Does anything STRUCTURAL back this close (v3.5 field fix 3, #6b)? A measure at 0 or with a named
 *  remainder, a ledger entry, a delivered answer, the owner's recorded words (what a decision task is
 *  judged on, per the request's own rule), or a PM read of THIS row's work (`readsBoundToRow`). Reading the
 *  task record alone is the worker's own account and backs nothing. */
export function closeBacking(l: LookedAt, workId: string): { backed: boolean; read: boolean } {
  const read = readsBoundToRow(l, workId);   // review M3b: a read backs only the row whose work it opened
  const measured = !!l.measure && (l.measure.remaining === 0 || !!l.measure.named);
  const ledger = !!l.ledger && (l.ledger.touched > 0 || l.ledger.commands > 0);
  return { backed: read || measured || ledger || !!l.deliveredAnswer || !!l.ownerWords?.length, read };
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
  if (l.measure) parts.push(`measure ${l.measure.remaining ?? 'unknown'} remaining${l.measure.remaining && l.measure.named ? ' (remainder named)' : ''}`);
  if (l.ledger) parts.push(`ledger ${n(l.ledger.touched, 'item touched', 'items touched')}${l.ledger.commands ? ` and ${n(l.ledger.commands, 'command run', 'commands run')}` : ''}`);
  if (l.evidence) parts.push(n(l.evidence.length, 'evidence line', 'evidence lines'));
  if (l.deliveredAnswer) parts.push(`delivered answer ${l.deliveredAnswer.slice(0, 8)}`);
  if (l.ownerWords) parts.push(`owner words ${n(l.ownerWords.length, 'message', 'messages')}`);
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
