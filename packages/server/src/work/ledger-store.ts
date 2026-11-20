// The SQL for a task's ledger (`work_ledger`) and the engine's readings of its measure. The engine writes the ledger
// from the agent's successful mutation calls (agent/v2/steps/execute/tracker-counting.ts), never the model. One row
// per (task, item): a re-touch moves `last_at`, so COUNT(*) is distinct items touched. A file the worker wrote is
// an item ("file:<path>"); a command ("cmd:<command>") is a RECORD, never an item: it is as often a read as a change.
import { getDb } from '../db/connection.js';
import { sendReachesAsker } from './done/asker.js';
import { handsOverWork, isStatusClaimOnly } from './done/proof-kinds.js';
import { redactHandedCredentials } from '../credentials/secret-values.js';
import type { ToolEffect } from '../agent/tools/types.js';
import { appliedKeysOf } from '../google/gmail-label.js';
import { appendWorkEvent } from './store.js';
import { STILL_RUNNING, exitStatusOf } from './command-status.js';
import { handOffForCall, ledgerTookHandOff } from '../agent/background-commands.js';
import type { WorkEventKind } from './event-kinds.js';
import type { Measure, MeasureCount } from './measure.js';


/** Non-mailbox key prefixes: `cmd:` is a record, never an item; `send:` is one delivery, keyed by its call. */
export const FILE_KEY = 'file:';
export const COMMAND_KEY = 'cmd:';
export const SEND_KEY = 'send:';
export const IS_ITEM = `substr(item_key, 1, ${COMMAND_KEY.length}) <> '${COMMAND_KEY}'`;

/** The agent(s) a send addresses (`args.agent` / `args.group_id`), or undefined when it is not a send to another
 *  agent. Such a send counts as work only with the engine's verified receipt for that exact call. */
export function agentSendRecipientsOf(args: Record<string, unknown>, effects: readonly ToolEffect[]): string[] | undefined {
  const sends = effects.filter((e) => e.kind === 'send' && (e.from === 'args.agent' || e.from === 'args.group_id'));
  if (sends.length === 0) return undefined;
  const named = sends.flatMap((e) => argValues(args, e.from)).filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
  return [...new Set(named)];
}

/** The recipient(s) a successful SEND to a person names: null when derived (a reply), undefined when not a send. */
export function sendRecipientsOf(args: Record<string, unknown>, effects: readonly ToolEffect[]): string[] | null | undefined {
  const sends = effects.filter((e) => e.kind === 'send');
  if (sends.length === 0) return undefined;
  if (sends.every((e) => e.from === 'args.agent' || e.from === 'args.group_id')) return undefined;
  const named = sends.flatMap((e) => argValues(args, e.from)).flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
  return named.length > 0 ? [...new Set(named)] : null;
}

const strs = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : typeof v === 'string' && v ? [v] : [];
const uniq = (xs: string[]): string[] => [...new Set(xs)];
const base = (name: string): string => name.startsWith('user_') ? name.slice(5) : name;

const OUTLOOK_MESSAGE_MUTATIONS = new Set(['outlook_move_to_folder', 'outlook_mark_read', 'outlook_delete', 'outlook_categories_set']);

/** The value an `args.<path>` effect names: a dotted path, `[]` for array elements. */
function argValues(args: Record<string, unknown>, from: string): unknown[] {
  if (!from.startsWith('args.')) return [];
  let cursor: unknown[] = [args];
  for (const seg of from.slice('args.'.length).split('.')) {
    const many = seg.endsWith('[]');
    const key = many ? seg.slice(0, -2) : seg;
    cursor = cursor.flatMap((c) => {
      const v = c !== null && typeof c === 'object' ? (c as Record<string, unknown>)[key] : undefined;
      return many ? (Array.isArray(v) ? v : []) : [v];
    });
  }
  return cursor;
}

function commandText(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) return (v as string[]).join(' ').trim() || null;
  return null;
}

