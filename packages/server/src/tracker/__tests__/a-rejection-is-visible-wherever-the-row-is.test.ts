// ════════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 12 / T49 — A REJECTION IS VISIBLE WHEREVER THE ROW IS.
//
// ── THE INCIDENT (round-12 S4, dev DB, re-queried by the orchestrator at `e6f7842`) ──
// Row `ea2fc25e…` "Reorganize project notes: plan + summary file". Its ledger, in order:
//   • 24597 `transition` claimed→blocked by pm, reason "PM rejected the close: No summary
//     file was ever delivered — …"
//   • 24598 `claim_rejected` {claim_state:'done'}
//   • 24599 `audit` {entry_kind:'reject', from_status:'complete', to_status:'blocked',
//     reason:"No summary file was ever delivered — …"}     ← the PM ruling
//   • 24600 `transition` blocked→paused by the agent
//   • 24601 `audit` {entry_kind:'observation', action_taken:'notes attached to
//     status=paused', note:"Waiting on David to name the notes folder …"}  ← the pause reason
//   • 24602 `claim_upheld` {claim_state:'paused'}          ← NOT a close: a blessed wait
//
// Twenty-four hours later the agent told the owner the deliverables "were delivered" and that
// the row was "paused until you tell me to proceed". Catalog §8.5 rows 2–3: claim 2 is
// UNBACKED — the ledger records the opposite — and claim 3 is backed as to STATE while the
// stated reason is not the recorded one. The agent acted on the rejection at the time; what
// failed is every LATER turn, because neither surface it reads carries either fact.
// `work_update(action="list")` renders Blocked/Paused rows title-only, and
// `work_update(action="get")` renders a State line and no adjudication at all.
//
// WHAT THIS PINS — one door, both halves, and both are the ROW'S OWN RECORDED WORDS
// truncated, never engine authorship:
//   (a) list  — Blocked and Paused rows carry the newest recorded note as one clause.
//   (b) get   — "Last PM ruling: REJECTED — <recorded reason>" when the latest PM
//               adjudication is a rejection no upheld close has answered.
// CONTROLS, named in the plan and pinned below: an upheld CLOSE shows no ruling line; a
// `claim_upheld{paused}` (24602's shape) does NOT count as one; rows with no recorded notes
// render byte-identically to today.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t49-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));

import { runMigrations } from '../../db/migrations.js';
import {
  openTrackerProject, openTrackerTask, setTrackerStatus, upholdClaim, throwBackClaim,
} from '../../work/tracker-store.js';
import { trackerListActive, trackerGetStatus } from '../tools.js';
import { writeTaskLog } from '../task-log.js';

const AGENT = 'behaviorbot';
const PM = 'kelly';

/** Verbatim from event 24599 — the PM's recorded rejection reason. */
const REJECT_REASON =
  'No summary file was ever delivered — the only on-record delivery for this task is your '
  + 'interim "checking likely locations" message, which does not meet the goal (list notes '
  + 'folder, read two largest, write summary file); there is no notes folder, so set this '
  + 'task to blocked and ask David which folder he means instead of claiming completion.';

/** Verbatim from event 24601 — the pause reason the reply never surfaced. */
const PAUSE_NOTE =
  'Waiting on David to name the notes folder for the reorganization (asked in dashboard '
  + '2026-08-15: options are create ~/Documents/Project-Notes, keep loose .md files in home, '
  + 'or his own path). BehaviorBot should hold until his answer is relayed.';

/** Verbatim from event 24280 — the agent's own blocked note, one status change earlier. */
const BLOCKED_NOTE =
  'Cannot locate the "notes folder": searched ~, ~/Documents, ~/Desktop, ~/Downloads, '
  + '~/.dojo, and /tmp for any directory named notes/Notes — none exists.';

let projectId = '';

function newTask(title: string): string {
  return openTrackerTask({
    projectId, title, status: 'in_progress', assignedTo: AGENT, createdBy: AGENT,
    origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
  });
}

