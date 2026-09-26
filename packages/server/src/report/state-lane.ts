// ════════════════════════════════════════════════════════════════════════════════
// THE REPORT-STATE LANE — what the user can actually SEE of this agent's bug reports.
//
// ── THE DEFECT IT CLOSES, AND WHY THREE ROUNDS OF SUPPRESSION DID NOT ────────────────────
// Rounds 2-3 chased the engine's re-answer RECORD: the blocks that list or quote a settled ask
// under *"do NOT re-execute this work"*. Round 4 proved those blocks were a CARRIER and not the
// cause — with every one of them provably absent, on three fresh agents, after a real cancel, the
// model still answered *"it's sitting on your dashboard as a preview card under ID 0f6f237c-…"*.
// The claim arrives as the agent's OWN EARLIER REPLY in the ordinary fresh tail: correctly framed,
// honestly labelled history, TRUE WHEN WRITTEN — and nothing in the engine ever told the turn what
// became of the card. Measured at that HEAD: `listOpenReports` had exactly ONE consumer, the
// dashboard's own HTTP route, and no context lane, prompt assembly or memory lane read live report
// state at all. No suppression can fix that, because there is nothing false to suppress: the agent
// is reasoning correctly from everything it was shown. What was missing was a FRESHER RECORD.
//
// ── THE PATTERN IS THE TREE'S OWN, AND IT IS FOLLOWED STRUCTURALLY ───────────────────────
// `engine.open-commitments` (`memory/recall-lane.ts`) exists for exactly this class: the model
// reciting owed work that had since closed. Its answer is not suppression but a COMPLETE SNAPSHOT
// that says, in words, that it supersedes earlier mentions — *"If an earlier line still reads as
// parked, pending, outstanding or waiting on someone, that line is history and no longer applies"*
// — with (i) a completeness claim, (ii) the superseding sentence, (iii) a negative instruction
// naming the failure mode's own vocabulary. This lane is that shape, one noun over, and the
// vocabulary it names is the vocabulary the four red rounds actually produced: *"sitting on your
// dashboard"*, *"preview card"*, *"waiting for you to press Post"*.
//
// ── WHAT IT SAYS PER STATUS, AND WHY EACH SENTENCE IS THE LOAD-BEARING ONE ───────────────
// The consent gate (owner ruling D4) is that a report reaches the Dojo ONLY by the user pressing
// Post on a card they can see. So the only facts worth bytes here are the ones that decide whether
// something is IN FRONT OF THEM:
//   * `cancelled`         — WITHDRAWN. Nothing is on the dashboard, nothing reached the builders,
//                           and the honest next move is to file again if they ask. This is the
//                           sentence the four reds needed and never had;
//   * `awaiting_approval` — the preview card IS up and the decision is theirs. The engine must not
//                           imply it has been sent (no-false-delivery), so the line says what the
//                           card is waiting for;
//   * `drafting`          — opened and never submitted: no card exists yet, so there is nothing for
//                           them to see. Round 1's false-filed shape in one line;
//   * `posted`            — delivered, and it names the issue URL when the row has one (the export
//                           door writes `posted` with a path instead, so the URL is optional).
// An unrecognised status is rendered as unknown-and-not-on-the-dashboard: `store.ts`'s rule 4 safe
// direction, said out loud rather than hidden.
//
// ── BOUNDS, MEASURED ON THE LIVE BODY RATHER THAN CHOSEN ─────────────────────────────────
// 7 days and 5 rows, newest-updated first. Measured by rendering this module against a copy of the
// owner's own database (22 report rows, 16 agents holding any): the busiest agent — BehaviorBot, the
// release ritual's own — renders 5 rows / 1,397 bytes; every one-row agent renders 969-1,081 bytes;
// and 126 of the box's 138 agents render NOTHING AT ALL, having never filed a report. The 7-day
// horizon is what makes "not listed here" safe to say: a card older than that is not something a
// re-ask is about, and the elision line states the bound rather than implying completeness the read
// does not have (the same rule `renderSnapshot`'s hidden-count line follows).
//
// ── EMPTY IS ABSENT ──────────────────────────────────────────────────────────────────────
// No rows in the window → this returns `null` and the injection site pushes nothing: no header, no
// slot, no bytes. Unlike the commitments snapshot, an empty set here has nothing to correct — an
// agent that never filed a report cannot be reciting a dead card — and every byte in the tail is
// one the provider re-bills on the turns that follow.
//
// ── THE CACHE-PREFIX LAW ─────────────────────────────────────────────────────────────────
// This is per-turn volatile state. It is pushed by the loop PAST `volatileFrom`, beside
// `engine.open-commitments`, and nothing ahead of `msg.turn-context` moves. No tool, no system
// text, no registry prefix entry: `agent/tools/definitions.ts` is not touched, so the cache-prefix
// golden cannot move. Its time terms are RECORDED INSTANTS (`recordedInstant`), never a clock
// reading, so an unchanged set of rows is byte-identical on every turn — the property
// `the-tail-holds-still` pins for every other block in the tail.
// ════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { recordedInstant } from '../memory/message-stamp.js';
import type { ReportStatus } from './store.js';

/** How far back a report is still worth telling the agent about. */
export const REPORT_STATE_WINDOW_DAYS = 7;
/** How many rows the block may print. Newest-updated first. */
export const REPORT_STATE_MAX_ROWS = 5;

export const REPORT_STATE_HEAD = '═══ YOUR DOJO BUG REPORTS — CURRENT STATE, READ FROM THE ROWS ═══';
export const REPORT_STATE_TAIL = '═══ END DOJO BUG REPORTS ═══';

