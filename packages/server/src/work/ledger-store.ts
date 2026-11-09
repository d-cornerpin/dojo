// v3.5 DONE IS MEASURED: the SQL for a task's ledger (`work_ledger`, migration 200) and for the
// engine's readings of its measure. Lives under work/ because every write to the spine does
// (work/__tests__/single-writer-conformance.test.ts).
//
// The ledger is written by the engine from the agent's successful mutation calls
// (agent/v2/steps/execute/tracker-counting.ts, beside the effort charge), never by the model.
// One row per (task, item): a re-touch moves `last_at`, so COUNT(*) is "distinct items touched".
//
// v3.5 field fix 3 (#6a): the same ledger holds the worker's file and command work, so a task done
// in files and shell has a structural record too. A file it wrote is an item ("file:<path>"). A
// command it ran ("cmd:<command>", with its exit status in `detail`, migration 211) is a RECORD of
// the work and never an item: a command is as often a read (`ls`, `cat`) as a change, so the
// measured-job readers below (momentum, "touched", the stall check) count items only.
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

// ── Which items a call touches, as stable keys: "gmail:msg:<id>", "outlook:conv:<id>", "file:<path>", "cmd:<command>" ──

/** The non-mailbox prefixes. A `cmd:` entry is a record of work, never an item (see below). A
 *  `send:` entry is one delivery to a person, keyed by the call that made it. */
export const FILE_KEY = 'file:';
export const COMMAND_KEY = 'cmd:';
export const SEND_KEY = 'send:';
/** SQL: this ledger row is an item (anything but a command record). */
export const IS_ITEM = `substr(item_key, 1, ${COMMAND_KEY.length}) <> '${COMMAND_KEY}'`;

/**
 * The agent(s) a send addresses (`args.agent` / `args.group_id`),
 * or undefined when the call is not a send to another agent. Such a send is work on the record ONLY
 * with the engine's verified receipt for that exact call (`work/ledger-store.ts`): an answer the main
 * agent gave another agent is real work, and on the owner's box the record could not see it.
 */
export function agentSendRecipientsOf(args: Record<string, unknown>, effects: readonly ToolEffect[]): string[] | undefined {
  const sends = effects.filter((e) => e.kind === 'send' && (e.from === 'args.agent' || e.from === 'args.group_id'));
  if (sends.length === 0) return undefined;
  const named = sends.flatMap((e) => argValues(args, e.from)).filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
  return [...new Set(named)];
}

/**
 * The recipient(s) a successful SEND names, from the tool's declared `send` effect, or null
 * when the declaration derives the recipient (a reply goes to the message's sender). `undefined` when
 * the call is not a send to a person: no `send` effect, or one addressed to another agent or an agent
 * group (`args.agent` / `args.group_id`): that one is read by `agentSendRecipientsOf`, and reaches the
 * ledger only on its verified receipt.
 */
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

/** The per-message Outlook mutations: each takes one `message_id`. */
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

/** The command text a `proc` / `shell` argument names: an argv array joined, or a script as written. */
function commandText(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) return (v as string[]).join(' ').trim() || null;
  return null;
}

/** The files and commands a call's declared effects name, as ledger keys. */
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

/** The items a MUTATION call touches, as stable keys. Reads touch nothing. `effects`: the tool's own
 *  declared effects, for its file and command work. */
export function itemKeysOf(toolName: string, args: Record<string, unknown>, effects: readonly ToolEffect[] = []): string[] {
  return uniq([...mailboxKeysOf(toolName, args), ...effectKeysOf(args, effects)]);
}

/** The mailbox items a call touches. */
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

/** One reading of a task's measure, on the task's own spine. Written by the engine (`'engine'`),
 *  so a reading is a record and never reads as the task moving (`taskMovedAtSql`). */
export const MEASURED_EVENT = 'measured' as const satisfies WorkEventKind;

/** Record the items a call touched for a task. Returns the rows inserted or touched. `detail`: a
 *  command's exit status (the newest run's), null for everything else. */
