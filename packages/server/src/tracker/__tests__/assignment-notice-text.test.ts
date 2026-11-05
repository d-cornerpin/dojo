// v3.5 text wave — the assignment notice states the facts and leaves continuing as the default
// (done-is-measured Part C1; plan-before-project Part C1). No variant pre-fills a close for an
// agent that has not started, and none says "When finished".
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-notice-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => {} }) }));

import { runMigrations } from '../../db/migrations.js';
import { injectTaskAssignmentNotification } from '../notify.js';
import { createTask, createProject } from '../schema.js';

const WORKER = 'agent-worker';
const CREATOR = 'agent-creator';
const ORIGIN = { kind: null, sourceMessageId: null, turn: null, convKey: null };
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare(`INSERT INTO providers (id, name, type, base_url, auth_type, is_validated, created_at, updated_at)
    VALUES ('local','Local','openai-compatible','http://127.0.0.1:1/v1','none',1,datetime('now'),datetime('now'))`).run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, max_output_tokens, is_enabled, created_at, updated_at)
    VALUES ('m1','local','M','m','["text"]',8192,1024,1,datetime('now'),datetime('now'))`).run();
  for (const id of [WORKER, CREATOR]) {
    db().prepare(`INSERT INTO agents (id, name, model_id, status, config, spawn_depth, created_by, created_at, updated_at)
      VALUES (?, 'A', 'm1', 'idle', '{}', 1, 'owner', datetime('now'), datetime('now'))`).run(id);
  }
});

const notice = (taskId: string, title = 'Sort the inbox', projectId: string | null = null): string => {
  const r = injectTaskAssignmentNotification({ assignedAgentId: WORKER, creatorAgentId: CREATOR, taskId, title, description: 'Do the thing', projectId, priority: null });
  expect(r.ok).toBe(true);
  return r.content!;
};

describe('the assignment notice', () => {
  it('an unmeasured task: work it through, with how to set a measure; close only when done', () => {
    const id = createTask({ title: 'Sort the inbox', assignedTo: WORKER, createdBy: CREATOR, origin: ORIGIN });
    const text = notice(id);
    expect(text).toContain('Work it through. If it covers a set of mailbox messages, set its measure');
    expect(text).toContain(`work_update(action="edit", task_id="${id}", measure=`);
    // Field fix 3 test-2 round: facts, never close-coaching.
    expect(text).toContain('It is done when its work is done, and the PM validates its close. If you cannot proceed, status="blocked" with the reason.');
    expect(text).not.toMatch(/Close it with/);
    expect(text).not.toMatch(/When finished|Begin working/);
  });

  it('a measured task states its count and the continuation, before the close line', () => {
    const id = createTask({ title: 'Sort the inbox', assignedTo: WORKER, createdBy: CREATOR, origin: ORIGIN });
    db().prepare('UPDATE work SET measure_json = ?, measure_initial = 40, measure_remaining = 37, measure_at = 1 WHERE id = ?')
      .run(JSON.stringify({ tool: 'gmail_search', args: { query: 'in:inbox -label:Sorted' }, unit: 'messages' }), id);
    const text = notice(id);
    expect(text).toContain('This task is measured: gmail_search "in:inbox -label:Sorted" returns 37 messages now. It is done when that reads 0;');
    expect(text).toContain('the engine continues you on the next turn');
    expect(text.indexOf('This task is measured')).toBeLessThan(text.indexOf('It is done when its work is done'));
    expect(text).not.toMatch(/When finished|Begin working/);
  });

  it('a measured task whose first reading failed says so instead of a number', () => {
    const id = createTask({ title: 'Sort the inbox', assignedTo: WORKER, createdBy: CREATOR, origin: ORIGIN });
    db().prepare('UPDATE work SET measure_json = ? WHERE id = ?')
      .run(JSON.stringify({ tool: 'gmail_search', args: { query: 'in:inbox' }, unit: 'messages' }), id);
    expect(notice(id)).toContain('gmail_search "in:inbox" could not be read yet.');
  });

  it('a task on a planned project carries its plan step after the instructions', () => {
    const plan = { approach: 'Count, then label in pages.', steps: [
      { title: 'Count', how: 'gmail_search, read the total', done: 'the count is noted' },
      { title: 'Label in pages', how: 'gmail_label with message_ids per batch', done: 'the search returns 0' },
    ] };
    const { projectId, taskIds } = createProject({ title: 'Inbox', level: 2, createdBy: CREATOR, origin: ORIGIN, plan,
      tasks: [{ title: 'Count', stepNumber: 1, assignedTo: WORKER }, { title: 'Label in pages', stepNumber: 2, assignedTo: WORKER }] });
    const text = notice(taskIds[1], 'Label in pages', projectId);
    expect(text).toContain('Instructions:\nDo the thing\nPlan step 2 of 2 — Label in pages: gmail_label with message_ids per batch (done when: the search returns 0)');
  });
});
