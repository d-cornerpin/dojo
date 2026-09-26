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
// Two laws, because the two halves of the read are not alike (see the render's F1 note). SETTLED
// rows: 7 days, 5 rows, newest change first. LIVE rows: every one, at any age, bounded only by a
// safety cap whose being hit is REPORTED. Measured by rendering this module against a copy of the
// owner's own database (22 report rows, 16 agents holding any, and 0 non-terminal rows on the whole
// box today):
//
//   widest REAL agent (BehaviorBot, the ritual's own, 5 settled)        5 rows / 1,452 bytes
//   every one-row agent                                                        1,014-1,136 bytes
//   126 of the box's 138 agents                                                NOTHING AT ALL
//   widest REALISTIC shape — 5 rows, all five states, every legend line         2,262 bytes
//   PATHOLOGICAL bound — the live cap hit, plus 5 settled                       4,033 bytes
//
// The last line is the honest answer to "what if an agent holds many non-terminal rows": it renders
// 20 of them, states that the list is incomplete, and WITHHOLDS the negative completeness claim. It
// cannot grow past that, and it cannot lie about what it left out.
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
/** How many SETTLED rows the block may print. Newest-updated first. */
export const REPORT_STATE_MAX_ROWS = 5;
/**
 * The safety cap on LIVE (non-terminal) rows — which never age out and are never elided, so this is
 * the only thing standing between a pathological agent and an unbounded tail block. 20 is chosen
 * against the schema rather than against today's data: `awaiting_approval` is one card per filing
 * and the dashboard lists at most 50, `drafting` rows are unfinished calls, `approved` lasts
 * seconds — and 0 non-terminal rows exist on the owner's box today. Hitting it is REPORTED, not
 * hidden: the block withholds its negative completeness claim (see the render's F1 note).
 */
export const REPORT_STATE_LIVE_CAP = 20;

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

/** What one read of this agent's report state holds: the live rows and the settled window. */
export interface ReportStateRead {
  /** Non-terminal rows — every one of them, at any age. The user may still be looking at these. */
  live: ReportStateRow[];
  /** Terminal rows inside the horizon, capped. */
  settled: ReportStateRow[];
  /** How many terminal rows the horizon holds in total, so an elision can state itself. */
  settledInWindow: number;
  /** True when the live safety cap was hit — the block then WITHHOLDS its negative claim. */
  liveTruncated: boolean;
}

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
 * ⚠ F1, THE REVIEW'S MEDIUM, AND IT IS THE MIRROR IMAGE OF THE DEFECT THIS LANE CLOSES.
 *
 * The first cut made an UNCONDITIONAL negative completeness claim — *"anything not listed is not on
 * their dashboard"* — over a read that was bounded by a horizon AND a row cap. Two reachable shapes
 * made that claim FALSE, and only in the direction that kills a real report:
 *   SHAPE A  five cancels today plus one `awaiting_approval` from three days ago: the standing card
 *            is squeezed out by the 5-row cap while `listOpenReports()` still returns it;
 *   SHAPE B  an `awaiting_approval` row from nine days ago plus one fresh cancel: aged out.
 * In both, the superseding sentence then tells the model that a TRUE *"your card is waiting"* line
 * "is history and no longer applies" — so the agent says nothing is pending, the user never presses
 * Post, and a real report dies at the consent gate. That is D4's gate failing the other way round.
 *
 * THE RULE, and it makes the sentence true BY CONSTRUCTION instead of by luck: a NON-TERMINAL row
 * (`drafting` / `awaiting_approval` / `approved`) never ages out and is never elided by the cap.
 * Terminal rows (`cancelled` / `posted`) keep the 7-day horizon and the cap, because their
 * `updated_at` is refreshed at the moment that matters — `cancelReport` stamps `datetime('now')`, so
 * a withdrawn row is always FRESH at the instant of withdrawal (the reviewer measured this, and it
 * is why the horizon is safe for terminal rows and only for terminal rows).
 *
 * IT IS CHEAP BY CONSTRUCTION, AND THE PATHOLOGICAL CASE IS STILL BOUNDED. Non-terminal rows are
 * few: `awaiting_approval` is one card per filing and the dashboard lists at most 50, `drafting` is
 * an unfinished call, `approved` is in flight for seconds — 0 exist on the owner's box today. But
 * "few by construction" is not "bounded by the schema", and nothing in the tree expires a row
 * (`bundle.ts`'s sweep removes report DIRECTORIES, never rows). So the read takes a SAFETY CAP
 * (`REPORT_STATE_LIVE_CAP`), and when it is hit the block WITHHOLDS the negative claim and says so:
 * an incomplete list that admits it is incomplete cannot tell the model a live card is history.
 */
export function renderReportStateBlock(read: ReportStateRead): string | null;
export function renderReportStateBlock(
  rows: readonly ReportStateRow[], totalInWindow?: number,
): string | null;
export function renderReportStateBlock(
  arg: ReportStateRead | readonly ReportStateRow[], totalInWindow?: number,
): string | null {
  // The array form is kept for the clauses that render a hand-built row set; it means "all of these
  // are settled", which is what a caller passing bare rows can honestly claim.
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
  // THE NEGATIVE CLAIM IS CONDITIONAL ON HAVING READ EVERY LIVE ROW. That is the whole of F1.
  const bound = read.liveTruncated
    ? `⚠ INCOMPLETE: you hold more live reports than this block lists (${read.live.length} shown). `
      + 'Do NOT tell the user that nothing of theirs is pending — some of their cards are not on '
      + 'this list.' + settledNote
    : 'Every report of yours that is still LIVE is listed above, however old it is — so anything '
      + 'not listed is settled, and not a card on their dashboard.' + settledNote;
  const legend = legendFor([...new Set(rows.map((r) => String(r.status)))]);
  return `${REPORT_STATE_HEAD}\n${SUPERSEDES}\n${legend}\n${lines.join('\n')}\n${bound}\n${REPORT_STATE_TAIL}`;
}

/** A row nobody has settled: the user may still be looking at it, or still owed a card. */
const NON_TERMINAL: readonly string[] = ['drafting', 'awaiting_approval', 'approved'];

/**
 * The read, in TWO statements because the two halves have different laws (see the render's F1 note).
 *
 * LIVE: every non-terminal row, no horizon, ordered newest-change-first, bounded only by the safety
 * cap that exists so a pathological agent cannot blow the tail — and hitting that cap is reported
 * rather than hidden. SETTLED: terminal rows inside the horizon, capped, with the in-window total so
 * the elision can state itself.
 *
 * `updated_at` is the ordering and the horizon because the fact the lane carries is the row's
 * CURRENT state: a report filed eight days ago and cancelled this morning is exactly the row a
 * re-ask is about. Both statements are `SCAN dojo_reports` — 22 rows on the owner's box; the
 * condition for indexing `agent_id` is recorded in `withdrawn-claim.ts` beside the same measurement.
 */
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

/**
 * What the injection site calls: the read and the render, or `null` when this agent has nothing live
 * and nothing settled in the window. One function so the site stays one line, exactly as
 * `buildOpenWorkInjection` does for `engine.open-work`.
 */
export function buildReportStateInjection(agentId: string): string | null {
  return renderReportStateBlock(recentReportRows(agentId));
}
