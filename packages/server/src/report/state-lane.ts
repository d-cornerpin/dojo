// The report-state lane: what the user can actually SEE of this agent's bug reports, read from the rows.
// An earlier reply ("it's sitting on your dashboard as a preview card") was true when written and nothing
// tells the turn what became of the card, so this is a fresher record, shaped like `engine.open-commitments`
// (`memory/recall-lane.ts`): a complete snapshot, a superseding sentence, and a negative instruction.
// The consent gate: a report reaches the Dojo only when the user presses Post on a card they can see, so
// each status line says whether a card is in front of them. An unrecognised status is not on the dashboard.
// No rows in the window returns `null` and nothing is pushed (every tail byte is re-billed on later turns).
// Per-turn volatile state: pushed by the loop past `volatileFrom` beside `engine.open-commitments`;
// nothing ahead of `msg.turn-context` moves. Time terms are recorded instants (`recordedInstant`), never
// a clock, so unchanged rows are byte-identical on every turn.

import { getDb } from '../db/connection.js';
import { recordedInstant } from '../memory/message-stamp.js';
import type { ReportStatus } from './store.js';

/** How far back a report is still worth telling the agent about. */
export const REPORT_STATE_WINDOW_DAYS = 7;
/** How many SETTLED rows the block may print. Newest-updated first. */
export const REPORT_STATE_MAX_ROWS = 5;
/** Safety cap on LIVE (non-terminal) rows, which never age out or get elided; hitting it is REPORTED. */
export const REPORT_STATE_LIVE_CAP = 20;

export const REPORT_STATE_HEAD = '═══ YOUR DOJO BUG REPORTS — CURRENT STATE, READ FROM THE ROWS ═══';
export const REPORT_STATE_TAIL = '═══ END DOJO BUG REPORTS ═══';

/** The superseding sentence (as `SNAPSHOT_SUPERSEDES`); it names the words the model used. */
const SUPERSEDES =
  'This supersedes every earlier mention of a report in this conversation, including your own '
  + 'replies: those were true when written and this is true NOW. A report reaches the Dojo ONLY '
  + 'when the user presses Post on a preview card they can see, so if an earlier line of yours '
  + 'says a card is "sitting on your dashboard", is a "preview card", or is "waiting for you to '
  + 'press Post", and that report is not listed below as PREVIEW CARD UP, then that line is '
  + 'history and no longer applies — do not repeat it as the current state.';

/** What one read of this agent's report state holds: the live rows and the settled window. */
export interface ReportStateRead {
  live: ReportStateRow[];
  settled: ReportStateRow[];
  settledInWindow: number;
  /** True when the live safety cap was hit: the block then withholds its negative claim. */
  liveTruncated: boolean;
}

export interface ReportStateRow {
  id: string;
  status: ReportStatus | string;
  updatedAt: string;
  issueUrl: string | null;
  exportPath: string | null;
}

/** The lane's word for a row: `markExported` writes `posted` with an `export_path` and no `issue_url`, which
 *  read `exported`, not FILED, so FILED keeps one meaning (a link that reached the builders). */
function laneState(r: ReportStateRow): string {
  if (r.status === 'posted' && r.issueUrl === null && r.exportPath !== null) return 'exported';
  return String(r.status);
}

function stateWord(status: string): string {
  switch (status) {
    case 'cancelled': return 'WITHDRAWN';
    case 'awaiting_approval': return 'PREVIEW CARD UP';
    case 'drafting': return 'UNFINISHED';
    case 'approved': return 'APPROVED, SENDING';
    case 'posted': return 'FILED';
    case 'exported': return 'EXPORTED TO THIS BOX';
    default: return 'UNRECOGNISED STATE — treat as NOT on their dashboard';
  }
}

/** A legend over only the states PRESENT, not a sentence per row: repeated text is re-billed each turn. */
function legendFor(statuses: readonly string[]): string {
  const has = (s: string) => statuses.includes(s);
  const parts: string[] = [];
  if (has('cancelled')) {
    parts.push('WITHDRAWN means the user can see NOTHING for it — no preview card exists and '
      + 'nothing reached the Dojo builders. It cannot be revived: if they ask about it again, file '
      + 'a FRESH report with dojo_report rather than pointing them at that one.');
  }
  if (has('drafting')) {
    parts.push('UNFINISHED means you opened a report and never submitted it, so there is no card '
      + 'and the user can see NOTHING yet. This one CAN still be finished — dojo_report '
      + 'phase="draft" then phase="submit" on that id — or say plainly that nothing is filed.');
  }
  if (has('awaiting_approval')) {
    parts.push('PREVIEW CARD UP means a card IS on their dashboard and the decision is theirs: '
      + 'Post sends it to the Dojo builders, Cancel drops it. Nothing has been sent yet and you '
      + 'cannot press Post for them.');
  }
  if (has('approved')) {
    parts.push('APPROVED, SENDING means they pressed Post and the send is in flight — do not '
      + 'promise a link until the row reads FILED.');
  }
  if (has('posted')) parts.push('FILED means it reached the builders, at the link shown.');
  if (has('exported')) {
    parts.push('EXPORTED TO THIS BOX means the report was written to a FILE on this machine '
      + 'because the box could not reach GitHub — it has NOT reached the Dojo builders. The path '
      + 'shown is local: do not offer it as a link, and do not say the report was filed or sent. '
      + 'Someone has to hand that file over.');
  }
  if (parts.length === 0) {
    parts.push('A state this release does not recognise is not a card the user can see — do not '
      + 'claim it is filed.');
  }
  return `What these states mean: ${parts.join(' ')}`;
}