function effectKeysOf(args: Record<string, unknown>, effects: readonly ToolEffect[]): string[] {
  const out: string[] = [];
  for (const e of effects) {
    if (e.kind === 'fs_write' || e.kind === 'fs_delete') {
      for (const v of argValues(args, e.from)) if (typeof v === 'string' && v.trim()) out.push(`${FILE_KEY}${v.trim()}`);
    } else if (e.kind === 'proc' || e.kind === 'shell') {
      for (const v of argValues(args, e.from)) { const c = commandText(v); if (c) out.push(`${COMMAND_KEY}${c}`); }
    }
  }
  return out;
}

export function itemKeysOf(toolName: string, args: Record<string, unknown>, effects: readonly ToolEffect[] = []): string[] {
  return uniq([...mailboxKeysOf(toolName, args), ...effectKeysOf(args, effects)]);
}

function mailboxKeysOf(toolName: string, args: Record<string, unknown>): string[] {
  const name = base(toolName);
  if (name === 'gmail_label') {
    return uniq([
      ...strs(args.message_ids).map((id) => `gmail:msg:${id}`),
      ...strs(args.message_id).map((id) => `gmail:msg:${id}`),
      ...strs(args.thread_ids).map((id) => `gmail:thread:${id}`),
      ...strs(args.thread_id).map((id) => `gmail:thread:${id}`),
    ]);
  }
  // The move tool alone can take the whole conversation instead of, or beside, one message.
  if (name === 'outlook_move_to_folder') {
    return uniq([
      ...strs(args.message_id).map((id) => `outlook:msg:${id}`),
      ...strs(args.conversation_id).map((id) => `outlook:conv:${id}`),
    ]);
  }
  if (OUTLOOK_MESSAGE_MUTATIONS.has(name)) return uniq(strs(args.message_id).map((id) => `outlook:msg:${id}`));
  return [];
}

/** A task's measure reading, on its spine; engine-written, so `taskMovedAtSql` never reads it as a move. */
export const MEASURED_EVENT = 'measured' as const satisfies WorkEventKind;

