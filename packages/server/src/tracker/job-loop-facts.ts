// WHAT THE PM'S REVIEW SHOWS ABOUT A HAND-IN'S WORK: its measure and the ledger of what its calls touched.
import { STILL_RUNNING } from '../work/command-status.js';
import { getDb } from '../db/connection.js';
import { ledgerTotals, ledgerListing, type LedgerWorkEntry } from '../work/ledger-store.js';
import { layOutInRoom } from '../memory/other-threads-room.js';
import { parseMeasure, describeMeasure } from '../work/measure.js';
import { listTaskLog } from './task-log.js';
import { msToUtcText } from '../work/tracker-view.js';

const fmt = (v: number): string => v.toLocaleString('en-US');
type Reading = { ok?: boolean; remaining?: number | null; at?: number; error?: string } | null;

/** The Measure line: a reading, a reading plus the worker's named remainder, an unreadable one, or none. */
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
      + (good ? `last good reading ${fmt(good.remaining as number)} at ${msToUtcText(good.at ?? 0)}` : 'no earlier reading');
  }
  const named = r.measure_remaining === 0 ? undefined
    : listTaskLog(taskId, { kinds: ['observation'] }).map((e) => e.note ?? '').find((x) => x.startsWith('Remainder named at close:'));   // newest first
  return `${name}: ${fmt(r.measure_remaining)} remaining${r.measure_initial === null ? '' : ` of ${fmt(r.measure_initial)} at start`}`
    + `${r.measure_at ? ` (measured ${msToUtcText(r.measure_at)})` : ''}${named ? `, named by the worker: ${named.slice('Remainder named at close:'.length).trim()}` : ''}`;
}

/** What the validator judges a close on: the measure and the ledger of what the task's calls touched. */
export function validationMeasureLines(taskId: string, roomTokens?: number): string {
  const { touched, commands, byTool } = ledgerTotals(taskId);
  // Files written and commands run, one per line, so the validator can open what the work produced;
  // the review lists a page laid out in `roomTokens` (failures, files, clean commands; newest first)
  // and counts the rest. The ledger itself records everything.
  const entries = ledgerListing(taskId);
  const head = `\n  Measure: ${measureText(taskId, touched, commands, byTool)}`
    + `\n  Ledger: ${fmt(touched)} items touched (${byTool.map((b) => `${b.tool} ${fmt(b.n)}`).join(', ') || 'none'})`
    + `${commands > 0 ? `, ${commandsRun(commands)}` : ''}`;
  const lineOf = (e: LedgerWorkEntry): string => {
    if (e.kind === 'file') return `\n    file written: ${e.what} (${e.tool})`;
    if (e.kind === 'send') return `\n    sent: ${e.what ? `to ${e.what} ` : ''}(${e.tool})`;
    return `\n    command run: ${commandShown(e.what)} (${e.tool}, ${e.status ?? 'exit unknown'})`;
  };
  return layOutInRoom(entries.length, roomTokens, (n) => head + entries.slice(0, n).map(lineOf).join('') + notListedLine(entries.slice(n)));
}

const commandsRun = (n: number): string => `${fmt(n)} ${n === 1 ? 'command' : 'commands'} run`;

/** A command as the review shows it: a one-liner whole, a script by its first line and size. */
function commandShown(cmd: string): string {
  const lines = cmd.split('\n');
  if (lines.length === 1) return cmd.trim();
  return `${lines[0].trim()} (+${fmt(lines.length - 1)} more ${lines.length === 2 ? 'line' : 'lines'}, ${fmt(cmd.length)} characters)`;
}

/** The count of the entries the room could not list, by kind. Empty when everything was listed. */
function notListedLine(rest: readonly LedgerWorkEntry[]): string {
  if (rest.length === 0) return '';
  const files = rest.filter((e) => e.kind === 'file').length;
  // A command still running in the background has not failed; it is counted apart.
  const running = rest.filter((e) => e.kind === 'command' && e.status === STILL_RUNNING).length;
  const failed = rest.filter((e) => e.kind === 'command' && e.status !== 'exit 0' && e.status !== STILL_RUNNING).length;
  const clean = rest.length - files - failed - running - rest.filter((e) => e.kind === 'send').length;
  const sends = rest.filter((e) => e.kind === 'send').length;
  const parts = [
    failed ? `${fmt(failed)} more ${failed === 1 ? 'command' : 'commands'} that failed` : '',
    running ? `${fmt(running)} more ${running === 1 ? 'command' : 'commands'} still running` : '',
    sends ? `${fmt(sends)} more ${sends === 1 ? 'send' : 'sends'}` : '',
    files ? `${fmt(files)} more ${files === 1 ? 'file' : 'files'}` : '',
    clean ? `${fmt(clean)} more ${clean === 1 ? 'command' : 'commands'} that exited 0` : '',
  ].filter(Boolean);
  return `\n    … and ${parts.join(', ')}, not listed (all of it is on the ledger)`;
}

/** The room one row's ledger listing may take in a review: a layout share of the PM's measured budget,
 *  split across the rows. Not a cap on what is recorded. */
export const REVIEW_LEDGER_ROOM_SHARE = 0.25;
export function reviewLedgerRoomTokens(assemblyBudgetTokens: number, rowsInReview: number): number {
  return Math.max(0, Math.floor((assemblyBudgetTokens * REVIEW_LEDGER_ROOM_SHARE) / Math.max(1, rowsInReview)));
}
