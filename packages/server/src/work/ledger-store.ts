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
import { itemKeysOf, sendRecipientsOf, agentSendRecipientsOf, COMMAND_KEY, SEND_KEY } from '../tools/item-keys.js';
import { IS_ITEM } from './ledger-read.js';
import { agentSendCountsAsWork } from './send-counts-as-work.js';
import { redactHandedCredentials } from '../credentials/secret-values.js';
// The ledger's readers live in the leaf `ledger-read.ts` (the verdict record reads them from a module the
// spine imports, so they must not pull this file's provider imports); re-exported here for the callers.
export { ledgerTotals, ledgerWorkEntries, type LedgerWorkEntry } from './ledger-read.js';
import type { ToolEffect } from '../agent/tools/types.js';
import { appliedKeysOf } from '../google/gmail-label.js';
import { appendWorkEvent } from './store.js';
import { STILL_RUNNING, exitStatusOf } from './command-status.js';
import { handOffForCall, ledgerTookHandOff } from '../agent/background-commands.js';
import type { WorkEventKind } from './event-kinds.js';
import type { Measure, MeasureCount } from './measure.js';

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

const base = (name: string): string => name.startsWith('user_') ? name.slice(5) : name;

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
      // Audit #5: a successful send to a person is one delivery on the ledger, keyed by its call,
      // with the recipient(s) its arguments name (redacted like every other entry).
      const to = sendRecipientsOf(tc.arguments ?? {}, effectsOf(tc.name) ?? []);
      if (to !== undefined) recordTouched(workId, tc.name, [`${SEND_KEY}${tc.id}`], Date.now(), to ? safe(to.join(', ')) : null);
      // C4: a send to another agent is one delivery on the ledger too, but only on the engine's own
      // VERIFIED receipt for this exact call (the transport's persisted peer message): the record never
      // counts a send that did not land, and never one the model only claimed.
      // The C4 loophole (owner ruling: the PM verifies so a worker cannot close a job on its own say-so):
      // the send counts only when it delivers the work to the party the task serves, never a send to the
      // PM, the task's validator or a service agent, and never one that only claims a status
      // (`work/send-counts-as-work.ts`).
      const peers = to === undefined ? agentSendRecipientsOf(tc.arguments ?? {}, effectsOf(tc.name) ?? []) : undefined;
      const a = tc.arguments ?? {};
      if (peers !== undefined && verifiedReceiptFor(tc.id, agentId) && agentSendCountsAsWork(workId, {
        recipients: typeof a.group_id === 'string' && a.group_id.trim() ? [] : peers,
        intent: typeof a.intent === 'string' ? a.intent : null,
        text: typeof a.payload === 'string' ? a.payload : null,
      })) {
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

/** When the task last touched an ITEM for the first time (0 when never): the continued-job fact's anchor. */
export function ledgerLastNewItemAt(workId: string): number {
  return (getDb().prepare(`SELECT MAX(first_at) AS at FROM work_ledger WHERE work_id = ? AND ${IS_ITEM}`).get(workId) as { at: number | null }).at ?? 0;
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
