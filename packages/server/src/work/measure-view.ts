// The Progress line a task carries on its agent's board (`memory/work-board-lane.ts`): what the task's calls
// touched, what its measure last returned, of how many at the start, and when. The instant is the RECORDED
// instant, never "N minutes ago": a block that follows the wall clock cannot be asserted about. The query and
// unit (model-authored) are cut at the board's title width.
import { getDb } from '../db/connection.js';
import { parseMeasure, describeMeasure, measureSubject, type Measure } from './measure.js';
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
    return `Progress: ${n(f.touched)} items touched (no measure set — set one with work_update(action="edit", measure=…) if this task covers a set of mailbox messages)`;
  }
  const unit = cut(f.measure.unit, termWidth);
  const subject = f.measure.args.query !== undefined ? `"${cut(f.measure.args.query, termWidth)}"` : cut(measureSubject(f.measure), termWidth);
  const head = `Progress: ${n(f.touched)} ${unit} touched; measure ${f.measure.tool} ${subject}`;
  const start = f.initial === null ? '?' : n(f.initial);
  if (f.remaining === null) return `${head} could not be read at ${recordedInstant(f.at)} (${start} at start)`;
  return `${head} returned ${n(f.remaining)} remaining (of ${start} at start), measured ${recordedInstant(f.at)}`;
}

/** The assignment notice's measure line (`tracker/notify.ts`): its count, or how to set a measure. */
export function assignmentMeasureLine(taskId: string): string {
  const f = readMeasureFacts(taskId);
  if (!f?.measure) {
    return `Work it through. If it covers a set of mailbox messages, set its measure (work_update(action="edit", task_id="${taskId}", measure={tool:"gmail_search", args:{query:"<what is still to do>"}})) so the engine counts for you.`;
  }
  const now = f.remaining === null ? 'could not be read yet' : `returns ${f.remaining} ${f.measure.unit} now`;
  return `This task is measured: ${describeMeasure(f.measure)} ${now}. It is done when that reads 0; the engine keeps the count of items you touch and re-counts the measure at the end of each turn that makes progress. When such a turn ends with items left, the engine continues you on the next turn.`;
}
