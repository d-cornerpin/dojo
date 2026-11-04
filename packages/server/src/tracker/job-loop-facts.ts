// v3.5 D1, FIX ROUND 2 (ruling 3) — WHAT THE PM'S CHECK-IN LADDER KNOWS ABOUT A CONTINUED JOB.
//
// The ladder holds for the job in flight (the agent's carry) and while the agent is mid-turn. A
// measured job the engine keeps continuing (`agent/v2/steps/post-call-classify/job-continues.ts`) is
// almost always one or the other, so a chain of continuations that touches no item, only ever making
// new reads, would never be checked in on. The hold stands for such a job only while it is touching
// items; one that is not lets the ladder run on its existing rungs, and the check-in carries the fact.
import { getDb } from '../db/connection.js';
import { ledgerLastNewItemAt, ledgerNewItemsSince, ledgerTotals, ledgerWorkEntries } from '../work/ledger-store.js';
import { lastTurnEnd } from '../work/job-momentum.js';
import { parseMeasure, describeMeasure } from '../work/measure.js';
import { listTaskLog } from './task-log.js';

/** Is this a measured job the engine has been continuing that touched NO new item since `sinceMs`
 *  (the last check-in, or before the first, the start of the first rung's own window)? */
export function continuedJobTouchingNothing(taskId: string, sinceMs: number): boolean {
  const row = getDb().prepare('SELECT measure_json FROM work WHERE id = ?').get(taskId) as { measure_json: string | null } | undefined;
  if (!row?.measure_json || lastTurnEnd(taskId)?.kind !== 'continued') return false;
  return ledgerNewItemsSince(taskId, sinceMs) === 0;
}

