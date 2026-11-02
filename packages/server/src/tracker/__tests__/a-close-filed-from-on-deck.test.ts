// A CLOSE THE PRODUCT ACCEPTS IS ALWAYS ONE THE VALIDATOR CAN SEE (proof-fix V).
// Paid run: a step paused, the PM rejected the pause (back to on_deck), the worker finished the
// work and filed complete_step; `closeRequestFiledExpr` read only claimed/paused, so the filed
// close was invisible and the step stayed on_deck for good.

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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-ondeck-close-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../db/migrations.js';
import {
  openTrackerProject, openTrackerTask, setTrackerStatus,
} from '../../work/tracker-store.js';
import {
  pendingCloseRequestExpr, closeRequestFiledExpr, unvalidatedCloseExpr,
} from '../../work/tracker-view.js';
import { trackerValidateComplete, trackerValidatePause } from '../tools.js';

const AGENT = 'harnessbot';
const PM = 'pm-agent';
const CONV = 'conv-owner';

function seedDelivery(id: string): string {
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, conversation_id, outcome, created_at)
     VALUES (?, ?, NULL, 'dashboard', 'dashboard', ?, 'delivered', datetime('now'))`,
  ).run(id, AGENT, CONV);
  return id;
}


const ORIGIN = { kind: 'agent' as const, sourceMessageId: null, turn: null, convKey: null };

/** A plan step the worker is on, in a project of its own. */
function seedStep(title: string): string {
  const project = openTrackerProject({ title: 'plan', createdBy: AGENT, origin: ORIGIN });
  return openTrackerTask({
    projectId: project, title, status: 'in_progress', assignedTo: AGENT, createdBy: AGENT, origin: ORIGIN,
  });
}

const stateOf = (id: string): string =>
  (mockDb.current!.prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;
const boolExpr = (id: string, sql: string): number =>
  (mockDb.current!.prepare(`SELECT (${sql}) AS v FROM work w WHERE w.id = ?`).get(id) as { v: number }).v;

/** The agent's honest close, through the same writer the tool door uses. */
function fileClose(id: string, tag: string): string {
  const r = setTrackerStatus(id, 'complete', {
    by: 'agent', actorId: AGENT, claim: 'requests-validation',
    resultDeliveryId: seedDelivery(`d-${tag}`), reason: 'work_update(action="complete_step")',
  });
  expect(r.kind, 'the worker close is Key 1 only — the row must not move').toBe('refused');
  return id;
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'HarnessBot', 'idle', '1970-01-01')`).run(AGENT);
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'PM', 'idle', '1970-01-01')`).run(PM);
  db.prepare(`INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'dashboard', 'owner')`).run(CONV, AGENT);
});

describe('a close the product accepts is a close the validator can see', () => {
  it('THE PAID-RUN SHAPE: pause rejected back to on_deck, then complete_step, then the PM closes it', async () => {
    const step = seedStep('Step 6: publish the summary');
    setTrackerStatus(step, 'paused', {
      by: 'agent', actorId: AGENT, claim: 'requests-validation', reason: 'work_update(action="status") -> paused',
    });
    const rej = await trackerRejectPauseForTest(step);
    expect(rej, 'the PM reject puts the step back in the queue').toBe('on_deck');
    fileClose(step, 'step6');
    expect(boolExpr(step, pendingCloseRequestExpr('w'))).toBe(1);
    expect(boolExpr(step, closeRequestFiledExpr('w')), 'the filed close is visible from on_deck').toBe(1);
    expect(boolExpr(step, unvalidatedCloseExpr('w'))).toBe(1);
    const out = await trackerValidateComplete(PM, { task_id: step, valid: true });
    expect(out.startsWith('[OK]'), out).toBe(true);
    expect(stateOf(step)).toBe('done');
  });

  it('EVERY non-terminal state the filing path accepts is seen and can be closed', async () => {
    const accepted: string[] = [];
    for (const from of ['open', 'on_deck', 'claimed', 'paused', 'blocked'] as const) {
      const step = seedStep(`from ${from}`);
      mockDb.current!.prepare('UPDATE work SET state = ? WHERE id = ?').run(from, step);
      const r = setTrackerStatus(step, 'complete', {
        by: 'agent', actorId: AGENT, claim: 'requests-validation',
        resultDeliveryId: seedDelivery(`d-${from}`), reason: 'complete',
      });
      if (r.kind !== 'refused' || r.reason !== 'requires-validation') continue;
      accepted.push(from);
      expect(boolExpr(step, closeRequestFiledExpr('w')), `filed from ${from} is invisible`).toBe(1);
      expect(boolExpr(step, unvalidatedCloseExpr('w'))).toBe(1);
      const out = await trackerValidateComplete(PM, { task_id: step, valid: true });
      expect(out.startsWith('[OK]'), `${from}: ${out}`).toBe(true);
      expect(stateOf(step)).toBe('done');
    }
    expect(accepted, 'the filing path accepts every non-terminal state').toEqual(
      ['open', 'on_deck', 'claimed', 'paused', 'blocked']);
  });

  it('CONTROL: an on_deck step with nothing filed is not in the close subject', () => {
    const step = seedStep('queued');
    mockDb.current!.prepare("UPDATE work SET state = 'on_deck' WHERE id = ?").run(step);
    expect(boolExpr(step, closeRequestFiledExpr('w'))).toBe(0);
    expect(boolExpr(step, unvalidatedCloseExpr('w'))).toBe(0);
  });
});

/** The PM's reject-pause move: a pause the PM refuses sends the step back to on_deck. */
async function trackerRejectPauseForTest(step: string): Promise<string> {
  await trackerValidatePause(PM, { task_id: step, valid: false, reject_reason: 'no specific wait condition named', target_status: 'on_deck' });
  return stateOf(step);
}
