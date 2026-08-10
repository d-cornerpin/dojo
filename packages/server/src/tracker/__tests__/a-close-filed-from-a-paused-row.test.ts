// UX-REPAIR ROUND 5 / T21 — A CLOSE FILED FROM A PAUSED ROW REACHES THE VALIDATOR.
//
// ── THE INCIDENT (round-5 S5, measured on the dev box) ──
// The delete task was paused awaiting the owner's approval (correct), the approval came, the
// work was done and told to the user, and `work_update(status=complete)` filed
// `validation_requested{requested_state:'done', from:'paused'}` (event 22401). The completion
// review queue enumerated `(state='done' AND unvalidated) OR (state='claimed' AND pending
// close request)` — no arm for `paused` — so the row never reached the completion lens. The
// UNVALIDATED_PAUSE queue picked the SAME row up and asked the PM the wrong question against
// the stale pause note; the PM answered the question it was asked (`claim_upheld
// {claim_state:'paused'}`, event 22418) and the row sat paused with its work finished.
//
// The queue's own comment named the disease one state over: "Reading only the first shape is
// how the queue would go quiet while work waited in it."
//
// requirement preserved (v2.7.18 anti-gaming pause lens): a genuinely-waiting paused row —
// one with NO close request on it — still gets the pause question verbatim, and a gaming
// pause is still rejectable. Those are the controls below, and they are what bounds this.
//
// SELF-HEAL, ASSERTED: `pendingCloseRequestExpr` compares the close request against the
// newest `transition`/`claim_rejected`, and `claim_upheld` is in neither set — so a row that
// already ate a pause blessing STILL reads as pending, and the repaired queue resolves it
// through the normal door with no data repair. The first clause pins that.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-paused-close-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../db/migrations.js';
import {
  openTrackerProject, openTrackerTask, setTrackerStatus, upholdClaim,
} from '../../work/tracker-store.js';
import {
  pendingCloseRequestExpr, closeRequestFiledExpr, unvalidatedCloseExpr, unvalidatedPauseExpr,
} from '../../work/tracker-view.js';
import { trackerValidateComplete, trackerValidatePause } from '../tools.js';
import { writeTaskLog } from '../task-log.js';

const AGENT = 'behaviorbot';
const PM = 'pm-agent';
const CONV = 'conv-owner';

function seedDelivery(id: string): string {
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome, created_at)
     VALUES (?, ?, NULL, 'dashboard', 'dashboard', ?, 'delivered', datetime('now'))`,
  ).run(id, AGENT, CONV);
  return id;
}

/** The S5 shape, up to but not including the PM's verdict. */
function seedS5(): { project: string; done: string; paused: string; delivery: string } {
  const project = openTrackerProject({
    title: 'Clean up uploads folder', createdBy: AGENT,
    origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
  });
  const done = openTrackerTask({
    projectId: project, title: 'Survey uploads and identify test junk',
    status: 'in_progress', assignedTo: AGENT, createdBy: AGENT,
    origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
  });
  const paused = openTrackerTask({
    projectId: project, title: 'Delete confirmed junk after David approves',
    status: 'in_progress', assignedTo: AGENT, createdBy: AGENT,
    origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
  });
  // Task 1 closed and blessed, exactly as the sibling did in the same sweep.
  setTrackerStatus(done, 'complete', {
    by: 'pm', actorId: PM, claim: 'authoritative',
    resultDeliveryId: seedDelivery('d-survey'), reason: 'PM validated the survey',
  });
  // Task 2 paused by the agent through the tool path (which is the writer that sets
  // `is_paused`), with the wait note the PM was later fed as evidence.
  setTrackerStatus(paused, 'paused', {
    by: 'agent', actorId: AGENT, claim: 'requests-validation',
    reason: 'work_update(action="status") -> paused', syncSchedulePause: true,
  });
  writeTaskLog({
    taskId: paused, fromEntity: `agent:${AGENT}`, entryKind: 'observation',
    note: "Waiting on David's approval of the deletion list before removing anything.",
  });
  // The approval arrives, the work is done and delivered, and the agent files its close FROM
  // the paused row — the exact call that produced event 22401.
  const delivery = seedDelivery('d-delete');
  const filed = setTrackerStatus(paused, 'complete', {
    by: 'agent', actorId: AGENT, claim: 'requests-validation',
    resultDeliveryId: delivery, reason: 'work_update(action="status") -> complete',
    syncSchedulePause: true,
  });
  expect(filed.kind, 'the worker close is Key 1 only — the row must not move').toBe('refused');
  return { project, done, paused, delivery };
}

/** A one-task project whose task is paused and waiting, with nothing filed on it. */
function seedPausedTask(title: string): string {
  const project = openTrackerProject({
    title: 'p', createdBy: AGENT,
    origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
  });
  const t = openTrackerTask({
    projectId: project, title, status: 'in_progress', assignedTo: AGENT, createdBy: AGENT,
    origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
  });
  setTrackerStatus(t, 'paused', {
    by: 'agent', actorId: AGENT, claim: 'requests-validation',
    reason: 'work_update(action="status") -> paused', syncSchedulePause: true,
  });
  return t;
}

const stateOf = (id: string): string =>
  (mockDb.current!.prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;

const boolExpr = (id: string, sql: string): number =>
  (mockDb.current!.prepare(`SELECT (${sql}) AS v FROM work w WHERE w.id = ?`)
    .get(id) as { v: number }).v;

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'BehaviorBot', 'idle', '1970-01-01')`).run(AGENT);
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'PM', 'idle', '1970-01-01')`).run(PM);
  db.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`).run(CONV, AGENT);
});

