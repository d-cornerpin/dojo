// ════════════════════════════════════════════════════════════════════════════════════════
// THE VERSION-GAP RECONCILIATION PASS — the owner's "stale project checker".
// ✅ OWNER-REQUESTED 2026-08-06, from his own agent's report on his preflight box.
// Landed by SWEEP CORE-2 item 3 (SWEEP-F's INBOUND).
//
// ── HIS CASE ────────────────────────────────────────────────────────────────────────────
// A prior build's broken `close_project` left his production dojo carrying 27 stale projects
// while the board reported 29 "Active" with zero in-progress work. The fix ships; the wreckage
// stays. That is the whole of the problem: a release repairs the DOOR, and nothing has ever
// gone back to look at what walked through the broken one.
//
// ── WHAT THE ORCHESTRATOR VERIFIED BY COMMAND, AND WHAT IT COULD NOT ────────────────────
// (a) No such mechanism exists — nothing in the tree reconciles tracker state across a version
//     change (`update-state.ts` is the update flow only).
// (b) `work_update:close_project` IS wired at HEAD (`agent/tools/cat/tracker.ts:776`), so his
//     older build's defect is his box's history and is not re-derivable here.
// (c) ⚠ THE DEV BODY CANNOT CONFIRM THE POPULATION. Measured 2026-08-06: 228 projects, ALL
//     terminal (222 done / 6 abandoned); zero-task ghosts **0**; all-terminal-but-open **0** —
//     because this box was reset during the overhaul. That is ABSENCE OF EVIDENCE, NOT EVIDENCE
//     OF ABSENCE (#15). The coverage for every shape below is therefore an ADVERSARIAL BODY
//     carrying all of them at once (`__tests__/version-gap-reconcile.test.ts`), plus a rehearsal
//     on a `VACUUM INTO` copy of the real box recorded in the task report. Nobody should read a
//     green run on this box as proof the checks would find anything on his.
//
// ── REPORT, NEVER REWRITE — AND THE ONE EXCEPTION ───────────────────────────────────────
// The orchestrator's rider, earned by the anchor work: report, never rewrite, EXCEPT where a
// STRUCTURAL invariant makes the case unambiguous. Everything else surfaces WITH ITS ONE-CALL
// CORRECTION, because a stored state carries no record of intent and rewriting on inference
// moves real work.
//
// So exactly ONE of the four shapes is repaired — and it is not repaired HERE. Shape (a) is
// handed to `tracker/tools.ts:checkProjectCompletion`, which that file's own header calls *"the
// SINGLE authority for the success-vs-fail-open call"*. This module finds candidates; the
// authority decides. That is why there is no `UPDATE work` anywhere in this file and no second
// closer, and a conformance clause holds it that way. It also means D-K comes along for free:
// a project whose last task FELL is left OPEN and labelled, never announced as done.
//
// ── HIS SAFETY CONSTRAINTS, ADOPTED VERBATIM ────────────────────────────────────────────
//   * never close a project holding any `in_progress`/`on_deck` task
//   * never touch task-level data
//   * flag-don't-touch when ambiguous
// The first is structural: shape (a) requires EVERY task terminal, so a live task disqualifies
// the project before anything is handed anywhere — and the authority independently refuses on
// its own count, so the constraint holds even if this module's predicate were wrong. The second
// is why shape (d) is a report and not a reassignment. The third is why a zero-task project is
// flagged and never closed: "no tasks" reads as wreckage on his box and as "I am building this
// right now" on anybody's, and a stored row cannot tell you which.
//
// ── A DENOMINATOR IS MANDATORY ──────────────────────────────────────────────────────────
// How many were EXAMINED, not only how many changed (#11). Every examined project lands in
// exactly one named bucket — a finding or a NAMED stand-down — and the test asserts the sum.
// "The rest" is not a reason.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { postAgentNotice } from '../agent/agent-notice.js';
import { getPMAgentId, getPrimaryAgentId } from '../config/platform.js';
import { projectScope, taskScope } from '../work/tracker-view.js';

const logger = createLogger('version-gap');

/** The durable sink. Logs rotate; a report the owner can open must not. */
export const VERSION_GAP_REPORT_KEY = 'version_gap_reconcile_last';

