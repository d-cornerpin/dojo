// K34 — the Healer report lists the week's lessons from rough tasks.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({}) }));
vi.mock('../../services/imessage-bridge.js', () => ({ sendAlert: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import { compileDiagnosticReport } from '../diagnostic.js';

const DAY = 24 * 60 * 60 * 1000;
function lesson(id: string, cue: string, ageDays: number): void {
  const at = Date.now() - ageDays * DAY;
  mockDb.current!.prepare(
    `INSERT INTO lessons (id, agent_id, task_id, cue, lesson, evidence_event_ids, confidence, component, created_at, expires_at)
     VALUES (?, 'a', 't', ?, 'do the better thing', '[1]', 0.6, 'door_text', ?, ?)`,
  ).run(id, cue, at, at + 90 * DAY);
}
beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(mockDb.current); });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const find = () => (compileDiagnosticReport() as { items: Array<{ code: string; detail: string; title: string }> }).items.find((i) => i.code === 'LESSONS_FROM_ROUGH_TASKS');

describe('Healer: lessons from rough tasks', () => {
  it('lists this week\'s lessons with the component to change', () => {
    lesson('l1', 'a refusal that confused the agent', 1);
    const item = find()!;
    expect(item.title).toMatch(/1 lesson/);
    expect(item.detail).toContain('[door_text] When: a refusal that confused the agent');
  });
  it('a lesson last written weeks ago is not this week\'s', () => {
    lesson('l2', 'old cue', 20);
    expect(find()).toBeUndefined();
  });
  it('nothing recorded, nothing listed', () => {
    expect(find()).toBeUndefined();
  });
});