/** The fact the check-in carries: continuations since the job last touched an item, and what is left. */
export function continuedJobFact(taskId: string): string | null {
  const db = getDb();
  const lastItem = ledgerLastNewItemAt(taskId);
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'continued' AND created_at > ?`).get(taskId, lastItem) as { n: number }).n;
  if (n === 0) return null;
  const left = (db.prepare('SELECT measure_remaining AS r FROM work WHERE id = ?').get(taskId) as { r: number | null } | undefined)?.r ?? null;
  const times = n === 1 ? '1 time' : `${n} times`;
  return `Continued ${times} since it last touched an item${left === null ? '' : `; ${left.toLocaleString('en-US')} left on its measure`}.`;
}

/** v3.5 text wave (Part C5, t250 fix round 3 NB2): the fact a check-in carries for a MEASURED task with
 *  items left, or null (unmeasured, never read, or reading 0). */
export function measuredLeftFact(taskId: string): string | null {
  const row = getDb().prepare('SELECT measure_json, measure_initial, measure_remaining FROM work WHERE id = ?')
    .get(taskId) as { measure_json: string | null; measure_initial: number | null; measure_remaining: number | null } | undefined;
  if (!row?.measure_json || row.measure_remaining === null || row.measure_remaining <= 0) return null;
  let parsed: ReturnType<typeof parseMeasure>;
  try { parsed = parseMeasure(JSON.parse(row.measure_json)); } catch { return null; }
  if (!parsed.ok) return null;
  const start = row.measure_initial === null ? '' : ` (of ${row.measure_initial.toLocaleString('en-US')} at the start)`;
  return `Its measure (${describeMeasure(parsed.measure)}) still returns ${row.measure_remaining.toLocaleString('en-US')} ${parsed.measure.unit}${start}.`;
}

/** The check-in handed to a continued job at its PARK (t261's short form). The PM rider is read as a
 *  400-character gist, so the facts and the answer lead and the title (any length) comes last. */
export function parkCheckInText(task: { id: string; title: string }, idleMinutes: number): string {
  const fact = continuedJobFact(task.id) ?? measuredLeftFact(task.id);
  return `[PM check-in] ${fact ? `${fact} ` : ''}Still on it? A work_note saying what is next answers this. `
    + `Waiting on someone? status="paused" or "blocked" with the reason. Task "${task.title}", ID: ${task.id}, no movement for ${idleMinutes} minutes.`;
}

const utc = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const fmt = (v: number): string => v.toLocaleString('en-US');
type Reading = { ok?: boolean; remaining?: number | null; at?: number; error?: string } | null;

/** The Measure line of the validation request, in one of its shapes: a reading, a reading with the
 *  remainder the worker named, a reading that could not be made, or no measure at all. */
function measureText(taskId: string, touched: number, commands: number, byTool: Array<{ tool: string }>): string {
  const db = getDb();
  const r = db.prepare('SELECT measure_json, measure_initial, measure_remaining, measure_at FROM work WHERE id = ?')
    .get(taskId) as { measure_json: string | null; measure_initial: number | null; measure_remaining: number | null; measure_at: number | null } | undefined;
  let parsed: ReturnType<typeof parseMeasure> | null = null;
  try { parsed = r?.measure_json ? parseMeasure(JSON.parse(r.measure_json)) : null; } catch { parsed = null; }
  if (r?.measure_json && !parsed?.ok) return 'could not be read (measure unparsable)';   // a measure IS set; it cannot be understood
  if (!r || !parsed?.ok) {
    if (touched > 0) return `none set; ledger shows ${fmt(touched)} items touched by ${byTool.map((b) => b.tool).join(', ')}`;
    return commands > 0 ? `none set; ledger shows ${commandsRun(commands)}` : 'none set';
  }
  const name = describeMeasure(parsed.measure);
  if (r.measure_remaining === null) {
    // The newest reading that worked, and why the latest did not: both are on the task's own spine.
    const reads = (db.prepare(`SELECT payload FROM work_events WHERE work_id = ? AND kind = 'measured' ORDER BY id DESC`).all(taskId) as Array<{ payload: string | null }>)
      .map((e): Reading => { try { return JSON.parse(e.payload ?? 'null') as Reading; } catch { return null; } });
    const good = reads.find((x) => x?.ok === true && typeof x.remaining === 'number');
    const why = reads.find((x) => x?.ok === false)?.error;
    return `${name}: could not be read at close${why ? ` (${why.slice(0, 160)})` : ''} — `
      + (good ? `last good reading ${fmt(good.remaining as number)} at ${utc(good.at ?? 0)}` : 'no earlier reading');
  }
  const named = r.measure_remaining === 0 ? undefined
    : listTaskLog(taskId, { kinds: ['observation'] }).map((e) => e.note ?? '').find((x) => x.startsWith('Remainder named at close:'));   // newest first
  return `${name}: ${fmt(r.measure_remaining)} remaining${r.measure_initial === null ? '' : ` of ${fmt(r.measure_initial)} at start`}`
    + `${r.measure_at ? ` (measured ${utc(r.measure_at)})` : ''}${named ? ` — named by the worker: ${named.slice('Remainder named at close:'.length).trim()}` : ''}`;
}

/** What the validator judges a close on, from the records (done-is-measured E1): the measure, and the
 *  ledger of what the task's calls touched. The remainder the worker named rides on the Measure line. */
export function validationMeasureLines(taskId: string): string {
  const { touched, commands, byTool } = ledgerTotals(taskId);
  // v3.5 field fix 3 (#6a): the files the task's calls wrote and the commands they ran, one per line,
  // so the validator can open what the work produced instead of reading the worker's account of it.
  const work = ledgerWorkEntries(taskId).map((e) => e.kind === 'file'
    ? `\n    file written: ${e.what} (${e.tool})`
    : `\n    command run: ${excerpt(e.what)} (${e.tool}, ${e.status ?? 'exit unknown'})`).join('');
  return `\n  Measure: ${measureText(taskId, touched, commands, byTool)}`
    + `\n  Ledger: ${fmt(touched)} items touched (${byTool.map((b) => `${b.tool} ${fmt(b.n)}`).join(', ') || 'none'})`
    + `${commands > 0 ? `, ${commandsRun(commands)}` : ''}${work}`;
}

const commandsRun = (n: number): string => `${fmt(n)} ${n === 1 ? 'command' : 'commands'} run`;
const COMMAND_EXCERPT_CHARS = 300;   // a display excerpt; the ledger keeps the whole command
const excerpt = (cmd: string): string => {
  const flat = cmd.replace(/\s+/g, ' ').trim();
  return flat.length > COMMAND_EXCERPT_CHARS ? `${flat.slice(0, COMMAND_EXCERPT_CHARS)}…` : flat;
};