export function recordTouched(
  workId: string, tool: string, keys: string[], at: number = Date.now(), detail: string | null = null,
  /** The call that wrote a command row: how a backgrounded command settles it. */
  callId: string | null = null,
): number {
  if (keys.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO work_ledger (work_id, item_key, tool, first_at, last_at, detail, call_id) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(work_id, item_key) DO UPDATE SET last_at = excluded.last_at, tool = excluded.tool, detail = excluded.detail, call_id = excluded.call_id`,
  );
  db.transaction((ks: string[]) => { for (const k of ks) stmt.run(workId, k, tool, at, at, detail, callId); })(keys);
  return keys.length;
}

export { STILL_RUNNING } from './command-status.js';

export interface RoundResult { toolCallId: string; isError: boolean; errorCode?: string; content?: string; keptWhole?: string }

export const succeededIn = (roundResults: ReadonlyArray<RoundResult>) => (call: { id?: string }): boolean => {
  const r = roundResults.find((x) => x.toolCallId === call.id);
  return !!r && !r.isError && !r.errorCode;
};

/** The ledger charge for one round's calls: the items each call touched, ONLY when its result is here and succeeded.
 *  Success is the result's own flags, never its words. A `gmail_label` batch that partly applied is an Error result,
 *  yet the ids it says WERE applied are real touches (`appliedKeysOf`). */
export function recordCallsTouched(
  workId: string,
  calls: ReadonlyArray<{ id: string; name: string; arguments?: Record<string, unknown> }>,
  roundResults: ReadonlyArray<RoundResult>,
  effectsOf: (toolName: string) => readonly ToolEffect[] | undefined,
  /** The agent that made the calls: whose handed credentials are scrubbed from every key and detail. */
  agentId: string,
): void {
  const ok = succeededIn(roundResults);
  // A command or path can carry a credential the agent was handed, so every key and detail goes through the one
  // redactor before it is written; the request and the verdict read only the redacted ledger.
  const safe = (k: string): string => redactHandedCredentials(agentId, k);
  for (const tc of calls) {
    if (ok(tc)) {
      const keys = [...new Set(itemKeysOf(tc.name, tc.arguments ?? {}, effectsOf(tc.name) ?? []).map(safe))];
      const commands = keys.filter((k) => k.startsWith(COMMAND_KEY));
      const items = keys.filter((k) => !k.startsWith(COMMAND_KEY));
      if (items.length > 0) recordTouched(workId, tc.name, items);
      if (commands.length > 0) {
        const r = roundResults.find((x) => x.toolCallId === tc.id);
        // A call handed to the background has a hand-off row by call id: running, the row says so and the hand-off
        // settles it when the command ends; already ended, its real status comes from that row.
        const bg = handOffForCall(tc.id);
        if (bg && bg.exitStatus === null) {
          recordTouched(workId, tc.name, commands, Date.now(), STILL_RUNNING, tc.id);
        } else if (bg) {
          recordTouched(workId, tc.name, commands, Date.now(), bg.exitStatus, tc.id);
          ledgerTookHandOff(bg.id);
        } else {
          recordTouched(workId, tc.name, commands, Date.now(), safe(exitStatusOf(r?.keptWhole ?? r?.content ?? '')));
        }
      }
      // A successful send to a person is one delivery on the ledger, keyed by its call, with its recipient(s).
      const to = sendRecipientsOf(tc.arguments ?? {}, effectsOf(tc.name) ?? []);
      if (to !== undefined) recordTouched(workId, tc.name, [`${SEND_KEY}${tc.id}`], Date.now(), to ? safe(to.join(', ')) : null);
      // A send to another agent is a delivery too, but only on the engine's VERIFIED receipt for this call and when
      // it hands work to the agent that asked (`work/done/asker.ts`): a bare "done" to the PM is never work.
      const peers = to === undefined ? agentSendRecipientsOf(tc.arguments ?? {}, effectsOf(tc.name) ?? []) : undefined;
      const a = tc.arguments ?? {};
      const payload = typeof a.payload === 'string' ? a.payload : '';
      const toGroup = typeof a.group_id === 'string' && a.group_id.trim() !== '';
      if (peers !== undefined && !toGroup && handsOverWork(typeof a.intent === 'string' ? a.intent : null)
        && verifiedReceiptFor(tc.id, agentId) && sendReachesAsker(workId, peers)
        && !isStatusClaimOnly(payload, { id: workId, title: titleOf(workId) })) {
        recordTouched(workId, tc.name, [`${SEND_KEY}${tc.id}`], Date.now(), safe(`agent ${peers.join(', ') || 'unnamed'}`), tc.id);
      }
      stampCallReceipts(tc.id, agentId, workId);
      continue;
    }
    const r = roundResults.find((x) => x.toolCallId === tc.id);
    if (!r?.isError || base(tc.name) !== 'gmail_label') continue;
    const applied = appliedKeysOf(r.keptWhole ?? r.content ?? '');
    if (applied && applied.length > 0) recordTouched(workId, tc.name, applied.map(safe));
  }
}

const titleOf = (workId: string): string | null =>
  (getDb().prepare('SELECT title FROM work WHERE id = ?').get(workId) as { title: string | null } | undefined)?.title ?? null;

/** The engine's verified receipt for one call (`tool_receipts.call_id`, written by the tool's executor). */
function verifiedReceiptFor(callId: string, agentId: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM tool_receipts WHERE call_id = ? AND agent_id = ? AND verified = 1 LIMIT 1').get(callId, agentId);
}

/** Tie this call's receipts to the task it was charged to, so a send made a turn before the close belongs to a task;
 *  the first tie wins. */
function stampCallReceipts(callId: string, agentId: string, workId: string): void {
  getDb().prepare(`UPDATE tool_receipts SET task_id = ?, updated_at = datetime('now') WHERE call_id = ? AND agent_id = ? AND task_id IS NULL`)
    .run(workId, callId, agentId);
}

/** Items this task touched for the FIRST time after `sinceMs`. The turn end's momentum reads this, not a
 *  touch count: re-touching is not progress, so a loop over the same items cannot keep a job continuing. */
export function ledgerNewItemsSince(workId: string, sinceMs: number): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM work_ledger WHERE work_id = ? AND first_at > ? AND ${IS_ITEM}`).get(workId, sinceMs) as { n: number }).n;
}