export function recordTouched(
  workId: string, tool: string, keys: string[], at: number = Date.now(), detail: string | null = null,
  /** The call that wrote a command row (re-review 5, P1b): how a backgrounded command settles it. */
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

/** One of THIS round's tool results, as the executor hands them to the count (`turnToolResults`). */
export interface RoundResult { toolCallId: string; isError: boolean; errorCode?: string; content?: string; keptWhole?: string }

/** Did this round's result for the call succeed? Its own flags, never its words (see below). */
export const succeededIn = (roundResults: ReadonlyArray<RoundResult>) => (call: { id?: string }): boolean => {
  const r = roundResults.find((x) => x.toolCallId === call.id);
  return !!r && !r.isError && !r.errorCode;
};

/** The ledger charge for one round's calls (agent/v2/steps/execute/tracker-counting.ts, beside the
 *  effort charge, to the same task): the items each call touched, ONLY when this round holds that
 *  call's result and it succeeded. Success is the result's own flags (`isError`, a structural
 *  `errorCode`), never its words: a refusal reads "Refused: …" as often as "Error: …".
 *  One failure IS a partial success: a `gmail_label` whose batch partly applied is an Error result
 *  (the engine's `isError` reads the first word), yet the ids the text says WERE applied are real
 *  touches — record those, and only those (`appliedKeysOf`, google/gmail-label.ts). */
export function recordCallsTouched(
  workId: string,
  calls: ReadonlyArray<{ id: string; name: string; arguments?: Record<string, unknown> }>,
  roundResults: ReadonlyArray<RoundResult>,
  /** Each tool's declared effects (`agent/tools/registry.ts` `effectsFor`), for its file and command work. */
  effectsOf: (toolName: string) => readonly ToolEffect[] | undefined,
  /** The agent that made the calls: whose handed credentials are scrubbed from every key and detail. */
  agentId: string,
): void {
  const ok = succeededIn(roundResults);
  // Review H3 (architecture rule 6): a command or a path can carry a credential the agent was handed
  // (the model sees the real value), so every key and every detail goes through the tree's ONE
  // redactor before it is written, exactly as the process audit row does (`agent/tools/util.ts:88`).
  // The request and the verdict record read the ledger, so they only ever see the redacted form.
  const safe = (k: string): string => redactHandedCredentials(agentId, k);
  for (const tc of calls) {
    if (ok(tc)) {
      const keys = [...new Set(itemKeysOf(tc.name, tc.arguments ?? {}, effectsOf(tc.name) ?? []).map(safe))];
      const commands = keys.filter((k) => k.startsWith(COMMAND_KEY));
      const items = keys.filter((k) => !k.startsWith(COMMAND_KEY));
      if (items.length > 0) recordTouched(workId, tc.name, items);
      if (commands.length > 0) {
        const r = roundResults.find((x) => x.toolCallId === tc.id);
        // Re-review 4 (N4) / 5 (P1b): a call handed to the background has its hand-off row, by call id.
        // Running: the row says so, and the hand-off settles it by call id when the command ends. Ended
        // before this write: its real status, from that row.
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
      // A successful send to a person is one delivery on the ledger, keyed by its call,
      // with the recipient(s) its arguments name (redacted like every other entry).
      const to = sendRecipientsOf(tc.arguments ?? {}, effectsOf(tc.name) ?? []);
      if (to !== undefined) recordTouched(workId, tc.name, [`${SEND_KEY}${tc.id}`], Date.now(), to ? safe(to.join(', ')) : null);
      // A send to another agent is one delivery on the ledger too, on the engine's own VERIFIED receipt
      // for this exact call, and only when it hands the work to the agent that asked for it with more than
      // a status claim: a "done" to the PM is never work on the record (`work/done/asker.ts`).
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

/** The engine's verified receipt for one call (`tool_receipts.call_id`, written by the tool's executor). */
const titleOf = (workId: string): string | null =>
  (getDb().prepare('SELECT title FROM work WHERE id = ?').get(workId) as { title: string | null } | undefined)?.title ?? null;

function verifiedReceiptFor(callId: string, agentId: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM tool_receipts WHERE call_id = ? AND agent_id = ? AND verified = 1 LIMIT 1').get(callId, agentId);
}

/** C4: a receipt carried no task id unless the close gate consumed it in its own turn, so a send made a
 *  turn before the close belonged to no task. The call was charged to this task, so its receipts are
 *  tied to it here (first tie wins, as at the gate: `receipts/store.ts:stampReceiptsTask`). */
function stampCallReceipts(callId: string, agentId: string, workId: string): void {
  getDb().prepare(`UPDATE tool_receipts SET task_id = ?, updated_at = datetime('now') WHERE call_id = ? AND agent_id = ? AND task_id IS NULL`)
    .run(workId, callId, agentId);
}

/** Distinct items touched (or re-touched) after `sinceMs`. */
export function ledgerTouchedSince(workId: string, sinceMs: number): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM work_ledger WHERE work_id = ? AND last_at > ? AND ${IS_ITEM}`).get(workId, sinceMs) as { n: number }).n;
}

/** v3.5 D1: items this task touched for the FIRST time after `sinceMs`. The turn end's momentum reads
 *  this, not `ledgerTouchedSince`: re-touching what the task already touched is not progress, so a
 *  loop over the same items cannot keep a job continuing (`post-call-classify/job-continues.ts`). */
export function ledgerNewItemsSince(workId: string, sinceMs: number): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM work_ledger WHERE work_id = ? AND first_at > ? AND ${IS_ITEM}`).get(workId, sinceMs) as { n: number }).n;
}

/** Store a reading of the task's measure. `remaining` null = the measure could not be read at `at`;
 *  `initial` is given only when the measure is set (a new measure is a new scope). Field fix 3
 *  re-review 2 (S2): a measure that could not be read at set takes its first successful reading as
 *  its start, so "did the count come down" has an answer for it too. */
export function writeMeasured(workId: string, remaining: number | null, at: number, initial?: number): void {
  getDb().prepare(
    'UPDATE work SET measure_remaining = ?, measure_at = ?, measure_initial = COALESCE(?, measure_initial, ?) WHERE id = ?',
  ).run(remaining, at, initial ?? null, remaining, workId);
}

/** A measure is SET on a task (open, or an edit: a new measure is a new scope), with its first reading. */
/**
 * Re-review 3 (M4): a count that could not read every folder it covers is NO READING for any close. The
 * files still to do may sit exactly in the folder it could not read (a revoked permission, an offline
 * volume), so its number is a lower bound and a 0 from it would read as done. The task's row therefore
 * stores it as a reading that could not be made; the event keeps the partial number and the folders,
 * named, for display.
 */
export function readingForClose(count: MeasureCount): MeasureCount {
  if (!count.ok || !count.unreadable || count.unreadable.length === 0) return count;
  const n = count.unreadable.length;
  return {
    ok: false,
    error: `${n} ${n === 1 ? 'folder' : 'folders'} could not be read (${count.unreadable.join(', ')}); `
      + `${count.count} counted in the folders that could be read`,
  };
}

export function setMeasure(workId: string, measure: Measure, raw: MeasureCount, at: number): void {
  const count = readingForClose(raw);
  const n = count.ok ? count.count : null;
  getDb().prepare(
    'UPDATE work SET measure_json = ?, measure_initial = ?, measure_remaining = ?, measure_at = ? WHERE id = ?',
  ).run(JSON.stringify(measure), n, n, at, workId);
  appendMeasured(workId, count, n, at, raw.ok && raw.unreadable?.length ? { partial: raw.count, unreadable: raw.unreadable } : null);
}

/** A task's measure was re-read. `remaining` null on the row = it could not be read at `at`. The
 *  first successful reading of a measure that could not be read when it was set becomes its start.
 *  `opts.keepStoredOnFailure` (the turn end's re-count, `post-call-classify/job-turn-end.ts`): a
 *  failed reading is still said on the record, but the row keeps the reading it held — the job and
 *  the close gate read that row, and one failed sweep must not end the job or free a close. The
 *  close door's re-read never passes it: NULL there is the ruling (an outage never refuses a close). */
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
  partial: { partial: number; unreadable: string[] } | null = null,
): void {
  appendWorkEvent(workId, MEASURED_EVENT, 'engine', count.ok
    ? { remaining: count.count, initial, at, ok: true }
    : { remaining: null, initial, at, ok: false, error: count.error, ...(partial ?? {}) }, at);
}

// ── The ledger's readers ──

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

/** One file or command entry on a task's ledger, as the validation request and the verdict record show it. */
/** `what`: a file's path, a command's text, or a send's recipient(s) (empty when the tool derives them). */
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


/** The task's file, send and command entries in the order a review SHOWS them: the commands
 *  that failed first, then the sends, then the files the work wrote, then the commands that
 *  exited 0, each newest first. The ledger keeps everything; a reader lays this out in its own room. */
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