function renderRow(r: ReportStateRow): string {
  const state = laneState(r);
  // The export path is LABELLED so the row cannot read as an address someone else could open.
  const link = state === 'exported' ? ` — written to ${r.exportPath ?? ''}`
    : r.status === 'posted' ? ` — ${r.issueUrl ?? r.exportPath ?? '(no link recorded)'}` : '';
  return `${r.id} — ${stateWord(state)} ${recordedInstant(r.updatedAt)}${link}`;
}

/** A non-terminal row never ages out and is never elided by the cap, and the negative claim ("anything not
 *  listed is not on their dashboard") is made only when every live row was read: otherwise a live card could
 *  be called history and die at the gate. Terminal rows age out: `cancelReport` stamps `updated_at`. */
export function renderReportStateBlock(read: ReportStateRead): string | null;
export function renderReportStateBlock(
  rows: readonly ReportStateRow[], totalInWindow?: number,
): string | null;
export function renderReportStateBlock(
  arg: ReportStateRead | readonly ReportStateRow[], totalInWindow?: number,
): string | null {
  const read: ReportStateRead = Array.isArray(arg)
    ? { live: [], settled: arg as ReportStateRow[], settledInWindow: totalInWindow ?? arg.length, liveTruncated: false }
    : arg as ReportStateRead;
  const rows = [...read.live, ...read.settled];
  if (rows.length === 0) return null;
  const lines = rows.map((r, i) => `${i + 1}. ${renderRow(r)}`);
  const hiddenSettled = Math.max(0, read.settledInWindow - read.settled.length);
  const settledNote = hiddenSettled > 0
    ? ` Older WITHDRAWN/FILED reports are not listed: these are the ${read.settled.length} most `
      + `recently changed of ${read.settledInWindow} from the last ${REPORT_STATE_WINDOW_DAYS} days.`
    : '';
  const bound = read.liveTruncated
    ? `⚠ INCOMPLETE: you hold more live reports than this block lists (${read.live.length} shown). `
      + 'Do NOT tell the user that nothing of theirs is pending — some of their cards are not on '
      + 'this list.' + settledNote
    : 'Every report of yours that is still LIVE is listed above, however old it is — so anything '
      + 'not listed is settled, and not a card on their dashboard.' + settledNote;
  const legend = legendFor([...new Set(rows.map(laneState))]);
  return `${REPORT_STATE_HEAD}\n${SUPERSEDES}\n${legend}\n${lines.join('\n')}\n${bound}\n${REPORT_STATE_TAIL}`;
}

const NON_TERMINAL: readonly string[] = ['drafting', 'awaiting_approval', 'approved'];

/** Two statements, as live and settled rows follow different laws. `updated_at` orders and bounds them
 *  because the lane carries the row's CURRENT state: a report cancelled this morning is fresh at any age. */
export function recentReportRows(
  agentId: string, limit = REPORT_STATE_MAX_ROWS,
): ReportStateRead {
  const db = getDb();
  const since = `-${REPORT_STATE_WINDOW_DAYS} days`;
  const marks = NON_TERMINAL.map(() => '?').join(', ');
  const live = db.prepare(
    `SELECT id, status, updated_at AS updatedAt, issue_url AS issueUrl, export_path AS exportPath
       FROM dojo_reports
      WHERE agent_id = ? AND status IN (${marks})
      ORDER BY updated_at DESC, id DESC LIMIT ?`,
  ).all(agentId, ...NON_TERMINAL, REPORT_STATE_LIVE_CAP + 1) as ReportStateRow[];
  const liveTruncated = live.length > REPORT_STATE_LIVE_CAP;
  const settled = db.prepare(
    `SELECT id, status, updated_at AS updatedAt, issue_url AS issueUrl, export_path AS exportPath
       FROM dojo_reports
      WHERE agent_id = ? AND status NOT IN (${marks}) AND updated_at >= datetime('now', ?)
      ORDER BY updated_at DESC, id DESC LIMIT ?`,
  ).all(agentId, ...NON_TERMINAL, since, limit) as ReportStateRow[];
  const total = db.prepare(
    `SELECT count(*) AS n FROM dojo_reports
      WHERE agent_id = ? AND status NOT IN (${marks}) AND updated_at >= datetime('now', ?)`,
  ).get(agentId, ...NON_TERMINAL, since) as { n: number };
  return {
    live: liveTruncated ? live.slice(0, REPORT_STATE_LIVE_CAP) : live,
    settled,
    settledInWindow: total.n,
    liveTruncated,
  };
}

/** The read and the render, or `null` when this agent has nothing live and nothing settled in the window. */
export function buildReportStateInjection(agentId: string): string | null {
  return renderReportStateBlock(recentReportRows(agentId));
}