/** Store a reading of the task's measure. `remaining` null = it could not be read at `at`; `initial` is given only
 *  when the measure is set (a new measure is a new scope), and a measure unread at set takes its first successful
 *  reading as its start. */
export function writeMeasured(workId: string, remaining: number | null, at: number, initial?: number): void {
  getDb().prepare(
    'UPDATE work SET measure_remaining = ?, measure_at = ?, measure_initial = COALESCE(?, measure_initial, ?) WHERE id = ?',
  ).run(remaining, at, initial ?? null, remaining, workId);
}

/** A count that could not read every folder it covers is NO READING for any close: the files still to do may sit in
 *  the folder it could not read, so its number is a lower bound and a 0 would read as done. The row stores a reading
 *  that could not be made; the event keeps the partial number and the folders. */
export function readingForClose(count: MeasureCount): MeasureCount {
  if (!count.ok || !count.unreadable || count.unreadable.length === 0) return count;
  const n = count.unreadable.length;
  return {
    ok: false,
    error: `${n} ${n === 1 ? 'folder' : 'folders'} could not be read (${count.unreadable.join(', ')}); `
      + `${count.count} counted in the folders that could be read`,
  };
}

/** Who set a measure, and whether at the task's opening; a re-reading has no setter. */
export interface MeasureSetter { setBy: string; atOpen?: true }

/** A measure is SET on a task (open or edit: a new measure is a new scope) with its first reading. */
export function setMeasure(workId: string, measure: Measure, raw: MeasureCount, at: number, by: MeasureSetter): void {
  const count = readingForClose(raw);
  const n = count.ok ? count.count : null;
  getDb().prepare(
    'UPDATE work SET measure_json = ?, measure_initial = ?, measure_remaining = ?, measure_at = ? WHERE id = ?',
  ).run(JSON.stringify(measure), n, n, at, workId);
  appendMeasured(workId, count, n, at, raw.ok && raw.unreadable?.length ? { partial: raw.count, unreadable: raw.unreadable } : null, by);
}

/** A task's measure was re-read; `remaining` null on the row = it could not be read at `at`. With
 *  `opts.keepStoredOnFailure` (the turn end's re-count) a failed reading is recorded but the row keeps its reading,
 *  so one failed sweep cannot end the job or free a close. The close door never passes it: an outage never
 *  refuses a close. */
export function recordMeasured(
  workId: string, raw: MeasureCount, at: number, opts?: { keepStoredOnFailure?: boolean },
): void {
  const count = readingForClose(raw);
  const partial = raw.ok && raw.unreadable?.length ? { partial: raw.count, unreadable: raw.unreadable } : null;
  const row = getDb().prepare('SELECT measure_initial FROM work WHERE id = ?').get(workId) as { measure_initial: number | null } | undefined;
  const initial = row?.measure_initial ?? (count.ok ? count.count : null);
  if (count.ok || !opts?.keepStoredOnFailure) writeMeasured(workId, count.ok ? count.count : null, at, initial ?? undefined);
  appendMeasured(workId, count, initial, at, partial);
}

function appendMeasured(
  workId: string, count: MeasureCount, initial: number | null, at: number,
  partial: { partial: number; unreadable: string[] } | null = null, by: MeasureSetter | null = null,
): void {
  const setter = by ? { set_by: by.setBy, ...(by.atOpen ? { at_open: true } : {}) } : {};
  appendWorkEvent(workId, MEASURED_EVENT, 'engine', count.ok
    ? { remaining: count.count, initial, at, ok: true, ...setter }
    : { remaining: null, initial, at, ok: false, error: count.error, ...(partial ?? {}), ...setter }, at);
}


