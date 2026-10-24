// v3.5 DONE IS MEASURED — the Progress line a task carries on its agent's own board
// (`memory/work-board-lane.ts`): what the task's calls touched (the engine's ledger) and what its
// measure last returned, of how many at the start, and WHEN it was read. Facts from the records
// only, never a claim.
//
// The instant is the RECORDED instant, never "N minutes ago": the board's T67b rule (a block that
// is a function of the wall clock cannot be asserted about, and the current time is already in
// view). The two model-authored terms (the query and the unit) are cut at the board's title width
// when the view cannot hold them whole, like every other term the board does not author.
import { getDb } from '../db/connection.js';
import { parseMeasure, describeMeasure, type Measure } from './measure.js';
import { ledgerTotals } from './ledger-store.js';
import { recordedInstant } from '../memory/message-stamp.js';

export interface MeasureFacts {
  measure: Measure | null;
  initial: number | null;
  remaining: number | null;
  at: number | null;
  touched: number;
}

/** A task's measure and ledger, or null when it has neither. */
export function readMeasureFacts(taskId: string): MeasureFacts | null {
  const row = getDb().prepare('SELECT measure_json, measure_initial, measure_remaining, measure_at FROM work WHERE id = ?')
    .get(taskId) as { measure_json: string | null; measure_initial: number | null; measure_remaining: number | null; measure_at: number | null } | undefined;
  let measure: Measure | null = null;
  if (row?.measure_json) {
    try { const p = parseMeasure(JSON.parse(row.measure_json)); if (p.ok) measure = p.measure; } catch { /* an unreadable measure reads as none */ }
  }
  const { touched } = ledgerTotals(taskId);
  if (!measure && touched === 0) return null;
  return { measure, initial: row?.measure_initial ?? null, remaining: row?.measure_remaining ?? null, at: row?.measure_at ?? null, touched };
}

const n = (x: number): string => x.toLocaleString('en-US');
const cut = (s: string, width: number): string => (s.length > width ? `${s.slice(0, width)}...` : s);

/** The one Progress line. `termWidth` bounds the query and the unit (the board's title width). */
export function formatMeasureLine(f: MeasureFacts, termWidth = Infinity): string {
  if (!f.measure) {
    return `Progress: ${n(f.touched)} items touched (no measure set — set one with work_update(action="edit", measure=…) if this task covers a set of items)`;
  }
  const unit = cut(f.measure.unit, termWidth);
  const head = `Progress: ${n(f.touched)} ${unit} touched; measure ${f.measure.tool} "${cut(f.measure.args.query, termWidth)}"`;
  const start = f.initial === null ? '?' : n(f.initial);
  if (f.remaining === null) return `${head} could not be read at ${recordedInstant(f.at)} (${start} at start)`;
  return `${head} returned ${n(f.remaining)} remaining (of ${start} at start), measured ${recordedInstant(f.at)}`;
}

/** v3.5 Part C1 (the assignment notice, `tracker/notify.ts`): a measured task states its count and the continuation; an unmeasured one is told how to get one. */
export function assignmentMeasureLine(taskId: string): string {
  const f = readMeasureFacts(taskId);
  if (!f?.measure) {
    return `Work it through. If it covers a set of items, set its measure (work_update(action="edit", task_id="${taskId}", measure={tool:"gmail_search", args:{query:"<what is still to do>"}})) so the engine counts for you.`;
  }
  const now = f.remaining === null ? 'could not be read yet' : `returns ${f.remaining} ${f.measure.unit} now`;
  return `This task is measured: ${describeMeasure(f.measure)} ${now}. It is done when that reads 0; the engine keeps the count of items you touch and re-counts the measure at the end of each turn that makes progress. When such a turn ends with items left, the engine continues you on the next turn.`;
}
