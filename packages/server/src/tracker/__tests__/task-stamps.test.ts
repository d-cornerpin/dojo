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

const AGENT = 'a1';

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, assigned_to TEXT, status TEXT, title TEXT,
      project_id TEXT, step_number INTEGER, total_steps INTEGER,
      source_message_id TEXT, origin_conv_key TEXT, origin_turn INTEGER,
      updated_at TEXT DEFAULT '2026-07-22 07:00:00',
      last_activity_turn INTEGER, last_activity_at TEXT, last_activity_outcome TEXT,
      last_answered_turn INTEGER, last_answered_at TEXT, last_answer_message_id TEXT,
      last_delivery_at TEXT, last_delivery_summary TEXT
    );
    CREATE TABLE turn_artifacts (agent_id TEXT, turn_number INTEGER, kind TEXT, path TEXT, payload_json TEXT, delivered_at TEXT);
    CREATE TABLE deliveries (agent_id TEXT, turn_number INTEGER, channel TEXT, outcome TEXT);
  `);
  db.prepare(`INSERT INTO tasks (id, assigned_to, status, title, source_message_id, origin_conv_key, origin_turn)
              VALUES ('t1', 'a1', 'in_progress', 'Deliver report', 'ask-1', 'owner', 100)`).run();
  db.prepare(`INSERT INTO tasks (id, assigned_to, status, title, source_message_id)
              VALUES ('t2', 'a1', 'in_progress', 'Unrelated', 'other-ask')`).run();
  db.prepare(`INSERT INTO tasks (id, assigned_to, status, title, source_message_id)
              VALUES ('t3', 'someone-else', 'in_progress', 'Not mine', 'ask-1')`).run();
  mockDb.current = db;
});

describe('stampTasksAtTurnFinalize', () => {
  it('stamps the origin-tied own ticket and ONLY it; never touches updated_at', () => {
    mockDb.current!.prepare(`INSERT INTO deliveries VALUES ('a1', 100, 'imessage', 'delivered')`).run();
    stampTasksAtTurnFinalize({
      agentId: AGENT, turnNumber: 100, outcome: 'answered', answerMessageId: 'ans-1',
      rootSourceMessageId: 'ask-1', convKey: 'owner', servedTaskId: null,
    });
    const t1 = mockDb.current!.prepare("SELECT * FROM tasks WHERE id='t1'").get() as Record<string, unknown>;
    expect(t1.last_activity_turn).toBe(100);
    expect(t1.last_activity_outcome).toBe('answered');
    expect(t1.last_answered_turn).toBe(100);
    expect(t1.last_answer_message_id).toBe('ans-1');
    expect(String(t1.last_delivery_summary)).toContain('imessage');
    expect(t1.updated_at).toBe('2026-07-22 07:00:00'); // the drive clock is untouched
    const t2 = mockDb.current!.prepare("SELECT last_activity_turn FROM tasks WHERE id='t2'").get() as Record<string, unknown>;
    expect(t2.last_activity_turn).toBeNull(); // different origin, unstamped
    const t3 = mockDb.current!.prepare("SELECT last_activity_turn FROM tasks WHERE id='t3'").get() as Record<string, unknown>;
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
    const t1 = mockDb.current!.prepare("SELECT * FROM tasks WHERE id='t1'").get() as Record<string, unknown>;
    expect(t1.last_activity_turn).toBe(101);
    expect(t1.last_activity_outcome).toBe('no_reply');
    expect(t1.last_answered_turn).toBe(100); // preserved
  });

  it('served-task tie works without origin match, and never throws without a DB', () => {
    stampTasksAtTurnFinalize({
      agentId: AGENT, turnNumber: 200, outcome: 'answered', answerMessageId: null,
      rootSourceMessageId: null, convKey: null, servedTaskId: 't2',
    });
    const t2 = mockDb.current!.prepare("SELECT last_activity_turn FROM tasks WHERE id='t2'").get() as Record<string, unknown>;
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

  it('unstamped tickets say so plainly', () => {
    expect(renderTaskStamps({
      last_activity_turn: null, last_activity_at: null, last_activity_outcome: null,
      last_answered_turn: null, last_answered_at: null, last_delivery_summary: null,
    })).toBe('no engine activity yet');
  });

  it('step facts derive LIVE from siblings: open earlier step is named; none = plain step count', () => {
    const db = mockDb.current!;
    db.prepare(`UPDATE tasks SET project_id='p1', step_number=1, total_steps=2 WHERE id='t1'`).run();
    db.prepare(`UPDATE tasks SET project_id='p1', step_number=2, total_steps=2 WHERE id='t2'`).run();
    const facts = renderStepFacts({
      last_activity_turn: null, last_activity_at: null, last_activity_outcome: null,
      last_answered_turn: null, last_answered_at: null, last_delivery_summary: null,
      project_id: 'p1', step_number: 2, total_steps: 2,
    });
    expect(facts).toContain('step 2 of 2');
    expect(facts).toContain("step 1 'Deliver report' still open");
    db.prepare(`UPDATE tasks SET status='complete' WHERE id='t1'`).run();
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
