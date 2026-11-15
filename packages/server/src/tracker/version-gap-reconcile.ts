// Version-gap reconciliation: after an update, reports tracker rows left behind by an older build's
// defects. (a) an open project whose tasks derive it as settled is settled from them, the only repair (one
// whose last task fell stays open by design). (b) an open project with no tasks, (c) a finished project
// holding live tasks and (d) a live task on a terminated assignee are reported with a one-call correction
// and left alone, since a stored state carries no record of intent. Never close a project holding a live
// task, never touch task-level data. Every examined project lands in exactly one named bucket (a finding
// or a named stand-down) and the test asserts that sum.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { postAgentNotice } from '../agent/agent-notice.js';
import { getPrimaryAgentId } from '../config/platform.js';
import { projectScope, taskScope } from '../work/tracker-view.js';
import { deriveProjectState, settleProject } from '../work/done/project-state.js';
import { workingExpr } from '../work/done/hold.js';

const logger = createLogger('version-gap');

// Single source of the orphaned-task predicate; healer/diagnostic.ts and healer/auto-fix.ts import it.

/**
 * SHAPE (d): a task live (`claimed`/`open`, the tracker's in_progress/on_deck) on an assignee whose
 * `agents.status` is 'terminated'. The join key is `assignee_agent`, not the holder `agent_id` (NOT NULL,
 * still the dead agent after an auto-fix); every consumer uses these helpers so all select the same row
 * set.
 */
export const ORPHANED_TASK_JOIN = (t = 't', a = 'a'): string =>
  `JOIN agents ${a} ON ${a}.id = ${t}.assignee_agent`;

export const ORPHANED_TASK_WHERE = (t = 't', a = 'a'): string =>
  `${taskScope(t)} AND ${workingExpr(t, true)}`
  + ` AND ${t}.assignee_agent IS NOT NULL AND ${a}.status = 'terminated'`;


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
  readonly why: string;
  readonly correction: string;
}

export interface ReconcileScan {
  projectsExamined: number;
  tasksExamined: number;
  /** Every examined project that is NOT a finding, by NAMED reason. Sums with the findings. */
  projectStandDown: Record<string, number>;
  findings: ReconcileFinding[];
}

interface Row { id: string; title: string | null }

/**
 * Classifies every project and task; writes nothing, so it is safe on a `VACUUM INTO` copy of a real box.
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

  const orphanedIds = new Set(projects.filter((p) => {
    const derived = p.state === 'open' ? deriveProjectState(p.id) : null;
    return derived === 'done' || derived === 'abandoned';
  }).map((p) => p.id));

  const emptyIds = new Set((db.prepare(
    `SELECT p.id AS id FROM work p
      WHERE ${projectScope('p')} AND p.state = 'open'
        AND NOT EXISTS (SELECT 1 FROM work t WHERE t.parent_id = p.id AND t.kind = 'task')`,
  ).all() as Row[]).map((r) => r.id));

  // SHAPE (c): a project marked settled while work under it is still live. The reverse (open project, all
  // tasks done) is shape (a) and is not counted twice.
  const contradictionIds = new Set((db.prepare(
    `SELECT p.id AS id FROM work p
      WHERE ${projectScope('p')} AND p.state IN ('done', 'failed', 'abandoned')
        AND EXISTS (
          SELECT 1 FROM work t
          WHERE t.parent_id = p.id AND t.kind = 'task' AND ${workingExpr('t', true)}
        )`,
  ).all() as Row[]).map((r) => r.id));

  for (const p of projects) {
    const title = p.title ?? p.id;
    if (orphanedIds.has(p.id)) {
      findings.push({
        shape: 'all-tasks-terminal-but-open', subject: 'project', id: p.id, title,
        why: 'every task in this project has ended, but the project itself is still open, so the board shows it as live work when there is none.',
        correction: 'none needed: this pass settles it from its tasks',
      });
      continue;
    }
    if (emptyIds.has(p.id)) {
      findings.push({
        shape: 'zero-task-ghost', subject: 'project', id: p.id, title,
        why: 'this project is open and has no tasks at all. It may be wreckage from a build whose close path was broken, or it may be one somebody is building right now — a stored row cannot tell you which, so it is flagged and left alone.',
        correction: 'the owner cancels it from the dashboard project board',
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

  // SHAPE (d): reported, never touched; task-level data is never rewritten.
  const dangling = db.prepare(
    `SELECT t.id AS id, t.title AS title, a.name AS agent_name
       FROM work t ${ORPHANED_TASK_JOIN('t', 'a')}
      WHERE ${ORPHANED_TASK_WHERE('t', 'a')}`,
  ).all() as Array<Row & { agent_name: string | null }>;
  for (const t of dangling) {
    findings.push({
      shape: 'dangling-in-progress-dormant-assignee', subject: 'task', id: t.id,
      title: t.title ?? t.id,
      why: `this task is still assigned to ${t.agent_name ?? 'an agent'}, who no longer exists, so nobody is going to pick it up. Nothing here has been changed — reassigning work on a guess moves real work.`,
      correction: `work_update(action="reassign", task_id="${t.id}", assigned_to="<an agent who is here>", cause="assignee_gone")`,
    });
  }

  const tasksExamined = (db.prepare(
    `SELECT COUNT(*) AS c FROM work t WHERE ${taskScope('t')}`,
  ).get() as { c: number }).c;

  return { projectsExamined: projects.length, tasksExamined, projectStandDown, findings };
}


export interface ReconcileResult extends ReconcileScan {
  /** How many the pass CHANGED, only ever through the existing authority. */
  repaired: number;
  at: string;
}

// Runs the pass: its one change is settling each shape-(a) project from its tasks, so a second run repairs
// nothing.
export async function runVersionGapReconcile(): Promise<ReconcileResult> {
  const scan = scanVersionGap();
  let repaired = 0;
  for (const f of scan.findings) {
    if (f.shape !== 'all-tasks-terminal-but-open') continue;
    if (settleProject(f.id)) repaired++;
  }

  const result: ReconcileResult = { ...scan, repaired, at: new Date().toISOString() };

  logger.info('Version-gap reconcile complete', {
    projectsExamined: result.projectsExamined, tasksExamined: result.tasksExamined,
    findings: result.findings.length, repaired: result.repaired,
    standDown: result.projectStandDown,
  });

  // One plain line to the agent, never the owner's chat (the agent decides and speaks), carrying the
  // denominator rather than the report, which is in `config` and on the tracker route. Silent when there is
  // nothing to say.
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
        + `Nothing else was changed. If the owner should know, tell them in your own words on your next turn (as your written reply if that turn is talking to them, otherwise in an explicit send that names them); `
        + `the detail is on the tracker's reconcile report.`,
    });
  }

  return result;
}