describe('T21 (1): the close request is visible from paused, and survives a pause blessing', () => {
  it('THE SELF-HEAL PROPERTY: a claim_upheld{paused} does NOT answer the close request', () => {
    const { paused } = seedS5();
    expect(boolExpr(paused, pendingCloseRequestExpr('w'))).toBe(1);
    // The PM's wrong answer, replayed verbatim (event 22418).
    trackerValidatePauseUnguarded(paused);
    expect(boolExpr(paused, pendingCloseRequestExpr('w')),
      'the close request must still be pending — this is what makes the repair need no data fix').toBe(1);
  });

  it('the close-request subject reads BOTH filing states', () => {
    const { paused, done } = seedS5();
    expect(boolExpr(paused, closeRequestFiledExpr('w'))).toBe(1);
    expect(boolExpr(paused, unvalidatedCloseExpr('w'))).toBe(1);
    // the sibling that closed correctly is not in the class at all
    expect(boolExpr(done, closeRequestFiledExpr('w'))).toBe(0);
    expect(boolExpr(done, unvalidatedCloseExpr('w'))).toBe(0);
  });

  it('COMPLEMENT: the pause lens lets go of a row that has filed its close', () => {
    const { paused } = seedS5();
    expect(boolExpr(paused, unvalidatedPauseExpr('w')),
      'a row whose close is filed is a completion question, not a pause question').toBe(0);
  });

  it('CONTROL: a genuinely-waiting paused row is still the pause lens\'s subject', () => {
    const t = seedPausedTask('waiting on a real external thing');
    expect(boolExpr(t, unvalidatedPauseExpr('w'))).toBe(1);
    expect(boolExpr(t, closeRequestFiledExpr('w'))).toBe(0);
    expect(boolExpr(t, unvalidatedCloseExpr('w'))).toBe(0);
  });
});