/** `touched` and `byTool` are ITEMS (mailbox items and files); `commands` is how many distinct commands ran. */
export function ledgerTotals(workId: string): { touched: number; commands: number; lastAt: number | null; byTool: Array<{ tool: string; n: number }> } {
  const db = getDb();
  const t = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN ${IS_ITEM} THEN 1 ELSE 0 END), 0) AS n, COUNT(*) AS all_n, MAX(last_at) AS last FROM work_ledger WHERE work_id = ?`,
  ).get(workId) as { n: number; all_n: number; last: number | null };
  const byTool = db.prepare(`SELECT tool, COUNT(*) AS n FROM work_ledger WHERE work_id = ? AND ${IS_ITEM} GROUP BY tool ORDER BY n DESC, tool`).all(workId) as Array<{ tool: string; n: number }>;
  return { touched: t.n, commands: t.all_n - t.n, lastAt: t.last, byTool };
}

function entryOf(r: { k: string; tool: string; detail: string | null }): LedgerWorkEntry {
  if (r.k.startsWith(FILE_KEY)) return { kind: 'file', what: r.k.slice(FILE_KEY.length), tool: r.tool, status: null };
  if (r.k.startsWith(SEND_KEY)) return { kind: 'send', what: r.detail ?? '', tool: r.tool, status: null };
  return { kind: 'command', what: r.k.slice(COMMAND_KEY.length), tool: r.tool, status: r.detail };
}

/** One file, command or send entry on a task's ledger; `what` is a path, a command's text, or recipient(s). */
export interface LedgerWorkEntry { kind: 'file' | 'command' | 'send'; what: string; tool: string; status: string | null }

/** The task's file and command entries, oldest first. Mailbox items are counted (`ledgerTotals`), not
 *  listed: a sweep touches thousands of ids, and a path, a command or a send is what a reviewer can check. */
export function ledgerWorkEntries(workId: string): LedgerWorkEntry[] {
  const rows = getDb().prepare(
    `SELECT item_key AS k, tool, detail FROM work_ledger WHERE work_id = ?
       AND (substr(item_key, 1, ${FILE_KEY.length}) = '${FILE_KEY}' OR substr(item_key, 1, ${COMMAND_KEY.length}) = '${COMMAND_KEY}'
         OR substr(item_key, 1, ${SEND_KEY.length}) = '${SEND_KEY}')
     ORDER BY first_at, rowid`,
  ).all(workId) as Array<{ k: string; tool: string; detail: string | null }>;
  return rows.map(entryOf);
}


/** The task's entries in the order a review SHOWS them: failed commands, sends, files, then clean commands. */
export function ledgerListing(workId: string): LedgerWorkEntry[] {
  const rows = getDb().prepare(
    `SELECT item_key AS k, tool, detail FROM work_ledger WHERE work_id = ?
       AND (substr(item_key, 1, ${FILE_KEY.length}) = '${FILE_KEY}' OR substr(item_key, 1, ${COMMAND_KEY.length}) = '${COMMAND_KEY}'
         OR substr(item_key, 1, ${SEND_KEY.length}) = '${SEND_KEY}')
     ORDER BY last_at DESC, rowid DESC`,
  ).all(workId) as Array<{ k: string; tool: string; detail: string | null }>;
  const entries = rows.map(entryOf);
  const failed = entries.filter((e) => e.kind === 'command' && e.status !== 'exit 0');
  const sends = entries.filter((e) => e.kind === 'send');
  const files = entries.filter((e) => e.kind === 'file');
  const clean = entries.filter((e) => e.kind === 'command' && e.status === 'exit 0');
  return [...failed, ...sends, ...files, ...clean];
}