function seedDelivery(id: string): string {
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, created_at)
     VALUES (?, ?, NULL, 'dashboard', 'dashboard', 'delivered', datetime('now'))`,
  ).run(id, AGENT);
  return id;
}

/** The PM rejection, filed exactly as `trackerValidateComplete`'s reject path files it
 *  (`tracker/tools.ts:4212-4234`): the move, the thrown-back claim, the `reject` entry. */
function pmRejectsTheClose(taskId: string, reason = REJECT_REASON): void {
  setTrackerStatus(taskId, 'blocked', {
    by: 'pm', actorId: PM, claim: 'authoritative',
    reason: `PM rejected the close: ${reason}`,
  });
  throwBackClaim(taskId, 'done', 'pm', PM, reason);
  writeTaskLog({
    taskId, fromEntity: 'pm', entryKind: 'reject',
    fromStatus: 'complete', toStatus: 'blocked',
    actionTaken: 'work_validate(action="validate", kind=complete, valid=false)',
    reason,
  });
}

/** THE S4 ROW, replayed end to end: rejected close, then paused with the wait note, then the
 *  PM's blessing OF THE PAUSE (24602) — which is not an answer to the close. */
function seedS4Row(): string {
  const t = newTask('Reorganize project notes: plan + summary file');
  setTrackerStatus(t, 'blocked', {
    by: 'agent', actorId: AGENT, claim: 'requests-validation',
    reason: 'work_update(action="status") -> blocked',
  });
  writeTaskLog({
    taskId: t, fromEntity: `agent:${AGENT}`, entryKind: 'observation',
    actionTaken: 'notes attached to status=blocked', note: BLOCKED_NOTE,
  });
  setTrackerStatus(t, 'in_progress', {
    by: 'agent', actorId: AGENT, claim: 'requests-validation',
    reason: 'work_update(action="status") -> in_progress',
  });
  pmRejectsTheClose(t);
  setTrackerStatus(t, 'paused', {
    by: 'agent', actorId: AGENT, claim: 'requests-validation',
    reason: 'work_update(action="status") -> paused', syncSchedulePause: true,
  });
  writeTaskLog({
    taskId: t, fromEntity: `agent:${AGENT}`, entryKind: 'observation',
    actionTaken: 'notes attached to status=paused', note: PAUSE_NOTE,
  });
  upholdClaim(t, 'paused', 'pm', PM, 'PM confirmed the pause is a real wait condition');
  return t;
}

/** A blocked row carrying the agent's own recorded reason and nothing else. */
function seedBlockedWithNote(): string {
  const t = newTask('Find the notes folder');
  setTrackerStatus(t, 'blocked', {
    by: 'agent', actorId: AGENT, claim: 'requests-validation',
    reason: 'work_update(action="status") -> blocked',
  });
  writeTaskLog({
    taskId: t, fromEntity: `agent:${AGENT}`, entryKind: 'observation',
    actionTaken: 'notes attached to status=blocked', note: BLOCKED_NOTE,
  });
  return t;
}

/** CONTROL fixture: a stopped row with NO recorded note of any kind. */
function seedBareRow(status: 'blocked' | 'paused', title: string): string {
  const t = newTask(title);
  setTrackerStatus(t, status, {
    by: 'agent', actorId: AGENT, claim: 'requests-validation',
    reason: `work_update(action="status") -> ${status}`,
    syncSchedulePause: status === 'paused',
  });
  return t;
}

/** The section body for one heading, as an array of lines (heading excluded). */
function section(out: string, heading: string): string[] {
  const lines = out.split('\n');
  const at = lines.findIndex((l) => l.startsWith(heading));
  expect(at, `the list must contain a "${heading}" section`).toBeGreaterThan(-1);
  const body: string[] = [];
  for (let i = at + 1; i < lines.length && lines[i] !== ''; i++) body.push(lines[i]);
  return body;
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'BehaviorBot', 'idle', '1970-01-01')`).run(AGENT);
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Kelly', 'idle', '1970-01-01')`).run(PM);
  projectId = openTrackerProject({
    title: 'Notes reorg', createdBy: AGENT,
    origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — HALF (a): the LIST clause on Blocked and Paused rows.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('T49 (a): a stopped row states its own recorded reason on the board', () => {
  it('THE S4 SHAPE: the Paused row carries the recorded wait, not just a title', () => {
    seedS4Row();
    const body = section(trackerListActive(AGENT, {}), 'Paused Tasks (1):');
    const joined = body.join('\n');
    expect(joined, 'the pause reason is the row\'s own recorded words').toContain(
      'Waiting on David to name the notes folder for the reorganization',
    );
  });

  it('a Blocked row carries its recorded reason too', () => {
    seedBlockedWithNote();
    const joined = section(trackerListActive(AGENT, {}), 'Blocked Tasks (1):').join('\n');
    expect(joined).toContain('Cannot locate the "notes folder"');
  });

  it('the clause is TRUNCATED — one line on a board row, never the whole note', () => {
    seedS4Row();
    const clause = section(trackerListActive(AGENT, {}), 'Paused Tasks (1):')
      .find((l) => l.includes('Waiting on David'))!;
    expect(clause, 'a board row is one line').not.toContain('\n');
    expect(clause.length).toBeLessThan(200);
    expect(clause, 'the tail is cut, so the note is not reproduced whole')
      .not.toContain('until his answer is relayed');
  });

  it('the status-filtered read of the same rows carries it too', () => {
    seedBlockedWithNote();
    expect(trackerListActive(AGENT, { status: 'blocked' }))
      .toContain('Cannot locate the "notes folder"');
  });

  it('CONTROL: a row with no recorded notes renders EXACTLY as today', () => {
    const id = seedBareRow('paused', 'Nothing was ever written down here');
    const body = section(trackerListActive(AGENT, {}), 'Paused Tasks (1):');
    expect(body).toEqual([
      `  [${id.slice(0, 8)}] Nothing was ever written down here [BehaviorBot] (normal)`,
    ]);
  });

  it('CONTROL: On Deck rows are untouched — this door is Blocked and Paused only', () => {
    const t = newTask('Something on deck');
    setTrackerStatus(t, 'on_deck', {
      by: 'agent', actorId: AGENT, claim: 'requests-validation',
      reason: 'work_update(action="status") -> on_deck',
    });
    writeTaskLog({
      taskId: t, fromEntity: `agent:${AGENT}`, entryKind: 'observation',
      note: 'a note that must not reach the on-deck row',
    });
    const body = section(trackerListActive(AGENT, {}), 'On Deck Tasks (1):');
    expect(body).toEqual([`  [${t.slice(0, 8)}] Something on deck [BehaviorBot] (normal)`]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — HALF (b): the GET ruling line.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('T49 (b): the detail read states the last PM ruling when it is a rejection', () => {
  it('THE S4 SHAPE: the rejection is on the row the agent reads', () => {
    const t = seedS4Row();
    const out = trackerGetStatus(AGENT, { taskId: t });
    expect(out).toContain('Last PM ruling: REJECTED — No summary file was ever delivered');
  });

  it('the ruling reason is the RECORDED one, truncated — no engine words added', () => {
    const t = seedS4Row();
    const line = trackerGetStatus(AGENT, { taskId: t })
      .split('\n').find((l) => l.startsWith('Last PM ruling:'))!;
    const quoted = line.slice('Last PM ruling: REJECTED — '.length).replace(/\.\.\.$/, '');
    expect(REJECT_REASON.startsWith(quoted),
      'every quoted byte is a prefix of what the PM actually recorded').toBe(true);
  });

  it('a blocked row whose close the PM rejected says so as well', () => {
    const t = newTask('Migrate field 15');
    pmRejectsTheClose(t, 'evidence does not show field-15 was migrated; finish it and resubmit');
    expect(trackerGetStatus(AGENT, { taskId: t })).toContain(
      'Last PM ruling: REJECTED — evidence does not show field-15 was migrated',
    );
  });

  it('CONTROL: a claim_upheld{paused} does NOT count as an upheld close (event 24602)', () => {
    // This is the incident's own tail. If a blessed WAIT silenced the ruling line, T49 would
    // be dark on the very row it was written for.
    const t = seedS4Row();
    expect(trackerGetStatus(AGENT, { taskId: t })).toContain('Last PM ruling: REJECTED');
  });

  it('CONTROL: an upheld CLOSE shows NO ruling line', () => {
    const t = newTask('Migrate field 15');
    pmRejectsTheClose(t, 'evidence does not show field-15 was migrated; finish it and resubmit');
    // The agent redoes the work and files again; the PM blesses it this time.
    setTrackerStatus(t, 'complete', {
      by: 'pm', actorId: PM, claim: 'authoritative',
      resultDeliveryId: seedDelivery('d-field15'), reason: 'PM validated the close',
    });
    upholdClaim(t, 'done', 'pm', PM, 'PM validated the close against the goal');
    const out = trackerGetStatus(AGENT, { taskId: t });
    expect(out).not.toContain('Last PM ruling');
    expect(out).not.toContain('REJECTED');
  });

  it('CONTROL: a row with no adjudication at all is unchanged', () => {
    const t = seedBlockedWithNote();
    expect(trackerGetStatus(AGENT, { taskId: t })).not.toContain('Last PM ruling');
  });

  it('CONTROL: an OWNER send-back is not reported as a PM ruling', () => {
    const t = newTask('Book the venue');
    setTrackerStatus(t, 'in_progress', {
      by: 'agent', actorId: AGENT, claim: 'requests-validation',
      reason: 'work_update(action="status") -> in_progress',
    });
    writeTaskLog({
      taskId: t, fromEntity: 'user', entryKind: 'reject',
      fromStatus: 'complete', toStatus: 'in_progress',
      actionTaken: 'apply_user_validation via behaviorbot (validated=false)',
      reason: 'that is not the venue I asked for',
    });
    expect(trackerGetStatus(AGENT, { taskId: t }),
      '"Last PM ruling" must never be printed over words the PM did not say')
      .not.toContain('Last PM ruling');
  });
});