// ════════════════════════════════════════════════════════════════════════════════
// THE PREDICATES — ONE COPY, SHARED WITH THE HEALER
// ════════════════════════════════════════════════════════════════════════════════
//
// Two of the four shapes already had a live detector in `healer/diagnostic.ts`
// (`ORPHANED_PROJECT`, `ORPHANED_TASK`). The two mechanisms are deliberately NOT merged —
// continuous health and a one-shot version-gap pass are different jobs on different clocks —
// but the PREDICATE is single-sourced here, because two copies of "what counts as orphaned"
// is precisely the drift this project keeps closing. The healer imports these.

/**
 * SHAPE (d): a task dangling in a live state on an assignee that no longer exists.
 * `state IN ('claimed','on_deck','paused')` is the tracker's `in_progress`/`on_deck`/`paused`;
 * the assignee's dormancy is `agents.status = 'terminated'`, the tree's own predicate.
 */
export const ORPHANED_TASK_WHERE = (t = 't', a = 'a'): string =>
  `${taskScope(t)} AND ${t}.state IN ('claimed', 'on_deck', 'paused') AND ${a}.status = 'terminated'`;

/**
 * SHAPE (a): every task in the project is DONE and the project is still open.
 *
 * ⚠ THE PREDICATE IS `state <> 'done'`, NOT "not terminal", AND THAT IS D-K, NOT AN OVERSIGHT.
 * The owner's decision of record: a project that ran out of open tasks but has at least one
 * FALLEN task is deliberately left open for attention — it is not an orphan to be closed. A
 * wider predicate here would flag exactly the projects D-K exists to protect, and the Healer
 * would re-offer to close them on every cycle for ever.
 *
 * The `EXISTS` tail is what makes this shape DISJOINT from shape (b): a project with no tasks
 * at all satisfies "no non-done task" vacuously, and folding the two together would close
 * empty projects under a rule written for finished ones.
 */
export const ORPHANED_PROJECT_WHERE = (p = 'p'): string =>
  `${projectScope(p)} AND ${p}.state = 'open'
      AND NOT EXISTS (
        SELECT 1 FROM work t
        WHERE t.parent_id = ${p}.id AND t.kind = 'task' AND t.state <> 'done'
      )
      AND EXISTS (SELECT 1 FROM work t2 WHERE t2.parent_id = ${p}.id AND t2.kind = 'task')`;

// ════════════════════════════════════════════════════════════════════════════════
// THE SCAN
// ════════════════════════════════════════════════════════════════════════════════

export type ReconcileShape =
  | 'all-tasks-terminal-but-open'
  | 'zero-task-ghost'
  | 'status-contradicts-tasks'
  | 'dangling-in-progress-dormant-assignee';

export interface ReconcileFinding {
  readonly shape: ReconcileShape;
  readonly subject: 'project' | 'task';
  readonly id: string;
  readonly title: string;
  /** Why this row is a finding, in words a person reads. */
  readonly why: string;
  /** The ONE call that corrects it. A report with no correction is a complaint. */
  readonly correction: string;
}

export interface ReconcileScan {
  /** THE DENOMINATOR. How many project rows were looked at. */
  projectsExamined: number;
  /** And how many task rows. */
  tasksExamined: number;
  /** Every examined project that is NOT a finding, by NAMED reason. Sums with the findings. */
  projectStandDown: Record<string, number>;
  findings: ReconcileFinding[];
}

interface Row { id: string; title: string | null }

/**
 * Look at every tracker project and task and classify it. Reads only — this function writes
 * nothing, anywhere, which is what makes it safe to run on a `VACUUM INTO` copy of a real box
 * before it is ever pointed at the box itself (#16).
 */
