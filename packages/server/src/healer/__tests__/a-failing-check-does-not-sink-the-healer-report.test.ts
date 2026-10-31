// One failing Healer check must not sink the whole report: it becomes one visible warning
// (COLLECTOR_FAILED, no table names or stack in it) and every other check still reports.

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
import { noteToolError } from '../../agent/v2/tool-error-ledger.js';
import { recordPromptSections } from '../../memory/prompt-sections.js';


const DAY = 24 * 60 * 60 * 1000;
type Item = { code: string; severity: string; title: string; detail: string };
const compile = (): Item[] => (compileDiagnosticReport() as { items: Item[] }).items;
beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(mockDb.current); });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

function seedLessonAndPromptCost(): void {
  mockDb.current!.prepare("INSERT INTO agents (id, name, status, config) VALUES ('a1', 'Worker', 'idle', '{}')").run();
  recordPromptSections('a1', 'x'.repeat(400), ['sys.a']);
  const at = Date.now() - DAY;
  mockDb.current!.prepare(
    `INSERT INTO lessons (id, agent_id, task_id, cue, lesson, evidence_event_ids, confidence, component, created_at, expires_at)
     VALUES ('l1', 'a', 't', 'a cue', 'a lesson', '[1]', 0.6, 'soul', ?, ?)`,
  ).run(at, at + 90 * DAY);
}

describe('a failing check does not sink the Healer report', () => {
  it('a healthy database has no COLLECTOR_FAILED item', () => {
    expect(compile().some((i) => i.code === 'COLLECTOR_FAILED')).toBe(false);
  });

  it('a missing recurring-errors table gives one warning and the other sections still report', () => {
    mockDb.current!.exec('DROP TABLE tool_error_signatures');
    seedLessonAndPromptCost();
    const items = compile();
    expect(items.some((i) => i.code === 'LESSONS_FROM_ROUGH_TASKS')).toBe(true);
    expect(items.some((i) => i.code === 'PROMPT_COST')).toBe(true);
    const failed = items.filter((i) => i.code === 'COLLECTOR_FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0].severity).toBe('warning');
    expect(failed[0].title.toLowerCase()).toContain('recurring tool errors');
    expect(failed[0].detail).not.toContain('tool_error_signatures');
  });

  it('a missing audit_log table does not throw, and each failed check is named once', () => {
    mockDb.current!.exec('ALTER TABLE audit_log RENAME TO audit_log_x');
    const failed = compile().filter((i) => i.code === 'COLLECTOR_FAILED');
    expect(failed.length).toBeGreaterThan(0);
    const titles = failed.map((i) => i.title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const f of failed) expect(f.detail).not.toContain('audit_log');
  });
});
