// Ticket stamps (DOJO-TICKET-STAMPS-PLAN): the stamp writer's contract and
// the render caps the risk audit demanded.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { stampTasksAtTurnFinalize, renderTaskStamps, renderStepFacts, composeTurnDeliverySummary } from '../task-stamps.js';
import { createWorkTable, seedTrackerTask, ms } from '../../work/__tests__/work-fixture.js';
import { stampColumns } from '../../work/tracker-view.js';

const AGENT = 'a1';

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE turn_artifacts (agent_id TEXT, turn_number INTEGER, kind TEXT, path TEXT, payload_json TEXT, delivered_at TEXT);
    CREATE TABLE deliveries (agent_id TEXT, turn_number INTEGER, channel TEXT, outcome TEXT);
  `);
  createWorkTable(db);
  const UPDATED = ms('2026-07-22 07:00:00')!;
  seedTrackerTask(db, { id: 't1', agentId: 'a1', title: 'Deliver report', source_message_id: 'ask-1', origin_conv_key: 'owner', origin_turn: 100, updated_at: UPDATED });
  seedTrackerTask(db, { id: 't2', agentId: 'a1', title: 'Unrelated', source_message_id: 'other-ask', updated_at: UPDATED });
  seedTrackerTask(db, { id: 't3', agentId: 'someone-else', title: 'Not mine', source_message_id: 'ask-1', updated_at: UPDATED });
  mockDb.current = db;
});


// PHASE-2 T8c item 2 — THE STAMPS ARE EVENTS NOW, so the test reads them the way production
// does: through `stampColumns`, the one projection every reader shares. That is stronger than
// the old `SELECT * FROM work`, which could pass while the projection itself was broken.
const stampsOf = (id: string): Record<string, unknown> =>
  mockDb.current!.prepare(
    `SELECT w.id AS id, ${stampColumns('w')} FROM work w WHERE w.id = ?`,
  ).get(id) as Record<string, unknown>;

describe('stampTasksAtTurnFinalize', () => {
  it('stamps the origin-tied own ticket and ONLY it; never touches updated_at', () => {
    mockDb.current!.prepare(`INSERT INTO deliveries VALUES ('a1', 100, 'imessage', 'delivered')`).run();
    stampTasksAtTurnFinalize({
      agentId: AGENT, turnNumber: 100, outcome: 'answered', answerMessageId: 'ans-1',
      rootSourceMessageId: 'ask-1', convKey: 'owner', servedTaskId: null,
    });
    const t1 = stampsOf('t1');
    expect(t1.last_activity_turn).toBe(100);
    expect(t1.last_activity_outcome).toBe('answered');
    expect(t1.last_answered_turn).toBe(100);
    // `last_answer_message_id` was DELETED with its column at PHASE-2 T8b: it had exactly one
    // production occurrence, the COALESCE onto itself in this very writer, so nothing read it
    // (T8a report §2.3c enumerates every site). The fact it stood for — which turn answered —
    // is `last_answered_turn` above, and the answering MESSAGE is on the delivery row T5
    // writes. The assertion is retired here, in the change that drops the write.
    expect(String(t1.last_delivery_summary)).toContain('imessage');
    // The drive clock is untouched. This used to be a promise about a SET list; a stamp is
    // an event-log append now, so there is no `updated_at` in reach at all.
    const clock = mockDb.current!.prepare("SELECT updated_at FROM work WHERE id='t1'").get() as Record<string, unknown>;
    expect(clock.updated_at).toBe(ms('2026-07-22 07:00:00'));
    const t2 = stampsOf('t2');
    expect(t2.last_activity_turn).toBeNull(); // different origin, unstamped
    const t3 = stampsOf('t3');
    expect(t3.last_activity_turn).toBeNull(); // same origin but NOT my ticket
  });

  it('a non-answered later turn updates activity but keeps the answered stamps (COALESCE)', () => {
    stampTasksAtTurnFinalize({
      agentId: AGENT, turnNumber: 100, outcome: 'answered', answerMessageId: 'ans-1',
      rootSourceMessageId: 'ask-1', convKey: 'owner', servedTaskId: null,
    });
    stampTasksAtTurnFinalize({
      agentId: AGENT, turnNumber: 101, outcome: 'no_reply', answerMessageId: null,
      rootSourceMessageId: 'ask-1', convKey: 'owner', servedTaskId: null,
    });
    const t1 = stampsOf('t1');
    expect(t1.last_activity_turn).toBe(101);
    expect(t1.last_activity_outcome).toBe('no_reply');
    expect(t1.last_answered_turn).toBe(100); // preserved — now "the newest activity that
    // answered", which is the same fact the COALESCE was maintaining by hand.
  });

  it('served-task tie works without origin match, and never throws without a DB', () => {
    stampTasksAtTurnFinalize({
      agentId: AGENT, turnNumber: 200, outcome: 'answered', answerMessageId: null,
      rootSourceMessageId: null, convKey: null, servedTaskId: 't2',
    });
    const t2 = stampsOf('t2');
    expect(t2.last_activity_turn).toBe(200);
    mockDb.current = null;
    expect(() => stampTasksAtTurnFinalize({
      agentId: AGENT, turnNumber: 1, outcome: 'answered', answerMessageId: null,
      rootSourceMessageId: 'x', convKey: null, servedTaskId: null,
    })).not.toThrow();
  });
});

describe('renderTaskStamps / renderStepFacts (caps + owner wording)', () => {
  it('answered tickets render facts plus the CLOSE instruction, one line', () => {
    const line = renderTaskStamps({
      last_activity_turn: 5, last_activity_at: '2026-07-22 07:10:00', last_activity_outcome: 'answered',
      last_answered_turn: 5, last_answered_at: '2026-07-22 07:10:00',
      last_delivery_summary: 'file report.md; via imessage',
    });
    expect(line).toContain('answered T5');
    expect(line).toContain('CLOSE if done');
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThanOrEqual(160);
  });

  it('answered WITHOUT delivery renders facts only, no CLOSE instruction (battery catch: ack-strangled delegation)', () => {
    const line = renderTaskStamps({
      last_activity_turn: 9, last_activity_at: '2026-07-22 08:00:00', last_activity_outcome: 'answered',
      last_answered_turn: 9, last_answered_at: '2026-07-22 08:00:00',
      last_delivery_summary: null,
    });
    expect(line).toContain('replied T9');
    expect(line).toContain('no delivery recorded');
    expect(line).not.toContain('CLOSE');
  });

  it('unstamped tickets say so plainly', () => {
    expect(renderTaskStamps({
      last_activity_turn: null, last_activity_at: null, last_activity_outcome: null,
      last_answered_turn: null, last_answered_at: null, last_delivery_summary: null,
    })).toBe('no engine activity yet');
  });

  it('step facts derive LIVE from siblings: open earlier step is named; none = plain step count', () => {
    const db = mockDb.current!;
    db.prepare(`UPDATE work SET parent_id='p1', step_number=1, total_steps=2 WHERE id='t1'`).run();
    db.prepare(`UPDATE work SET parent_id='p1', step_number=2, total_steps=2 WHERE id='t2'`).run();
    const facts = renderStepFacts({
      last_activity_turn: null, last_activity_at: null, last_activity_outcome: null,
      last_answered_turn: null, last_answered_at: null, last_delivery_summary: null,
      project_id: 'p1', step_number: 2, total_steps: 2,
    });
    expect(facts).toContain('step 2 of 2');
    expect(facts).toContain("step 1 'Deliver report' still open");
    db.prepare(`UPDATE work SET state='done' WHERE id='t1'`).run();
    const after = renderStepFacts({
      last_activity_turn: null, last_activity_at: null, last_activity_outcome: null,
      last_answered_turn: null, last_answered_at: null, last_delivery_summary: null,
      project_id: 'p1', step_number: 2, total_steps: 2,
    });
    expect(after).toBe('step 2 of 2');
  });

  it('delivery summary names one file ONCE across its artifact rows', () => {
    const db = mockDb.current!;
    db.prepare("INSERT INTO turn_artifacts VALUES ('a1', 9, 'canvas', '/x/report.md', NULL, '2026-07-22 07:00:00')").run();
    db.prepare("INSERT INTO turn_artifacts VALUES ('a1', 9, 'link', '/x/report.md', '{\"url\":\"https://example.com/d/1\"}', '2026-07-22 07:00:00')").run();
    const sum = composeTurnDeliverySummary('a1', 9);
    expect(sum.match(/report.md/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it('delivery summary caps at 120 chars and skips screen chips', () => {
    const db = mockDb.current!;
    db.prepare(`INSERT INTO turn_artifacts VALUES ('a1', 7, 'attachment', '/x/${'y'.repeat(200)}.md', NULL, '2026-07-22 07:00:00')`).run();
    db.prepare(`INSERT INTO turn_artifacts VALUES ('a1', 7, 'screen', '__screen__', NULL, '2026-07-22 07:00:00')`).run();
    const sum = composeTurnDeliverySummary('a1', 7);
    expect(sum.length).toBeLessThanOrEqual(120);
    expect(sum).not.toContain('__screen__');
  });
});