export function scanVersionGap(): ReconcileScan {
  const db = getDb();
  const findings: ReconcileFinding[] = [];
  const projectStandDown: Record<string, number> = {
    'has live work': 0,
    'left open on purpose (a task fell — D-K)': 0,
    'already closed': 0,
  };

  const projects = db.prepare(
    `SELECT p.id AS id, p.title AS title, p.state AS state FROM work p WHERE ${projectScope('p')}`,
  ).all() as Array<Row & { state: string }>;

  const orphanedIds = new Set((db.prepare(
    `SELECT p.id AS id FROM work p WHERE ${ORPHANED_PROJECT_WHERE('p')}`,
  ).all() as Row[]).map((r) => r.id));

  const emptyIds = new Set((db.prepare(
    `SELECT p.id AS id FROM work p
      WHERE ${projectScope('p')} AND p.state = 'open'
        AND NOT EXISTS (SELECT 1 FROM work t WHERE t.parent_id = p.id AND t.kind = 'task')`,
  ).all() as Row[]).map((r) => r.id));

  // SHAPE (c): the project says one thing and its tasks say another. The direction that
  // matters is the one his board showed him — a row presented as settled while work under it
  // is still live. The reverse (open project, all tasks done) IS shape (a) and is not counted
  // twice here.
  const contradictionIds = new Set((db.prepare(
    `SELECT p.id AS id FROM work p
      WHERE ${projectScope('p')} AND p.state IN ('done', 'failed', 'abandoned')
        AND EXISTS (
          SELECT 1 FROM work t
          WHERE t.parent_id = p.id AND t.kind = 'task' AND t.state IN ('claimed', 'on_deck')
        )`,
  ).all() as Row[]).map((r) => r.id));

  for (const p of projects) {
    const title = p.title ?? p.id;
    if (orphanedIds.has(p.id)) {
      findings.push({
        shape: 'all-tasks-terminal-but-open', subject: 'project', id: p.id, title,
        why: 'every task in this project is complete, but the project itself is still open — the board shows it as live work when there is none.',
        correction: `work_update(action="close_project", project_id="${p.id}", status="complete", reason="every task completed")`,
      });
      continue;
    }
    if (emptyIds.has(p.id)) {
      findings.push({
        shape: 'zero-task-ghost', subject: 'project', id: p.id, title,
        why: 'this project is open and has no tasks at all. It may be wreckage from a build whose close path was broken, or it may be one somebody is building right now — a stored row cannot tell you which, so it is flagged and left alone.',
        correction: `work_update(action="close_project", project_id="${p.id}", status="cancelled", reason="empty project, no work was ever added")`,
      });
      continue;
    }
    if (contradictionIds.has(p.id)) {
      findings.push({
        shape: 'status-contradicts-tasks', subject: 'project', id: p.id, title,
        why: 'this project is marked as finished but still holds tasks that are in progress or on deck. One of the two is wrong, and only a person knows which.',
        correction: `work_update(action="get", project_id="${p.id}") to see which tasks are still live, then close or reopen deliberately`,
      });
      continue;
    }
    if (p.state === 'open') {
      // Not a finding. Which of the two innocent reasons?
      const fell = db.prepare(
        `SELECT COUNT(*) AS c FROM work t WHERE t.parent_id = ? AND t.kind = 'task' AND t.state IN ('failed','abandoned')`,
      ).get(p.id) as { c: number };
      const live = db.prepare(
        `SELECT COUNT(*) AS c FROM work t WHERE t.parent_id = ? AND t.kind = 'task' AND t.state NOT IN ('done','failed','abandoned')`,
      ).get(p.id) as { c: number };
      if (live.c > 0) projectStandDown['has live work'] += 1;
      else if (fell.c > 0) projectStandDown['left open on purpose (a task fell — D-K)'] += 1;
      else projectStandDown['has live work'] += 1;   // unreachable in practice; never uncounted
      continue;
    }
    projectStandDown['already closed'] += 1;
  }

  // SHAPE (d) — reported, never touched. Task-level data is his named red line.
  const dangling = db.prepare(
    `SELECT t.id AS id, t.title AS title, a.name AS agent_name
       FROM work t JOIN agents a ON a.id = t.agent_id
      WHERE ${ORPHANED_TASK_WHERE('t', 'a')}`,
  ).all() as Array<Row & { agent_name: string | null }>;
  for (const t of dangling) {
    findings.push({
      shape: 'dangling-in-progress-dormant-assignee', subject: 'task', id: t.id,
      title: t.title ?? t.id,
      why: `this task is still assigned to ${t.agent_name ?? 'an agent'}, who no longer exists, so nobody is going to pick it up. Nothing here has been changed — reassigning work on a guess moves real work.`,
      correction: `work_update(action="reassign", task_id="${t.id}", assigned_to="<an agent who is here>")`,
    });
  }

  const tasksExamined = (db.prepare(
    `SELECT COUNT(*) AS c FROM work t WHERE ${taskScope('t')}`,
  ).get() as { c: number }).c;

  return { projectsExamined: projects.length, tasksExamined, projectStandDown, findings };
}

