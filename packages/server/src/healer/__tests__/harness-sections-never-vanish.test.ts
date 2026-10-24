// K34/K36/K37 — the three Healer sections are not dropped whole by a literal char cap: a long
// list stays complete (the Healer's own context budget is the one discipline, and it elides loudly),
// the three sections do not compete for one budget, and each says where the full data lives.

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
beforeEach(() => { mockDb.current = new Database(':memory:'); runMigrations(mockDb.current); });
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('the harness sections stay whole', () => {
  it('forty recurring errors are all listed, and the lessons and cost sections are still there', () => {
    for (let i = 0; i < 40; i++) {
      const text = `Error: distinct failure kind ${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${'abcdefghijklmnopqrstuvwxyz'[Math.floor(i / 26)]} happened while doing something fairly long-winded to make the line long`;
      noteToolError('agent-a', `tool_${i}`, text);
      noteToolError('agent-b', `tool_${i}`, text);
    }
    mockDb.current!.prepare("INSERT INTO agents (id, name, status, config) VALUES ('a1', 'Worker', 'idle', '{}')").run();
    recordPromptSections('a1', 'x'.repeat(400), ['sys.a']);
    const at = Date.now() - DAY;
    mockDb.current!.prepare(
      `INSERT INTO lessons (id, agent_id, task_id, cue, lesson, evidence_event_ids, confidence, component, created_at, expires_at)
       VALUES ('l1', 'a', 't', 'a cue', 'a lesson', '[1]', 0.6, 'soul', ?, ?)`,
    ).run(at, at + 90 * DAY);

    const items = (compileDiagnosticReport() as { items: Array<{ code: string; detail: string; title: string }> }).items;
    const errors = items.find((i) => i.code === 'RECURRING_TOOL_ERRORS')!;
    expect(errors.title).toMatch(/^40 /);
    expect(errors.detail.split('\n').filter((l) => l.startsWith('- ')).length).toBe(40);
    expect(errors.detail).toContain('tool_error_signatures');
    expect(items.find((i) => i.code === 'PROMPT_COST')!.detail).toContain('/prompt-cost');
    expect(items.find((i) => i.code === 'LESSONS_FROM_ROUGH_TASKS')!.detail).toContain('lessons table');
  });
});
