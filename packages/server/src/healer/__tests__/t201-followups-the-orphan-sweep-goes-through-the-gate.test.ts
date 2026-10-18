// ════════════════════════════════════════════════════════════════════════════════════════
// t201 follow-up 2 — THE HEALER'S ORPHAN SWEEP WRITES THE ASSIGNEE THROUGH THE GATE.
//
// t193 made `work/row-authority.ts` the one writer of the assignee columns and left two named
// exceptions waiting to be routed. The healer's orphan sweep was one: it cleared the assignee
// of a task whose holder is gone with its own `patchWork` literal, and left NO record of the
// move. Now it asks the gate's writer (`writeAssignee`) and files the same record every move
// files: the cause (`assignee_gone`), who did it, from whom and to nobody.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));

import { runAutoFixes } from '../auto-fix.js';
import { createWorkTable, seedTrackerTask } from '../../work/__tests__/work-fixture.js';

const DEAD = 'terminated-agent';

beforeEach(() => {
  const db = new Database(':memory:');
  createWorkTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS healer_actions (
      id TEXT PRIMARY KEY, diagnostic_id TEXT, category TEXT, description TEXT,
      agent_id TEXT, action_taken TEXT, result TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare("INSERT INTO agents (id, name, status) VALUES (?, 'Gone', 'terminated')").run(DEAD);
  mockDb.current = db;
});

const moves = (taskId: string) => (mockDb.current!.prepare(
  `SELECT actor, payload FROM work_events WHERE work_id = ? AND kind = 'audit' ORDER BY id`,
).all(taskId) as Array<{ actor: string; payload: string }>)
  .map((r) => ({ actor: r.actor, ...(JSON.parse(r.payload) as Record<string, string>) }))
  .filter((p) => p.entry_kind === 'reassignment');

describe('the orphan sweep leaves the record every move leaves', () => {
  it('records the cause, the actor, the old holder and nobody as the new one', () => {
    seedTrackerTask(mockDb.current!, { id: 'orph-0001', title: 'a job whose owner is gone', status: 'in_progress', agentId: DEAD });
    runAutoFixes('diag-1', [{ code: 'ORPHANED_TASK', severity: 'critical', message: '', detail: '' } as never]);
    const row = mockDb.current!.prepare('SELECT assignee_agent FROM work WHERE id = ?').get('orph-0001') as { assignee_agent: string | null };
    expect(row.assignee_agent, 'control: the assignee was still cleared').toBeNull();
    const recorded = moves('orph-0001');
    expect(recorded, 'exactly one move on the record').toHaveLength(1);
    expect(recorded[0]!.actor).toBe('healer');
    expect(recorded[0]!.reason).toContain('cause=assignee_gone');
    expect(recorded[0]!.action_taken).toContain(DEAD);
    expect(recorded[0]!.action_taken).toContain('unassigned');
  });

  it('a second pass does not file a second record for the same move', () => {
    seedTrackerTask(mockDb.current!, { id: 'orph-0001', title: 'a job whose owner is gone', status: 'in_progress', agentId: DEAD });
    const item = { code: 'ORPHANED_TASK', severity: 'critical', message: '', detail: '' } as never;
    runAutoFixes('diag-1', [item]);
    runAutoFixes('diag-2', [item]);
    expect(moves('orph-0001')).toHaveLength(1);
  });
});

describe('the healer no longer writes an assignee column itself', () => {
  it('auto-fix.ts holds no assignee literal and calls the gate\'s writer', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'auto-fix.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(src).not.toMatch(/\b(?:agent_id|assignee_agent|assigned_to_group)\s*:/);
    expect(src).toMatch(/\bwriteAssignee\(/);
  });
});
