// 2026-07-22 production incident: delivered-but-unclosed task re-driven into
// full re-work. This suite pins the evidence consult's contract, especially
// the discriminators that keep it from misfiring on genuinely mid-work tasks.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

import { findDeliveryEvidenceForTask, renderDeliveryEvidence } from '../delivery-evidence.js';

const AGENT = 'agent-1';
const TASK = 'task-1';
const ASK = 'msg-ask-1';

import { createWorkTable, seedTrackerTask, ms } from '../../work/__tests__/work-fixture.js';

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE turns (
      agent_id TEXT, turn_number INTEGER, exit_reason TEXT, answered INTEGER NOT NULL,
      started_at TEXT, ended_at TEXT, answer_message_id TEXT, source_message_id TEXT,
      conv_key TEXT
    );
    CREATE TABLE audit_log (agent_id TEXT, turn_number INTEGER);
    CREATE TABLE turn_artifacts (agent_id TEXT, turn_number INTEGER, path TEXT, payload_json TEXT, delivered_at TEXT, delivery_id TEXT);
    CREATE TABLE deliveries (id TEXT, agent_id TEXT, turn_number INTEGER, channel TEXT, outcome TEXT);
  `);
  createWorkTable(db);
  seedTrackerTask(db, {
    id: TASK, agentId: AGENT, source_message_id: ASK, origin_conv_key: 'owner',
    opened_at: ms('2026-07-22 07:15:34'),
  });
  mockDb.current = db;
});

function insertAnsweredTurn(n: number, opts?: { sourceMessageId?: string | null; convKey?: string | null; startedAt?: string }) {
  mockDb.current!.prepare(
    `INSERT INTO turns VALUES (?, ?, 'answered', 1, ?, ?, 'msg-answer', ?, ?)`,
  ).run(AGENT, n, opts?.startedAt ?? '2026-07-22 07:16:00', '2026-07-22 07:16:30',
    opts?.sourceMessageId === undefined ? ASK : opts.sourceMessageId,
    opts?.convKey === undefined ? null : opts.convKey);
}

describe('findDeliveryEvidenceForTask (delivered-but-unclosed consult)', () => {
  it('finds evidence: answered turn on the task originating ask, nothing ran after (the incident shape)', () => {
    insertAnsweredTurn(100);
    const ev = findDeliveryEvidenceForTask(TASK);
    expect(ev).not.toBeNull();
    expect(ev!.turnNumber).toBe(100);
    expect(ev!.artifacts).toEqual([]);
  });

  it('matches by origin conversation key when the ask id differs', () => {
    insertAnsweredTurn(100, { sourceMessageId: 'different-msg', convKey: 'owner' });
    expect(findDeliveryEvidenceForTask(TASK)).not.toBeNull();
  });

  it('NO evidence when the assignee ran tools on a LATER turn (mid-work, not delivered)', () => {
    insertAnsweredTurn(100);
    mockDb.current!.prepare('INSERT INTO audit_log VALUES (?, 101)').run(AGENT);
    expect(findDeliveryEvidenceForTask(TASK)).toBeNull();
  });

  it('NO evidence from an answered turn on an UNRELATED conversation (identity join, not content)', () => {
    insertAnsweredTurn(100, { sourceMessageId: 'other-ask', convKey: 'imessage:someone' });
    expect(findDeliveryEvidenceForTask(TASK)).toBeNull();
  });

  it('NO evidence from a turn that predates the task', () => {
    insertAnsweredTurn(90, { startedAt: '2026-07-22 07:00:00' });
    expect(findDeliveryEvidenceForTask(TASK)).toBeNull();
  });

  it('NO evidence for a task with no origin identity at all', () => {
    mockDb.current!.prepare(`UPDATE work SET source_message_id = NULL, origin_conv_key = NULL WHERE id = ?`).run(TASK);
    insertAnsweredTurn(100);
    expect(findDeliveryEvidenceForTask(TASK)).toBeNull();
  });

  it('carries the tangible handover: delivered artifacts and channel deliveries from the answering turn', () => {
    insertAnsweredTurn(100);
    // PHASE-2 T5: an artifact with no `delivery_id` is a pre-T5 row and is read as it always
    // was; the linked/failed cases are asserted in agent/v2/__tests__/delivery-links.test.ts.
    mockDb.current!.prepare(`INSERT INTO turn_artifacts VALUES (?, 100, '/tmp/report.md', '{"filename":"report.md"}', '2026-07-22 07:16:20', NULL)`).run(AGENT);
    mockDb.current!.prepare(`INSERT INTO deliveries VALUES ('d-x', ?, 100, 'imessage', 'delivered')`).run(AGENT);
    const ev = findDeliveryEvidenceForTask(TASK)!;
    expect(ev.artifacts).toEqual(['report.md']);
    expect(ev.deliveredVia).toEqual(['imessage']);
    expect(renderDeliveryEvidence(ev)).toContain('report.md');
  });

  it('never throws without a DB (best-effort contract)', () => {
    mockDb.current = null;
    expect(findDeliveryEvidenceForTask(TASK)).toBeNull();
  });
});