/**
 * The superseding sentence, and it is the whole point of the lane.
 *
 * Modelled on `SNAPSHOT_SUPERSEDES` and deliberately naming the words the model actually used in
 * the four red rounds, because a negative instruction that does not name the failure's own
 * vocabulary is one the model does not recognise itself in (HL5's finding, carried).
 */
const SUPERSEDES =
  'This supersedes every earlier mention of a report in this conversation, including your own '
  + 'replies: those were true when written and this is true NOW. A report reaches the Dojo ONLY '
  + 'when the user presses Post on a preview card they can see, so if an earlier line of yours '
  + 'says a card is "sitting on your dashboard", is a "preview card", or is "waiting for you to '
  + 'press Post", and that report is not listed below as PREVIEW CARD UP, then that line is '
  + 'history and no longer applies — do not repeat it as the current state.';

export interface ReportStateRow {
  id: string;
  status: ReportStatus | string;
  /** SQLite datetime TEXT, as `dojo_reports` writes it. */
  updatedAt: string;
  issueUrl: string | null;
  exportPath: string | null;
}

/** The word this release uses for each state, in the user's terms rather than the column's. */
function stateWord(status: string): string {
  switch (status) {
    case 'cancelled': return 'WITHDRAWN';
    case 'awaiting_approval': return 'PREVIEW CARD UP';
    case 'drafting': return 'UNFINISHED';
    case 'approved': return 'APPROVED, SENDING';
    case 'posted': return 'FILED';
    // `store.ts` rule 4's direction, said rather than hidden: a value this release does not
    // recognise is not a card the user can see.
    default: return 'UNRECOGNISED STATE — treat as NOT on their dashboard';
  }
}

/**
 * ⚠ THE CONSEQUENCES ARE A LEGEND, NOT A SENTENCE PER ROW, AND THAT IS A MEASUREMENT.
 * Written once per row, the five withdrawn rows of the owner's busiest agent rendered 2,598 bytes
 * with the same 260-character sentence five times over — in a tail the provider re-bills on every
 * following turn. As a legend covering only the states PRESENT, the same agent renders 1,185 and
 * one row costs ~60 bytes. The load-bearing truths are unchanged; only the repetition is gone.
 */
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
  if (parts.length === 0) {
    parts.push('A state this release does not recognise is not a card the user can see — do not '
      + 'claim it is filed.');
  }
  return `What these states mean: ${parts.join(' ')}`;
}

/** One row: the id, the state word, the recorded instant, and a link only when there is one. */
function renderRow(r: ReportStateRow): string {
  const link = r.status === 'posted' ? ` — ${r.issueUrl ?? r.exportPath ?? '(no link recorded)'}` : '';
  return `${r.id} — ${stateWord(String(r.status))} ${recordedInstant(r.updatedAt)}${link}`;
}

/**
 * The block, a PURE FUNCTION of its rows — so "identical rows ⇒ identical bytes" is assertable,
 * which is the property `the-tail-holds-still` exists to hold for every block in the tail.
 */
export function renderReportStateBlock(
  rows: readonly ReportStateRow[], totalInWindow = rows.length,
): string | null {
  if (rows.length === 0) return null;
  const lines = rows.map((r, i) => `${i + 1}. ${renderRow(r)}`);
  const hidden = Math.max(0, totalInWindow - rows.length);
  // An elision is never silent, and the bound is stated rather than implied: this read is the
  // newest few of a window, never "everything that ever existed".
  const bound = hidden > 0
    ? `Showing the ${rows.length} most recently changed of ${totalInWindow} reports from the last `
      + `${REPORT_STATE_WINDOW_DAYS} days; the rest are older changes and none of them is a card `
      + 'on their dashboard.'
    : `That is every report of yours changed in the last ${REPORT_STATE_WINDOW_DAYS} days. `
      + 'Anything not listed is not on their dashboard.';
  const legend = legendFor([...new Set(rows.map((r) => String(r.status)))]);
  return `${REPORT_STATE_HEAD}\n${SUPERSEDES}\n${legend}\n${lines.join('\n')}\n${bound}\n${REPORT_STATE_TAIL}`;
}

/**
 * The read: this agent's own report rows, newest CHANGE first, bounded.
 *
 * `updated_at` rather than `created_at` is the ordering and the horizon, because the fact the lane
 * carries is the row's CURRENT state — a report filed eight days ago and cancelled this morning is
 * exactly the row a re-ask is about. Indexed only by the table's small size (there is no index on
 * `agent_id`; 22 rows on the owner's box, and `withdrawn-claim.ts` records the same measurement
 * and the condition for adding one).
 */
export function recentReportRows(
  agentId: string, limit = REPORT_STATE_MAX_ROWS,
): { rows: ReportStateRow[]; totalInWindow: number } {
  const db = getDb();
  const since = `-${REPORT_STATE_WINDOW_DAYS} days`;
  const rows = db.prepare(
    `SELECT id, status, updated_at AS updatedAt, issue_url AS issueUrl, export_path AS exportPath
       FROM dojo_reports
      WHERE agent_id = ? AND updated_at >= datetime('now', ?)
      ORDER BY updated_at DESC, id DESC LIMIT ?`,
  ).all(agentId, since, limit) as ReportStateRow[];
  const total = db.prepare(
    `SELECT count(*) AS n FROM dojo_reports
      WHERE agent_id = ? AND updated_at >= datetime('now', ?)`,
  ).get(agentId, since) as { n: number };
  return { rows, totalInWindow: total.n };
}

/**
 * What the injection site calls: the read and the render, or `null` when this agent has no report
 * activity in the window. One function so the site stays one line, exactly as
 * `buildOpenWorkInjection` does for `engine.open-work`.
 */
export function buildReportStateInjection(agentId: string): string | null {
  const { rows, totalInWindow } = recentReportRows(agentId);
  return renderReportStateBlock(rows, totalInWindow);
}