describe('T21 (2): the completion door accepts the paused shape end-to-end', () => {
  it('THE S5 REPLAY: PM validates the close, the task closes, the project rolls up', async () => {
    const { project, paused, delivery } = seedS5();
    const out = await trackerValidateComplete(PM, { task_id: paused, valid: true });
    expect(out.startsWith('[OK]'), `completion validation was refused: ${out}`).toBe(true);
    expect(stateOf(paused)).toBe('done');
    const row = mockDb.current!.prepare(
      'SELECT result_delivery_id AS d, is_paused AS p FROM work WHERE id = ?',
    ).get(paused) as { d: string | null; p: number };
    expect(row.d, 'the receipt the WORKER pointed at is the receipt on the row').toBe(delivery);
    expect(row.p, 'a finished row does not still read paused').toBe(0);
    expect(stateOf(project), 'the S5 project class closes').toBe('done');
  });

  it('and it still works after the wrong question was already answered (no data repair)', async () => {
    const { project, paused } = seedS5();
    trackerValidatePauseUnguarded(paused);
    const out = await trackerValidateComplete(PM, { task_id: paused, valid: true });
    expect(out.startsWith('[OK]'), out).toBe(true);
    expect(stateOf(paused)).toBe('done');
    expect(stateOf(project)).toBe('done');
  });

  it('CONTROL: the claimed-shape close path is unchanged', async () => {
    const project = openTrackerProject({
      title: 'p', createdBy: AGENT,
      origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
    });
    const t = openTrackerTask({
      projectId: project, title: 'a normal close', status: 'in_progress',
      assignedTo: AGENT, createdBy: AGENT,
      origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
    });
    const d = seedDelivery('d-normal');
    setTrackerStatus(t, 'complete', {
      by: 'agent', actorId: AGENT, claim: 'requests-validation',
      resultDeliveryId: d, reason: 'work_update(action="status") -> complete',
    });
    const out = await trackerValidateComplete(PM, { task_id: t, valid: true });
    expect(out.startsWith('[OK]'), out).toBe(true);
    expect(stateOf(t)).toBe('done');
    expect(stateOf(project)).toBe('done');
  });

  it('CONTROL: a paused row with NO close request is still refused by the completion door', async () => {
    const t = seedPausedTask('genuinely waiting');
    const out = await trackerValidateComplete(PM, { task_id: t, valid: true });
    expect(out.startsWith('Error:')).toBe(true);
    expect(stateOf(t)).toBe('paused');
  });
});

describe('T21 (3): the pause blessing can never eat a close again', () => {
  it('trackerValidatePause(valid=true) REFUSES a row with a pending close request', async () => {
    const { paused } = seedS5();
    const out = await trackerValidatePause(PM, { task_id: paused, valid: true });
    expect(out.startsWith('Error:'), out).toBe(true);
    expect(out).toMatch(/kind="?complete/);
    expect(stateOf(paused), 'the refusal changes nothing about the row').toBe('paused');
    expect(
      (mockDb.current!.prepare(
        `SELECT COUNT(*) AS n FROM adjudications WHERE work_id = ? AND claim_state = 'paused'`,
      ).get(paused) as { n: number }).n,
      'no pause verdict is filed',
    ).toBe(0);
  });

  it('CONTROL: a genuinely-waiting paused row is still blessable', async () => {
    const t = seedPausedTask('waiting');
    const out = await trackerValidatePause(PM, { task_id: t, valid: true });
    expect(out.startsWith('[OK]'), out).toBe(true);
    expect(boolExpr(t, unvalidatedPauseExpr('w')), 'the blessing takes it out of the lens').toBe(0);
    expect(stateOf(t)).toBe('paused');
  });

  it('CONTROL: a gaming pause is still rejectable', async () => {
    const t = seedPausedTask('vague');
    const out = await trackerValidatePause(PM, {
      task_id: t, valid: false, reject_reason: 'no specific wait condition named',
    });
    expect(out.startsWith('[OK]'), out).toBe(true);
    expect(stateOf(t)).toBe('claimed');
  });
});

describe('T21 (4): the close-request subject is written once', () => {
  it('no production site restates "claimed AND a pending close request" by hand', () => {
    const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === '__tests__' || e.name === 'node_modules') continue;
          walk(abs);
        } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
          const src = fs.readFileSync(abs, 'utf8');
          // The hand-rolled pair, in the shape all ten sites carried it.
          const re = /state\s*=\s*'claimed'\s*AND\s*\$\{pendingCloseRequestExpr/;
          if (re.test(src)) offenders.push(path.relative(SRC, abs));
        }
      }
    };
    walk(SRC);
    expect(offenders, 'the close-request subject belongs to closeRequestFiledExpr alone').toEqual([]);
  });
});

/**
 * The PM's WRONG answer from the incident, filed the way `trackerValidatePause(valid=true)`
 * filed it before the guard existed — the same `upholdClaim` write, so the self-heal clause
 * replays history without the new refusal standing in front of it.
 */
function trackerValidatePauseUnguarded(taskId: string): void {
  upholdClaim(taskId, 'paused', 'pm', PM, 'PM confirmed the pause is a real wait condition');
}