// ════════════════════════════════════════════════════════════════════════════════
// THE PASS
// ════════════════════════════════════════════════════════════════════════════════

export interface ReconcileResult extends ReconcileScan {
  /** How many the pass CHANGED — only ever through the existing authority. */
  repaired: number;
  at: string;
}

/**
 * Run the pass. Idempotent by construction: the only change it makes is handing a structurally
 * unambiguous project to `checkProjectCompletion`, which is itself idempotent and which stops
 * matching this pass's predicate the moment it acts — so a second run finds nothing to do and
 * `repaired` comes back 0. Proven by driving it twice rather than argued for here.
 */
export async function runVersionGapReconcile(): Promise<ReconcileResult> {
  const scan = scanVersionGap();
  let repaired = 0;

  // THE ONE REPAIRABLE SHAPE, THROUGH THE ONE AUTHORITY. Dynamic import because `tracker/tools.ts`
  // statically imports `pm-agent.ts`; a static import here would drag the PM into every caller,
  // and it is the same idiom `scheduler/runner.ts` uses to reach this function.
  const { checkProjectCompletion } = await import('./tools.js');
  for (const f of scan.findings) {
    if (f.shape !== 'all-tasks-terminal-but-open') continue;
    // The authority independently re-checks that nothing is still open, so the owner's "never
    // close a project holding live work" holds even if this module's predicate were wrong.
    const outcome = checkProjectCompletion(f.id, getPMAgentId());
    if (outcome === 'completed') repaired += 1;
  }

  const result: ReconcileResult = { ...scan, repaired, at: new Date().toISOString() };

  // The durable sink. Logs rotate; the report the owner opens must not.
  try {
    getDb().prepare(
      `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(VERSION_GAP_REPORT_KEY, JSON.stringify(result));
  } catch (err) {
    logger.warn('Could not record the version-gap reconcile report', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info('Version-gap reconcile complete', {
    projectsExamined: result.projectsExamined, tasksExamined: result.tasksExamined,
    findings: result.findings.length, repaired: result.repaired,
    standDown: result.projectStandDown,
  });

  // ── ONE PLAIN LINE, THE OR2 WAY ──
  // To the AGENT, not to the owner's chat. The ruling of 2026-07-30, recorded on
  // `checkProjectCompletion`'s own fallen-project branch: *"when a project ends with failed
  // pieces, the platform does NOT alert the owner directly and does NOT stay silent — the AGENT
  // is told ... and the agent decides and speaks."* A reconciliation report about projects is
  // squarely inside that ruling's subject.
  //
  // And it is ONE LINE with the denominator in it, not the report. The report is in `config`
  // and on the tracker route; a wall of findings in an awareness notice is a wall nobody reads.
  // Silent when there is nothing to say — the negative control is a clause.
  if (result.findings.length > 0) {
    const nProjects = result.findings.filter((f) => f.subject === 'project').length;
    const nTasks = result.findings.filter((f) => f.subject === 'task').length;
    const parts: string[] = [];
    if (nProjects > 0) parts.push(`${nProjects} project${nProjects === 1 ? '' : 's'}`);
    if (nTasks > 0) parts.push(`${nTasks} task${nTasks === 1 ? '' : 's'}`);
    postAgentNotice({
      toAgentId: getPrimaryAgentId(),
      fromName: 'Tracker',
      selfIntro: false,
      intent: 'version_gap_reconcile',
      brief:
        `[System] After this update I checked the whole board — ${result.projectsExamined} project(s) `
        + `and ${result.tasksExamined} task(s) — and ${parts.join(' and ')} `
        + `${nProjects + nTasks === 1 ? 'looks' : 'look'} left over from an older version`
        + `${result.repaired > 0 ? `, and ${result.repaired} finished project(s) that were never closed out have been closed` : ''}. `
        + `Nothing else was changed. If the owner should know, tell them in your own words on your next turn; `
        + `the detail is on the tracker's reconcile report.`,
    });
  }

  return result;
}
